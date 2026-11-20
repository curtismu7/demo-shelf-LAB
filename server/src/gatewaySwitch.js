// Gateway target switch (owner tool, 2026-11-20): points the AI-DEMO2 BFF, the
// a2a lab agents and the Claude Code MCP entry at a chosen PingOne Privilege
// gateway. The profiles live in ~/.config/demo-kit/gateway-target.env (a small
// INI written by the gw-switch work); this module reads it, never invents URLs.
//
// Security model, mirroring control.js: nothing in the request names a path,
// a file or a command. The only client input is the profile name, matched
// against the parsed INI sections; the key names written are a fixed list in
// this file. execFile only, loopback caller only, same-origin only. Host-run
// only (the container has no access to ~/.config or the BFF checkout).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROFILES_PATH = path.join(os.homedir(), '.config/demo-kit/gateway-target.env');
const BFF_ENV = path.join(os.homedir(), 'Development/AI-DEMO2/demo_api_server/.env');
const A2A_ENV = path.join(os.homedir(), 'Development/AI-DEMO-Standalone/standalone/privilege-a2a-anthropic-demo-LAB/.env');
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
const CLAUDE_PROJECT = path.join(os.homedir(), 'Development/AI-DEMO2');

// The keys this feature may write, and the profile key each comes from. Nothing else is touched.
const BFF_KEYS = [
  ['PRIVILEGE_MCPGW_URL', 'BFF_PRIVILEGE_MCPGW_URL'],
  ['PRIVILEGE_AGENTLESS_MCPGW_URL', 'BFF_PRIVILEGE_MCPGW_URL'],
  ['MCP_PRIVILEGE_GATEWAY_URL', 'BFF_MCP_PRIVILEGE_GATEWAY_URL'],
];
const A2A_KEYS = [
  ['ANTHROPIC_BASE_URL', 'AGENT_ANTHROPIC_BASE_URL'],
  ['WORKER_TRACE_URL', 'AGENT_WORKER_TRACE_URL'],
  ['WORKER_A2A_URL', 'AGENT_WORKER_A2A_URL'],
];
// The Claude Code entry rewritten: a fixed project + server name, url only.
const CLAUDE_ENTRY = 'opensearch-hitl';

const BFF_COMPOSE_DIR = path.join(os.homedir(), 'Development/AI-DEMO2');
export const A2A_COMPOSE_DIR = path.join(os.homedir(), 'Development/AI-DEMO-Standalone/standalone/privilege-a2a-anthropic-demo-LAB');

// INI parse: [section] headers and key=value lines. Comments (#) and blanks skipped.
// Only first-seen keys win, and every value is trimmed. No interpolation, no quotes handling —
// the file is ours; anything unexpected simply yields fewer usable profiles.
export function parseProfiles(text) {
  const out = {};
  let sec = null;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^\[([a-z0-9_-]+)\]$/.exec(line);
    if (m) { sec = m[1]; out[sec] = out[sec] || {}; continue; }
    const kv = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (kv && sec) out[sec][kv[1]] = kv[2].trim();
  }
  return out;
}

// A profile is switchable when it carries the BFF and Claude keys. Agent keys may be
// absent (a gateway that fronts no LLM door) — those writes are then skipped.
export function switchable(p) {
  return Boolean(p && p.BFF_PRIVILEGE_MCPGW_URL && p.CLAUDE_OPENSEARCH_HITL);
}

const setValue = (text, key, value) => {
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, `${key}=${value}`);
  return `${text.replace(/\s*$/, '\n')}${key}=${value}\n`;
};

// Read the current URL the BFF points at (null when the file or key is missing).
export function currentTarget(bffEnvPath = BFF_ENV) {
  try {
    const m = /^PRIVILEGE_MCPGW_URL=(.*)$/m.exec(fs.readFileSync(bffEnvPath, 'utf8'));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

// Which profile (if any) the current BFF URL belongs to. Matched against the
// profile's own BFF_PRIVILEGE_MCPGW_URL value, exact string.
export function profileOfCurrent(profiles, bffEnvPath = BFF_ENV) {
  const cur = currentTarget(bffEnvPath);
  if (!cur) return null;
  for (const [name, p] of Object.entries(profiles)) {
    if (switchable(p) && p.BFF_PRIVILEGE_MCPGW_URL === cur) return name;
  }
  return null;
}

// Write one env file with a backup beside it (mode-600 not needed: the BFF .env
// already holds secrets and keeps its own mode; we preserve the existing file's).
function writeEnv(file, keys, profile) {
  const original = fs.readFileSync(file, 'utf8');
  let t = original;
  for (const [envKey, profileKey] of keys) {
    const v = profile[profileKey];
    if (v) t = setValue(t, envKey, v);
  }
  if (t !== original) {
    fs.writeFileSync(`${file}.bak-gwswitch`, original);
    fs.writeFileSync(file, t);
  }
  return t !== original;
}

function writeClaudeAt(claudeJson, claudeProject, url) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(claudeJson, 'utf8')); } catch { return 'skipped'; }
  const servers = doc?.projects?.[claudeProject]?.mcpServers;
  if (!servers || !servers[CLAUDE_ENTRY]) return 'skipped'; // project or entry absent on this machine: nothing to rewrite
  const entry = servers[CLAUDE_ENTRY];
  const before = entry.url;
  entry.type = 'http';
  entry.url = url;
  if (entry.url !== before) fs.writeFileSync(claudeJson, `${JSON.stringify(doc, null, 2)}\n`);
  return entry.url !== before ? 'written' : 'unchanged';
}

// Recreate the two compose services so their env actually changes. Same guards as runCompose:
// orbstack context first, execFile only, fixed service names.
async function recreateServices(exec, dir, services) {
  let ctx = '';
  try { ctx = (await exec('docker', ['context', 'show'])).stdout.trim(); } catch { return 'docker-unavailable'; }
  if (ctx !== 'orbstack') return 'docker-context-not-orbstack';
  try {
    await exec('docker', ['compose', 'up', '-d', '--force-recreate', ...services], { cwd: dir, timeoutMs: 120_000 });
    return 'ok';
  } catch (e) {
    return `recreate-failed:${String(e.stderr || e.message || '').slice(0, 200)}`;
  }
}

// The switch itself. Returns a plain result object: enum codes only, plus the
// per-file outcomes. Never returns URLs it did not read from the profile file.
// All paths injectable so tests never touch the real files. Defaults are the real ones.
export async function switchTo(profileName, { profilesPath = PROFILES_PATH, bffEnvPath = BFF_ENV, a2aEnvPath = A2A_ENV, claudeJson = CLAUDE_JSON, claudeProject = CLAUDE_PROJECT, a2aComposeDir = A2A_COMPOSE_DIR, exec } = {}) {
  let text;
  try { text = fs.readFileSync(profilesPath, 'utf8'); } catch { return { ok: false, error: 'no-profiles-file' }; }
  const profiles = parseProfiles(text);
  const profile = profiles[profileName];
  if (!switchable(profile)) return { ok: false, error: 'unknown-profile' };

  const results = { ok: true, profile: profileName, bff: 'skipped', agents: 'skipped', claude: 'skipped' };
  try {
    results.bff = writeEnv(bffEnvPath, BFF_KEYS, profile) ? 'written' : 'unchanged';
  } catch { results.bff = 'write-failed'; results.ok = false; }
  try {
    results.claude = writeClaudeAt(claudeJson, claudeProject, profile.CLAUDE_OPENSEARCH_HITL);
  } catch { results.claude = 'write-failed'; results.ok = false; }

  if (profile.AGENT_ANTHROPIC_BASE_URL) {
    try {
      results.agents = writeEnv(a2aEnvPath, A2A_KEYS, profile) ? 'written' : 'unchanged';
      if (results.agents === 'written') {
        results.recreate = await recreateServices(exec, a2aComposeDir, ['worker', 'main']);
        if (results.recreate !== 'ok') results.ok = false;
      }
    } catch { results.agents = 'write-failed'; results.ok = false; }
  }
  return results;
}
