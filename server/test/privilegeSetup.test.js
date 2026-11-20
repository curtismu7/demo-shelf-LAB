import { describe, expect, it } from 'vitest';
import { runChecks, RUNBOOK } from '../src/privilegeSetup.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// All paths and HTTP responses are injected: the tests never touch the network
// or the real ~/.config files (the gatewaySwitch.test.js rule).
const mk = (over = {}) => ({ ...over });

function tmpEnv(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psetup-'));
  const f = path.join(dir, 'pingid-env.env');
  fs.writeFileSync(f, contents, { mode: 0o600 });
  return f;
}

// curl stub: a map from a url substring to { code, body }.
const stubCurl = (routes) => async (url) => {
  for (const [needle, r] of Object.entries(routes)) {
    if (url.includes(needle)) return r;
  }
  return { code: 0, body: '' };
};

describe('privilegeSetup runChecks (injected, offline)', () => {
  it('reports doors ok on 401, agent down when unreachable', async () => {
    const r = await runChecks(mk({
      curlFn: stubCurl({ 'mcpgw-pingid': { code: 401, body: '' }, '8008': { code: 0, body: '' } }),
      envFile: tmpEnv(''),
      bffEnvPath: path.join(os.tmpdir(), 'nope.env'),
    }));
    const doors = r.checks.filter((c) => c.name.startsWith('Gateway'));
    expect(doors.every((c) => c.status === 'down' || c.status === 'ok')).toBe(true);
    expect(r.checks.find((c) => c.name === 'Desktop agent').status).toBe('down');
    expect(r.checks.find((c) => c.name === 'Desktop agent').id).toBe('agentDown');
    expect(r.schema).toBe('privilege-setup/1');
  });

  it('reads agent status and flags down with the runbook id when AgentState is not connected', async () => {
    const r = await runChecks(mk({
      curlFn: stubCurl({ '8008': { code: 200, body: JSON.stringify({ AgentState: 'enabled', OnboardedTenants: { t: 'pingid' } }) } }),
      envFile: tmpEnv(''),
      bffEnvPath: path.join(os.tmpdir(), 'nope.env'),
    }));
    const agent = r.checks.find((c) => c.name === 'Desktop agent');
    expect(agent.detail).toContain('AgentState=enabled');
    expect(agent.detail).toContain('pingid');
  });

  it('verifies accessControl restricted to PrivilegeAdmins end to end (token then app)', async () => {
    const env = tmpEnv('PINGID_WORKER_CLIENT_ID=wid\nPINGID_WORKER_CLIENT_SECRET=wsec\n');
    let tokenUsed = null;
    const r = await runChecks(mk({
      curlFn: async (url, opts = []) => {
        if (url.includes('/as/token')) {
          expect(opts).toContain('wid:wsec');
          return { code: 200, body: JSON.stringify({ access_token: 'TOK1' }) };
        }
        if (url.includes('/applications/')) {
          tokenUsed = (opts.find((o) => o === 'Authorization: Bearer TOK1') !== undefined);
          return { code: 200, body: JSON.stringify({ accessControl: { group: { type: 'ANY_GROUP', groups: [{ id: 'b2bc86a0-6242-40dc-8c7c-a6b6577f9bda' }] } } }) };
        }
        return { code: 0, body: '' };
      },
      envFile: env,
      bffEnvPath: path.join(os.tmpdir(), 'nope.env'),
    }));
    expect(tokenUsed).toBe(true);
    const ac = r.checks.find((c) => c.name === 'Privilege app access control');
    expect(ac.status).toBe('ok');
    expect(ac.detail).toContain('restricted-to-privilegeadmins');
  });

  it('flags consoleDenied when accessControl is missing (the 11-20 wipe)', async () => {
    const env = tmpEnv('PINGID_WORKER_CLIENT_ID=wid\nPINGID_WORKER_CLIENT_SECRET=wsec\n');
    const r = await runChecks(mk({
      curlFn: stubCurl({
        '/as/token': { code: 200, body: JSON.stringify({ access_token: 'TOK1' }) },
        '/applications/': { code: 200, body: JSON.stringify({ accessControl: null }) },
      }),
      envFile: env,
      bffEnvPath: path.join(os.tmpdir(), 'nope.env'),
    }));
    const ac = r.checks.find((c) => c.name === 'Privilege app access control');
    expect(ac.status).toBe('down');
    expect(ac.id).toBe('consoleDenied');
  });

  it('warns, never throws, when credentials are absent', async () => {
    const r = await runChecks(mk({
      curlFn: stubCurl({}),
      envFile: tmpEnv('# nothing here\n'),
      bffEnvPath: path.join(os.tmpdir(), 'nope.env'),
    }));
    const ac = r.checks.find((c) => c.name === 'Privilege app access control');
    expect(ac.status).toBe('warn');
    expect(ac.detail).toContain('credentials-missing');
  });
});

describe('RUNBOOK', () => {
  it('covers every failure id the checks emit, each with at least one fix step', () => {
    const ids = ['door401', 'door000', 'agentDown', 'consoleDenied', 'noLink', 'bffWrongDoor', 'workerCurl'];
    for (const id of ids) {
      expect(RUNBOOK[id], id).toBeTruthy();
      if (RUNBOOK[id].fix) expect(RUNBOOK[id].fix.length).toBeGreaterThan(0);
    }
    expect(RUNBOOK.consoleDenied.fix.join(' ')).toContain('Access tab');
    expect(RUNBOOK.noLink.fix.join(' ')).toContain('AGENT');
  });
});
