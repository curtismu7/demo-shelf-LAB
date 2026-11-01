import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createAgent, ensureToken, sameToken } from '../src/agent.js';
import { createAgentClient } from '../src/agent-client.js';

const TOKEN = 'a'.repeat(64);
const PORT = 4405;
const demos = [
  { id: 'a', composeFile: '/x/a/docker-compose.yml', composeOverlays: [], where: 'installed' },
  { id: 'nocompose', composeOverlays: [], where: 'installed' },
];
const okExec = () => vi.fn(async (file, args) => ({ stdout: args[0] === 'context' ? 'orbstack\n' : 'started\n', stderr: '' }));
const mk = (over = {}) => createAgent({ getDemos: () => demos, token: TOKEN, port: PORT, exec: okExec(), fileExists: () => true, ...over });
const call = (app, method, url, { host = `127.0.0.1:${PORT}`, token = TOKEN } = {}) => {
  const r = request(app)[method](url).set('Host', host);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};

describe('start agent', () => {
  it('starts a registered demo with the token and runs exactly docker compose up -d', async () => {
    const exec = okExec();
    const r = await call(mk({ exec }), 'post', '/v1/demos/a/start');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, id: 'a', action: 'start' });
    expect(exec).toHaveBeenLastCalledWith('docker', ['compose', '-f', '/x/a/docker-compose.yml', 'up', '-d']);
  });
  it('stops with down', async () => {
    const exec = okExec();
    await call(mk({ exec }), 'post', '/v1/demos/a/stop');
    expect(exec).toHaveBeenLastCalledWith('docker', ['compose', '-f', '/x/a/docker-compose.yml', 'down']);
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
