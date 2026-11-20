import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseProfiles, switchable, profileOfCurrent, currentTarget, switchTo } from '../src/gatewaySwitch.js';

const PROFILES = `
# comment
[local]
BFF_PRIVILEGE_MCPGW_URL=https://gw1.example/mcp
BFF_MCP_PRIVILEGE_GATEWAY_URL=https://gw1.example/agent/mcp
CLAUDE_OPENSEARCH_HITL=https://gw1.example/mcp
AGENT_ANTHROPIC_BASE_URL=https://gw1.example/llm/anthropic
AGENT_WORKER_TRACE_URL=https://gw1.example/trace
AGENT_WORKER_A2A_URL=https://gw1.example/a2a

[haproxy]
BFF_PRIVILEGE_MCPGW_URL=https://lb.example/opensearch/mcp/
BFF_MCP_PRIVILEGE_GATEWAY_URL=https://lb.example/agent-gateway/mcp/
CLAUDE_OPENSEARCH_HITL=https://lb.example/opensearch-mcp-server/mcp/

[broken]
BFF_PRIVILEGE_MCPGW_URL=https://gw2.example/mcp
`;
const envWith = (kv) => Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';

function tmpHome() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gwswitch-'));
  const prof = path.join(dir, 'profiles.env');
  writeFileSync(prof, PROFILES);
  const bff = path.join(dir, 'bff.env');
  const a2a = path.join(dir, 'a2a.env');
  writeFileSync(bff, envWith({ PRIVILEGE_MCPGW_URL: 'https://lb.example/opensearch/mcp/', PRIVILEGE_AGENTLESS_MCPGW_URL: 'https://lb.example/opensearch/mcp/', MCP_PRIVILEGE_GATEWAY_URL: 'https://lb.example/agent-gateway/mcp/', OTHER_KEY: 'keep' }));
  writeFileSync(a2a, envWith({ ANTHROPIC_BASE_URL: 'https://old.example/llm/anthropic', WORKER_TRACE_URL: 'https://old.example/trace' }));
  return { dir, prof, bff, a2a };
}

describe('parseProfiles', () => {
  it('reads sections, skips comments and blanks, trims values', () => {
    const p = parseProfiles(PROFILES);
    expect(Object.keys(p).sort()).toEqual(['broken', 'haproxy', 'local']);
    expect(p.local.BFF_PRIVILEGE_MCPGW_URL).toBe('https://gw1.example/mcp');
    expect(p.haproxy.AGENT_ANTHROPIC_BASE_URL).toBeUndefined();
  });
  it('no section header: keys are dropped', () => {
    expect(parseProfiles('A=1\n[x]\nB=2')).toEqual({ x: { B: '2' } });
  });
});

describe('switchable / profileOfCurrent / currentTarget', () => {
  it('needs the BFF + Claude keys', () => {
    const p = parseProfiles(PROFILES);
    expect(switchable(p.local)).toBe(true);
    expect(switchable(p.haproxy)).toBe(true);
    expect(switchable(p.broken)).toBe(false);
  });
  it('matches the current BFF URL to its profile', () => {
    const { bff } = tmpHome();
    const p = parseProfiles(PROFILES);
    expect(currentTarget(bff)).toBe('https://lb.example/opensearch/mcp/');
    expect(profileOfCurrent(p, bff)).toBe('haproxy');
  });
  it('unknown current URL: null', () => {
    const { dir, bff } = tmpHome();
    writeFileSync(bff, envWith({ PRIVILEGE_MCPGW_URL: 'https://elsewhere.example/mcp' }));
    expect(profileOfCurrent(parseProfiles(PROFILES), bff)).toBeNull();
    expect(currentTarget(path.join(dir, 'missing.env'))).toBeNull();
  });
});

describe('switchTo with injected paths (never the real files)', () => {
  it('writes BFF, agent and Claude envs from the profile, keeps other keys, backs up, recreates services', async () => {
    const { prof, bff, a2a, dir } = tmpHome();
    const claude = path.join(dir, 'claude.json');
    writeFileSync(claude, JSON.stringify({ projects: { '/proj': { mcpServers: { 'opensearch-hitl': { type: 'http', url: 'https://old.example/mcp' } } } } }));
    const calls = [];
    const exec = vi.fn(async (f, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'context') return { stdout: 'orbstack', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const r = await switchTo('local', { profilesPath: prof, bffEnvPath: bff, a2aEnvPath: a2a, claudeJson: claude, claudeProject: '/proj', a2aComposeDir: dir, exec });
    expect(r).toMatchObject({ ok: true, profile: 'local', bff: 'written', agents: 'written', claude: 'written', recreate: 'ok' });
    const b = readFileSync(bff, 'utf8');
    expect(b).toContain('PRIVILEGE_MCPGW_URL=https://gw1.example/mcp');
    expect(b).toContain('PRIVILEGE_AGENTLESS_MCPGW_URL=https://gw1.example/mcp');
    expect(b).toContain('MCP_PRIVILEGE_GATEWAY_URL=https://gw1.example/agent/mcp');
    expect(b).toContain('OTHER_KEY=keep');
    const a = readFileSync(a2a, 'utf8');
    expect(a).toContain('ANTHROPIC_BASE_URL=https://gw1.example/llm/anthropic');
    expect(a).toContain('WORKER_TRACE_URL=https://gw1.example/trace');
    expect(a).toContain('WORKER_A2A_URL=https://gw1.example/a2a');
    expect(JSON.parse(readFileSync(claude, 'utf8')).projects['/proj'].mcpServers['opensearch-hitl'].url).toBe('https://gw1.example/mcp');
    expect(readFileSync(`${bff}.bak-gwswitch`, 'utf8')).toContain('https://lb.example/opensearch/mcp/');
    expect(calls.some((c) => c.includes('compose') && c.includes('--force-recreate') && c.includes('worker'))).toBe(true);
  });

  it('profile without agent keys: agent write skipped', async () => {
    const { prof, bff, a2a, dir } = tmpHome();
    const claude = path.join(dir, 'claude.json');
    writeFileSync(claude, JSON.stringify({ projects: { '/proj': { mcpServers: { 'opensearch-hitl': { url: 'https://old.example/mcp' } } } } }));
    const r = await switchTo('haproxy', { profilesPath: prof, bffEnvPath: bff, a2aEnvPath: a2a, claudeJson: claude, claudeProject: '/proj', a2aComposeDir: dir, exec: vi.fn(async () => ({ stdout: '', stderr: '' })) });
    expect(r.agents).toBe('skipped');
    expect(r.claude).toBe('written');
  });

  it('non-orbstack docker context: agents written but recreate refused, ok false', async () => {
    const { prof, bff, a2a, dir } = tmpHome();
    const claude = path.join(dir, 'claude.json');
    writeFileSync(claude, JSON.stringify({ projects: { '/proj': { mcpServers: { 'opensearch-hitl': { url: 'x' } } } } }));
    const r = await switchTo('local', { profilesPath: prof, bffEnvPath: bff, a2aEnvPath: a2a, claudeJson: claude, claudeProject: '/proj', a2aComposeDir: dir, exec: vi.fn(async (f, args) => (args[0] === 'context' ? { stdout: 'default', stderr: '' } : { stdout: '', stderr: '' })) });
    expect(r.recreate).toBe('docker-context-not-orbstack');
    expect(r.ok).toBe(false);
  });

  it('claude.json without the project: claude skipped, not an error', async () => {
    const { prof, bff, a2a, dir } = tmpHome();
    const claude = path.join(dir, 'claude.json');
    writeFileSync(claude, JSON.stringify({ projects: {} }));
    const r = await switchTo('local', { profilesPath: prof, bffEnvPath: bff, a2aEnvPath: a2a, claudeJson: claude, claudeProject: '/absent', a2aComposeDir: dir, exec: vi.fn(async (f, args) => ({ stdout: args[0] === 'context' ? 'orbstack' : '', stderr: '' })) });
    expect(r.claude).toBe("skipped");
    expect(r.ok).toBe(true);
  });

  it('missing profiles file: refused', async () => {
    expect(await switchTo('local', { profilesPath: '/nonexistent/x.env' })).toEqual({ ok: false, error: 'no-profiles-file' });
  });
  it('unknown profile: refused', async () => {
    const { prof } = tmpHome();
    expect(await switchTo('nope', { profilesPath: prof })).toEqual({ ok: false, error: 'unknown-profile' });
  });
  it('profile missing the required keys: refused', async () => {
    const { prof } = tmpHome();
    expect(await switchTo('broken', { profilesPath: prof })).toEqual({ ok: false, error: 'unknown-profile' });
  });
});
