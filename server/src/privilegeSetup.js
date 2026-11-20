// Privilege/PingID setup + debug (owner tool, 2026-11-20): one page that checks
// the live pieces of the PingID cutover and shows the fix for each failure.
// Checks are read-only: gateway doors (public HTTPS), the desktop agent status
// (loopback 8008), the BFF target env, and the PingOne app accessControl via the
// worker credentials in ~/.config/demo-kit/pingid-env.env (never returned).
//
// Security model, mirroring gatewaySwitch.js: no client input reaches a path,
// file or command; execFile only; loopback caller only; same-origin only.
// Secrets stay in ~/.config (mode 600) and are never echoed back.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const PINGID_ENV = path.join(os.homedir(), '.config/demo-kit/pingid-env.env');
const BFF_ENV = path.join(os.homedir(), 'Development/AI-DEMO2/demo_api_server/.env');
const AGENT_STATUS = 'http://127.0.0.1:8008/status';

// The three k8s door URLs checked from the host. Hosts and paths fixed here,
// never taken from the request.
const DOORS = [
  { name: 'pingid', url: 'https://mcpgw-pingid.ai-demo.ping-devops.com/opensearch/mcp/' },
  { name: 'pingid2', url: 'https://mcpgw-pingid2.ai-demo.ping-devops.com/opensearch/mcp/' },
  { name: 'pingid3', url: 'https://mcpgw-pingid3.ai-demo.ping-devops.com/opensearch/mcp/' },
];

// The one PingOne application whose accessControl was wiped once (11-20) and
// whose loss broke console access for every user.
const APP_ID = '33bb98ce-c805-43fa-9b01-1a7dc746ce53';
const ENV_ID = '4cb38c18-691a-4201-a99d-b4b8842ca786';
const GROUP_ID = 'b2bc86a0-6242-40dc-8c7c-a6b6577f9bda';

// Runbook content: symptom -> cause -> fix, distilled from the 2026-11-20 work
// (ACTIVE-CONFIG + PRIVILEGE-CONSOLE-ACCESS-RUNBOOK + the handoffs). Keys are
// the check ids below; the page renders check + fix side by side.
export const RUNBOOK = {
  door401: {
    title: 'Gateway door answers 401 (good)',
    okText: 'An OAuth 401 challenge means the node is up and serving MCP.',
    fix: null,
  },
  door000: {
    title: 'Gateway door unreachable',
    fix: [
      'Check the ingress backend-protocol: a 400 "Client sent an HTTP request to an HTTPS server" means the ingress says HTTP against an HTTPS pod —',
      'helm upgrade <release> … --server-side=true --force-conflicts --set oidc.serverUrl=https://<the-node-own-host>',
      'The chart derives backend-protocol from oidc.serverUrl matching the release hostname. A mismatch serves plain HTTP on 8623.',
    ],
  },
  agentDown: {
    title: 'Desktop agent not connected',
    fix: [
      'Agent status must read AgentState=connected with proxy and controller READY (curl 127.0.0.1:8008/status).',
      '"Device … not found" in /Library/Logs/Procyon/procyon-agent.log = the device registration is gone tenant-side. First wait 30 min (it self-recovered once on 11-17).',
      'Then re-pair: generate the onboarding link FIRST (Privilege console → Users → demouser → Generate Onboarding Link, PRIVATE window), disconnect the agent, open the link, sign in as demouser, approve the PingID push.',
      'Still failing: reinstall — quit the app, move aside ~/Library/Application Support/procyon-agent and the LaunchAgent plist, install ~/Downloads/"Privilege demos/PingOne+Privilege-arm64-latest.pkg" over the top, then a fresh link.',
    ],
  },
  consoleDenied: {
    title: 'Console says "not a member of the designated group"',
    fix: [
      'PingOne admin console (pingid env) → Applications → Applications → PingOne Privilege → Access tab → Restrict access to specific groups → PrivilegeAdmins → save. Retry in a private window.',
      'This restriction was wiped once (11-20). Check below shows the live accessControl value.',
      'If admin features are missing after sign-in, also add the "PingOne Privilege Administrator" role to PrivilegeAdmins in the console (the two Admin roles are already assigned).',
    ],
  },
  noLink: {
    title: 'No "Generate Onboarding Link" on the user page',
    fix: [
      'The link only appears when the tenant product mode is AGENT, not AGENTLESS.',
      'The 11-17 fix flipped it via the local agent API (PUT tenantprofiles tag). With the agent down, look for the product mode / BOM toggle in the Privilege console Settings.',
      'Never PUT the tenant profile or the Privilege application from a partial object — GET the full object, change one field, PUT it all back (a partial PUT is the suspected cause of both 11-20 wipes).',
    ],
  },
  bffWrongDoor: {
    title: 'BFF points at the wrong gateway',
    fix: [
      'The shelf header Gateway-target buttons rewrite the BFF .env, the a2a lab .env and the Claude Code entry. After switching run:',
      'cd ~/Development/AI-DEMO2 && docker compose up -d demo-api-server  (up -d, never restart — compose caches env_file)',
      'Then a fresh sign-in in the banking UI; tokens do not carry across gateways.',
    ],
  },
  workerCurl: {
    title: 'Console API unreachable from scripts (curl 000)',
    fix: [
      'local.procyon.ai:8643 is served by the desktop agent; when the agent is wedged the API is down with it. Fix the agent first.',
      'Header for API calls: x-procyon-session-id: <any uuid>. Pace writes (a fast burst dropped the tunnel twice).',
    ],
  },
};

function readPingidEnv(file = PINGID_ENV) {
  const out = {};
  try {
    for (const ln of fs.readFileSync(file, 'utf8').split('\n')) {
      const t = ln.trim();
      if (t && !t.startsWith('#') && t.includes('=')) {
        const i = t.indexOf('=');
        out[t.slice(0, i)] = t.slice(i + 1);
      }
    }
  } catch { /* absent: the pingone check reports no-credentials */ }
  return out;
}

function curlJson(url, opts = [], timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile('curl', ['-sk', '-m', String(Math.ceil(timeoutMs / 1000)), '-o', '-', '-w', '\n__HTTP__%{http_code}', ...opts, url],
      { timeout: timeoutMs + 2000 }, (err, stdout) => {
        if (err && !stdout) return resolve({ code: 0, body: '' });
        const i = String(stdout).lastIndexOf('\n__HTTP__');
        resolve({ code: Number(String(stdout).slice(i + 9).trim() || 0), body: i > -1 ? String(stdout).slice(0, i) : '' });
      });
  });
}

// One check pass: every probe is read-only. Never throws; every entry carries a status.
export async function runChecks({ curlFn = curlJson, envFile = PINGID_ENV, bffEnvPath = BFF_ENV } = {}) {
  const checks = [];

  // 1. Gateway doors (public URLs, host curl, -k like every owner probe).
  for (const d of DOORS) {
    const { code } = await curlFn(d.url);
    checks.push({
      id: code === 401 ? 'door401' : code === 0 ? 'door000' : 'door401',
      name: `Gateway ${d.name}`,
      status: code === 401 ? 'ok' : code === 0 ? 'down' : 'warn',
      detail: `GET ${d.url.replace(/\/opensearch\/mcp\/$/, '/…')} → HTTP ${code || 'no answer'}`,
    });
  }

  // 2. Desktop agent status (loopback).
  const ag = await curlFn(AGENT_STATUS, [], 4000);
  let agentState = 'unreachable';
  let agentTenants = [];
  if (ag.code === 200 && ag.body) {
    try {
      const j = JSON.parse(ag.body);
      agentState = j.AgentState || 'unknown';
      agentTenants = Object.values(j.OnboardedTenants || {});
    } catch { agentState = 'bad-json'; }
  }
  checks.push({
    id: agentState === 'connected' ? 'door401' : 'agentDown',
    name: 'Desktop agent',
    status: agentState === 'connected' ? 'ok' : 'down',
    detail: `AgentState=${agentState}${agentTenants.length ? ` · tenant: ${agentTenants.join(', ')}` : ''}`,
  });

  // 3. BFF target (read the env file, compare with the k8s primary).
  let bff = 'unknown';
  try {
    const m = /^PRIVILEGE_MCPGW_URL=(.*)$/m.exec(fs.readFileSync(bffEnvPath, 'utf8'));
    bff = m ? m[1].trim() : 'unset';
  } catch { bff = 'file-missing'; }
  checks.push({
    id: 'bffWrongDoor',
    name: 'BFF gateway target',
    status: bff.includes('mcpgw-pingid.ai-demo') ? 'ok' : bff === 'unknown' || bff === 'file-missing' ? 'warn' : 'warn',
    detail: `PRIVILEGE_MCPGW_URL=${bff}`,
  });

  // 4. PingOne app accessControl (worker credentials, token never echoed).
  const env = readPingidEnv(envFile);
  let ac = 'credentials-missing';
  if (env.PINGID_WORKER_CLIENT_ID && env.PINGID_WORKER_CLIENT_SECRET) {
    const tok = await curlFn(`https://auth.pingone.com/${ENV_ID}/as/token`, [
      '-X', 'POST', '-u', `${env.PINGID_WORKER_CLIENT_ID}:${env.PINGID_WORKER_CLIENT_SECRET}`,
      '-d', 'grant_type=client_credentials',
    ], 8000);
    if (tok.code === 200 && tok.body) {
      try {
        const at = JSON.parse(tok.body).access_token;
        const app = await curlFn(`https://api.pingone.com/v1/environments/${ENV_ID}/applications/${APP_ID}`,
          ['-H', `Authorization: Bearer ${at}`], 8000);
        if (app.code === 200 && app.body) {
          const v = JSON.parse(app.body).accessControl;
          ac = v && v.group && Array.isArray(v.group.groups) && v.group.groups.some((g) => g.id === GROUP_ID)
            ? 'restricted-to-privilegeadmins'
            : 'no-restriction';
        } else { ac = `api-${app.code || 'error'}`; }
      } catch { ac = 'parse-error'; }
    } else { ac = 'token-failed'; }
  }
  checks.push({
    id: ac === 'restricted-to-privilegeadmins' ? 'door401' : 'consoleDenied',
    name: 'Privilege app access control',
    status: ac === 'restricted-to-privilegeadmins' ? 'ok' : ac === 'no-restriction' ? 'down' : 'warn',
    detail: `accessControl=${ac}`,
  });

  return { ok: true, schema: 'privilege-setup/1', at: new Date().toISOString(), checks };
}
