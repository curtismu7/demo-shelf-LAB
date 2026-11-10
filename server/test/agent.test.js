import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createAgent, ensureToken, sameToken } from '../src/agent.js';
import { createLastRunning } from '../src/lastRunning.js';
import { createAgentClient } from '../src/agent-client.js';

const TOKEN = 'a'.repeat(64);
const PORT = 4405;
const demos = [
  { id: 'a', composeFile: '/x/a/docker-compose.yml', composeOverlays: [], where: 'installed', repo: 'https://github.com/curtismu7/a' },
  { id: 'nocompose', composeOverlays: [], where: 'installed' },
];
const okExec = () => vi.fn(async (file, args) => ({ stdout: args[0] === 'context' ? 'orbstack\n' : 'started\n', stderr: '' }));
const mk = (over = {}) => createAgent({ getDemos: () => demos, token: TOKEN, port: PORT, exec: okExec(), fileExists: () => true, ...over });
const call = (app, method, url, { host = `127.0.0.1:${PORT}`, token = TOKEN } = {}) => {
  const r = request(app)[method](url).set('Host', host);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};

describe('start agent', () => {
  it('deploy: clones the registry-validated repo into the demo root, then runs compose start; refuses without a demo root', async () => {
    const exec = vi.fn(async (file, args) => {
      if (file === 'git' && args.includes('rev-parse')) throw Object.assign(new Error('not a repo'), { stdout: '', stderr: '' });
      return { stdout: file === 'docker' && args[0] === 'context' ? 'orbstack\n' : 'ok\n', stderr: '' };
    });
    const r = await call(mk({ exec, demoRoot: '/x' }), 'post', '/v1/demos/a/deploy');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, deploy: 'cloned' });
    expect(exec.mock.calls.some((c) => c[1][0] === 'clone' && String(c[1][1]).endsWith('/a.git'))).toBe(true);
    expect(exec).toHaveBeenLastCalledWith('docker', ['compose', '-f', '/x/a/docker-compose.yml', 'up', '-d'], { cwd: '/x/a', timeoutMs: 600000 });
    const noRoot = await call(mk({ exec, demoRoot: null }), 'post', '/v1/demos/a/deploy');
    expect(noRoot.status).toBe(409);
    expect(noRoot.body.error).toBe('no-demo-root');
  });

  it('starts a registered demo with the token and runs exactly docker compose up -d', async () => {
    const exec = okExec();
    const r = await call(mk({ exec }), 'post', '/v1/demos/a/start');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, id: 'a', action: 'start' });
    expect(exec).toHaveBeenLastCalledWith('docker', ['compose', '-f', '/x/a/docker-compose.yml', 'up', '-d'], { cwd: '/x/a', timeoutMs: 600000 });
  });
  it('stops with down', async () => {
    const exec = okExec();
    await call(mk({ exec }), 'post', '/v1/demos/a/stop');
    expect(exec).toHaveBeenLastCalledWith('docker', ['compose', '-f', '/x/a/docker-compose.yml', 'down'], { cwd: '/x/a', timeoutMs: 60000 });
  });
  it('refuses a missing or wrong token', async () => {
    const exec = okExec();
    const app = mk({ exec });
    expect((await call(app, 'post', '/v1/demos/a/start', { token: null })).status).toBe(401);
    expect((await call(app, 'post', '/v1/demos/a/start', { token: 'b'.repeat(64) })).status).toBe(401);
    expect(exec).not.toHaveBeenCalled();
  });
  it('refuses a Host header that is not loopback or host.docker.internal on the agent port (DNS rebinding)', async () => {
    const exec = okExec();
    const app = mk({ exec });
    for (const host of ['evil.example', `evil.example:${PORT}`, '127.0.0.1:9999', '127.0.0.1']) {
      expect((await call(app, 'post', '/v1/demos/a/start', { host })).status, host).toBe(403);
    }
    expect((await call(app, 'get', '/v1/health', { host: `host.docker.internal:${PORT}` })).status).toBe(200);
    expect(exec).not.toHaveBeenCalled();
  });
  it('acts only on ids in the registry: no path, no command, no other action', async () => {
    const exec = okExec();
    const app = mk({ exec });
    expect((await call(app, 'post', '/v1/demos/zzz/start')).status).toBe(404);
    expect((await call(app, 'post', '/v1/demos/..%2Fetc/start')).status).toBe(404);
    expect((await call(app, 'post', '/v1/demos/a/exec')).status).toBe(404);
    expect((await call(app, 'post', '/v1/demos/nocompose/start')).status).toBe(400);
    expect((await call(app, 'get', '/v1/demos/a/start')).status).toBe(404);
    expect(exec).not.toHaveBeenCalled();
  });
  it('refuses when Docker is not OrbStack, and when the compose file is missing', async () => {
    const other = vi.fn(async () => ({ stdout: 'desktop-linux\n', stderr: '' }));
    expect((await call(mk({ exec: other }), 'post', '/v1/demos/a/start')).body.error).toBe('docker-context-not-orbstack');
    const r = await call(mk({ fileExists: () => false }), 'post', '/v1/demos/a/start');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'compose-file-missing', missing: ['/x/a/docker-compose.yml'] });
  });
  it('reports an invalid registry instead of crashing', async () => {
    const r = await call(mk({ getDemos: () => { throw new Error('bad'); } }), 'post', '/v1/demos/a/start');
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('registry-invalid');
  });
  it('runs one start per demo at a time', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const exec = vi.fn(async (file, args) => { if (args[0] === 'compose') await gate; return { stdout: args[0] === 'context' ? 'orbstack' : 'x', stderr: '' }; });
    const app = mk({ exec });
    const first = call(app, 'post', '/v1/demos/a/start').then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    expect((await call(app, 'post', '/v1/demos/a/start')).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });
});


describe('start agent: further guarantees', () => {
  it('ignores a body or query that names a path, overlay or command: only the registry decides what runs', async () => {
    const exec = okExec();
    const r = await call(mk({ exec }), 'post', '/v1/demos/a/start?composeFile=/etc/x&command=rm')
      .send({ composeFile: '/etc/passwd', composeOverlays: ['/tmp/evil.yml'], command: 'rm -rf /' });
    expect(r.status).toBe(200);
    expect(exec).toHaveBeenLastCalledWith('docker', ['compose', '-f', '/x/a/docker-compose.yml', 'up', '-d'], { cwd: '/x/a', timeoutMs: 600000 });
  });
  it('matches the action case-sensitively: START is not start', async () => {
    const exec = okExec();
    const app = mk({ exec });
    for (const a of ['START', 'Start', 'STOP', 'Stop']) expect((await call(app, 'post', `/v1/demos/a/${a}`)).status, a).toBe(404);
    expect(exec).not.toHaveBeenCalled();
  });
  it('answers 400, not 500, for a malformed percent-escape', async () => {
    const r = await call(mk(), 'post', '/v1/demos/%E0%A4%A/start');
    expect(r.status).toBe(400);
  });
  it('releases the per-demo lock after a failed compose, so the next start works', async () => {
    let fail = true;
    const exec = vi.fn(async (file, args) => {
      if (args[0] === 'compose' && fail) throw Object.assign(new Error('boom'), { stdout: '', stderr: 'nope' });
      return { stdout: args[0] === 'context' ? 'orbstack' : 'ok', stderr: '' };
    });
    const app = mk({ exec });
    expect((await call(app, 'post', '/v1/demos/a/start')).body.error).toBe('compose-failed');
    fail = false;
    expect((await call(app, 'post', '/v1/demos/a/start')).status).toBe(200);
  });
  it('requires the token on /v1/health too', async () => {
    expect((await call(mk(), 'get', '/v1/health', { token: null })).status).toBe(401);
  });
  it('refuses a peer that is not loopback, even with the right token and Host', async () => {
    const server = http.createServer(mk());
    server.on('connection', (sock) => Object.defineProperty(sock, 'remoteAddress', { value: '192.168.215.1' }));
    const r = await call(server, 'get', '/v1/health');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('loopback-only');
  });
});

describe('agent token', () => {
  it('is created once with mode 600 and reused', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-token-'));
    const a = ensureToken(path.join(dir, '.data'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(ensureToken(path.join(dir, '.data'))).toBe(a);
    expect((fs.statSync(path.join(dir, '.data', 'agent-token')).mode & 0o777).toString(8)).toBe('600');
  });
  it('rejects a file too short to be a token', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-token-'));
    fs.writeFileSync(path.join(dir, 'agent-token'), 'short\n');
    expect(() => ensureToken(dir)).toThrow(/usable token/);
  });
  it('compares in constant time and by value', () => {
    expect(sameToken('abc', 'abc')).toBe(true);
    expect(sameToken('abc', 'abd')).toBe(false);
    expect(sameToken('abc', 'abcd')).toBe(false);
  });
});

describe('agent client', () => {
  const json = (status, body) => ({ status, ok: status < 300, json: async () => body });
  it('posts to the agent with the bearer token and returns its answer', async () => {
    const f = vi.fn(async () => json(200, { ok: true }));
    const r = await createAgentClient({ url: 'http://host.docker.internal:4405/', token: TOKEN, fetchFn: f }).run('a b', 'start');
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(f.mock.calls[0][0]).toBe('http://host.docker.internal:4405/v1/demos/a%20b/start');
    expect(f.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
  });
  it('says the agent is not running when it cannot connect', async () => {
    const r = await createAgentClient({ url: 'http://x:1', token: TOKEN, fetchFn: async () => { throw new Error('refused'); } }).run('a', 'start');
    expect(r).toEqual({ status: 503, body: { ok: false, error: 'agent-not-running' } });
  });
  it('maps a rejected token and a bad reply to their own errors', async () => {
    expect((await createAgentClient({ url: 'http://x:1', token: TOKEN, fetchFn: async () => json(401, { ok: false }) }).run('a', 'start')).body.error).toBe('agent-token-rejected');
    expect((await createAgentClient({ url: 'http://x:1', token: TOKEN, fetchFn: async () => ({ status: 200, json: async () => { throw new Error('x'); } }) }).run('a', 'start')).body.error).toBe('agent-bad-reply');
  });
  it('pings with the token and tells a refused token from a stopped agent', async () => {
    const f = vi.fn(async () => json(401, { ok: false }));
    expect(await createAgentClient({ url: 'http://x:1', token: TOKEN, fetchFn: f }).ping()).toBe('token-rejected');
    expect(f.mock.calls[0][1].headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(await createAgentClient({ url: 'http://x:1', token: TOKEN, fetchFn: async () => json(500, {}) }).ping()).toBe('down');
  });
  it('pings, caching the answer for a few seconds', async () => {
    let t = 0;
    const f = vi.fn(async () => json(200, { ok: true }));
    const c = createAgentClient({ url: 'http://x:1', token: TOKEN, fetchFn: f, now: () => t });
    expect(await c.ping()).toBe('up');
    expect(await c.ping()).toBe('up');
    expect(f).toHaveBeenCalledTimes(1);
    t = 6000;
    f.mockImplementation(async () => { throw new Error('down'); });
    expect(await c.ping()).toBe('down');
  });
});

describe('Stop never takes the shelf down', () => {
  const SHELF = '/home/me/dev/demo-shelf-LAB';
  const entry = (id, composeFile, composeOverlays = []) => ({ id, composeFile, composeOverlays, where: 'installed' });
  const run = async (demo, action = 'stop', shelfDir = SHELF) => {
    const exec = okExec();
    const r = await call(mk({ exec, shelfDir, getDemos: () => [demo] }), 'post', `/v1/demos/${demo.id}/${action}`);
    return { r, calls: exec.mock.calls };
  };

  it('stop runs exactly one compose down, on the named demo\'s file and nothing else', async () => {
    const { r, calls } = await run(entry('a', '/home/me/dev/a-LAB/docker-compose.yml'));
    expect(r.status).toBe(200);
    expect(calls.map(([, args]) => args)).toEqual([['context', 'show'], ['compose', '-f', '/home/me/dev/a-LAB/docker-compose.yml', 'down']]);
  });

  it.each([
    ['the shelf\'s own compose file', `${SHELF}/docker-compose.yml`, []],
    ['another file in the shelf\'s folder', `${SHELF}/other.yml`, []],
    ['an overlay in the shelf\'s folder', '/home/me/dev/a-LAB/docker-compose.yml', [`${SHELF}/docker-compose.override.yml`]],
    ['a folder that gets the same compose project name', '/elsewhere/Demo-Shelf-LAB/docker-compose.yml', []],
    ['a relative path that resolves into the shelf', `${SHELF}/web/../docker-compose.yml`, []],
  ])('refuses start and stop for %s, and runs no docker command', async (_what, file, overlays) => {
    for (const action of ['start', 'stop']) {
      const { r, calls } = await run(entry('x', file, overlays), action);
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ ok: false, error: 'is-the-shelf' });
      expect(calls).toHaveLength(0);
    }
  });

  it('does not refuse a demo just because its folder name contains the shelf\'s', async () => {
    const { r } = await run(entry('a', '/home/me/dev/demo-shelf-LAB-extra/docker-compose.yml'));
    expect(r.status).toBe(200);
  });

  it('without a shelf folder the guard is off (the unit default)', async () => {
    const { r } = await run(entry('a', `${SHELF}/docker-compose.yml`), 'stop', null);
    expect(r.status).toBe(200);
  });

});

describe('last-running + restore-last', () => {
  it('restore-last: starts the recorded set LRU-first, records them again, skips unknown ids', async () => {
    const file = path.join(os.tmpdir(), `agent-lastrunning-${Date.now()}.json`);
    const lastRunning = createLastRunning({ file });
    lastRunning.recordStart('a'); lastRunning.recordStart('b');
    const a = mk({ lastRunning });
    const r = await call(a, 'post', '/v1/restore-last').send({ limit: 10 });
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([
      { id: 'a', started: true },
      { id: 'b', started: false, error: 'not-registered' },
    ]);
    // 'b' is not in the registry: dropped from the remembered set; 'a' re-recorded as most recent.
    expect(lastRunning.list().map((e) => e.id)).toEqual(['a']);
    fs.rmSync(file, { force: true });
  });

  it('restore-last: 409 when the agent has no lastRunning', async () => {
    const r = await call(mk(), 'post', '/v1/restore-last');
    expect(r.status).toBe(409);
  });

  it('GET /v1/last-running returns the set; 409 without lastRunning', async () => {
    const file = path.join(os.tmpdir(), `agent-lastrunning2-${Date.now()}.json`);
    const lastRunning = createLastRunning({ file });
    lastRunning.recordStart('a');
    const withLr = mk({ lastRunning });
    const got = await call(withLr, 'get', '/v1/last-running');
    expect(got.status).toBe(200);
    expect(got.body.demos.map((e) => e.id)).toEqual(['a']);
    const without = await call(mk(), 'get', '/v1/last-running');
    expect(without.status).toBe(409);
    fs.rmSync(file, { force: true });
  });
});

describe('running count against the limit', () => {
  const lsExec = (files) => vi.fn(async (file, args) => {
    if (args[0] === 'compose' && args[1] === 'ls') return { stdout: JSON.stringify(files.map((f, i) => ({ Name: `p${i}`, Status: 'running(1)', ConfigFiles: f }))), stderr: '' };
    return { stdout: 'orbstack\n', stderr: '' };
  });
  it('GET /v1/running counts the registered demos docker compose has up, with the limit; token required', async () => {
    const app = mk({ exec: lsExec(['/x/a/docker-compose.yml', '/elsewhere/other.yml']), maxRunningDemos: 10 });
    const r = await call(app, 'get', '/v1/running');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, schema: 'shelf-agent-running/1', running: 1, max: 10 });
    expect((await call(app, 'get', '/v1/running', { token: null })).status).toBe(401);
  });
  it('says null when Docker cannot tell, or when there is no limit', async () => {
    const broken = vi.fn(async () => { throw new Error('no docker'); });
    expect((await call(mk({ exec: broken, maxRunningDemos: 10 }), 'get', '/v1/running')).body).toMatchObject({ running: null, max: 10 });
    expect((await call(mk({ exec: lsExec([]) }), 'get', '/v1/running')).body).toMatchObject({ running: 0, max: null });
  });
  it('the client reads it, caches it, and gives null for an older agent without the route', async () => {
    let t = 0;
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, running: 13, max: 10 }) }));
    const c = createAgentClient({ url: 'http://x:1', token: TOKEN, fetchFn: f, now: () => t });
    expect(await c.running()).toEqual({ running: 13, max: 10 });
    expect(await c.running()).toEqual({ running: 13, max: 10 });
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe('http://x:1/v1/running');
    const old = createAgentClient({ url: 'http://x:1', token: TOKEN, fetchFn: async () => ({ ok: false, status: 404, json: async () => ({ ok: false, error: 'not-found' }) }) });
    expect(await old.running()).toBe(null);
    const odd = createAgentClient({ url: 'http://x:1', token: TOKEN, fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ running: '13', max: 10 }) }) });
    expect(await odd.running()).toBe(null);
  });
});
