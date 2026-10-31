import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { composeArgs, redact } from '../src/control.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAll, resolveBind, resolvePort } from '../src/index.js';

const good = { schema: 'demo-health/1', at: '2026-10-21T10:00:00Z', state: 'ready', runtime: 'live', demo: { id: 'a', name: 'A', version: '1' } };
const demos = [
  { id: 'a', name: 'A', catalogId: 'C1', description: 'x', url: 'http://localhost:4500', healthPath: '/api/health', composeFile: '/tmp/a/c.yml', composeOverlays: ['/tmp/a/o.yml'] },
  { id: 'b', name: 'B', catalogId: 'D1', description: 'y', url: 'http://localhost:4501', healthPath: '/api/health', composeOverlays: [] },
];
const catalog = { items: [
  { id: 'C1', name: 'ID-JAG', kind: 'Demo', group: 'C', seed: 'built', wave: 0, status: 'active' },
  { id: 'D1', name: 'Privilege', kind: 'Demo', group: 'D', seed: 'partial', wave: 2, status: 'active' },
  { id: 'E2', name: 'Shelf', kind: 'Tool', group: 'E', seed: 'none', wave: 1, status: 'active' },
  { id: 'A24', name: 'Backlogged', kind: null, group: 'A', seed: 'none', wave: 'backlog', status: 'backlog' },
] };
const fetchFn = vi.fn(async (url) => (new URL(url).port === '4500' ? new Response(JSON.stringify(good)) : Promise.reject(new Error('refused'))));
const mk = (over = {}) => createApp({ demos, catalog, fetchFn, wait: async () => {}, ...over });
const post = (app, path, headers = { Origin: 'http://127.0.0.1:0' }) => request(app).post(path).set('Host', 'localhost:4400').set(headers);
const sameOrigin = { Origin: 'http://localhost:4400' };

describe('GET /api/health', () => {
  it('answers demo-health/1 with no detail', async () => {
    const r = await request(mk()).get('/api/health').set('Host', 'localhost:4400');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ schema: 'demo-health/1', state: 'ready', runtime: 'offline', demo: { id: 'demo-shelf-LAB' } });
    expect(Object.keys(r.body).sort()).toEqual(['at', 'demo', 'runtime', 'schema', 'state']);
  });
});

describe('GET /api/shelf', () => {
  it('merges registry, catalog and status; other active items are planned; backlog is hidden', async () => {
    const r = await request(mk()).get('/api/shelf').set('Host', 'localhost:4400');
    expect(r.status).toBe(200);
    expect(r.body.demos.map((d) => [d.id, d.status.state])).toEqual([['a', 'ready'], ['b', 'down']]);
    expect(r.body.demos[0]).toMatchObject({ catalogId: 'C1', kind: 'Demo', wave: 0, canStart: false });
    expect(r.body.planned.map((p) => [p.id, p.status.state])).toEqual([['E2', 'planned']]);
    expect(r.body.demos[0]).toMatchObject({ group: 'C', composeFile: '/tmp/a/c.yml' });
    expect(r.body.demos[0].startCommand).toBe('docker compose -f /tmp/a/c.yml -f /tmp/a/o.yml up -d');
  });
  it('gives each place a demo lives its own card; mock copies poll mockUrl and never start', async () => {
    const reg = [
      { ...demos[0], where: 'both', mockUrl: 'http://localhost:4500' },
      { id: 'h', name: 'H', description: 'z', url: undefined, where: 'mock', mockUrl: 'http://localhost:4501', healthPath: '/api/health', composeOverlays: [] },
      demos[1],
    ];
    const r = await request(mk({ demos: reg, allowStart: true })).get('/api/shelf').set('Host', 'localhost:4400');
    expect(r.body.demos.map((d) => [d.id, d.where, d.url])).toEqual([
      ['a', 'installed', 'http://localhost:4500'], ['a-mock', 'mock', 'http://localhost:4500'],
      ['h', 'mock', 'http://localhost:4501'], ['b', 'installed', 'http://localhost:4501'],
    ]);
    expect(r.body.demos[1]).toMatchObject({ canStart: false, startCommand: null, composeFile: null });
    expect(r.body.demos[0].canStart).toBe(true);
    expect(r.body.demos[1].status.state).toBe('ready');
  });
  it('polls once for many requests', async () => {
    fetchFn.mockClear();
    const app = mk();
    await Promise.all([1, 2, 3, 4].map(() => request(app).get('/api/shelf').set('Host', 'localhost')));
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(4); // a: health; b: health + page
  });
  it('takes no input that selects what gets fetched', async () => {
    fetchFn.mockClear();
    await request(mk()).get('/api/shelf?url=http://evil.example&id=zzz').set('Host', 'localhost');
    expect(fetchFn.mock.calls.every(([u]) => /^http:\/\/localhost:450[01]\//.test(u))).toBe(true);
  });
  it('refresh works and unknown api paths 404', async () => {
    const app = mk();
    expect((await request(app).post('/api/shelf/refresh').set('Host', 'localhost')).status).toBe(200);
    expect((await request(app).get('/api/nope').set('Host', 'localhost')).status).toBe(404);
  });
  it('refuses a non-loopback Host (DNS rebinding) when bound to loopback', async () => {
    expect((await request(mk()).get('/api/shelf').set('Host', 'evil.example')).status).toBe(403);
  });
});

describe('start/stop is absent unless enabled', () => {
  it('has no route when SHELF_ALLOW_START is off', async () => {
    const r = await post(mk(), '/api/demos/a/start', sameOrigin);
    expect(r.status).toBe(404);
  });
});

describe('start/stop', () => {
  const okExec = (ctx = 'orbstack') => vi.fn(async (file, args) => (args[0] === 'context' ? { stdout: ctx + '\n', stderr: '' } : { stdout: 'started', stderr: '' }));
  const app = (exec, over = {}) => mk({ allowStart: true, exec, fileExists: () => true, ...over });

  it('runs exactly docker compose -f file -f overlay up -d, no shell', async () => {
    const exec = okExec();
    const r = await post(app(exec), '/api/demos/a/start', sameOrigin);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, id: 'a', action: 'start', output: 'started' });
    expect(exec.mock.calls).toEqual([
      ['docker', ['context', 'show']],
      ['docker', ['compose', '-f', '/tmp/a/c.yml', '-f', '/tmp/a/o.yml', 'up', '-d']],
    ]);
  });
  it('stop runs down', async () => {
    const exec = okExec();
    await post(app(exec), '/api/demos/a/stop', sameOrigin);
    expect(exec.mock.calls[1][1]).toEqual(['compose', '-f', '/tmp/a/c.yml', '-f', '/tmp/a/o.yml', 'down']);
  });
  it('refuses a missing Origin', async () => {
    const exec = okExec();
    const r = await post(app(exec), '/api/demos/a/start', {});
    expect([r.status, r.body.error]).toEqual([403, 'bad-origin']);
    expect(exec).not.toHaveBeenCalled();
  });
  it('refuses a foreign Origin', async () => {
    const exec = okExec();
    const r = await post(app(exec), '/api/demos/a/start', { Origin: 'http://evil.example' });
    expect([r.status, r.body.error]).toEqual([403, 'bad-origin']);
    expect(exec).not.toHaveBeenCalled();
  });
  it('refuses a non-loopback peer', async () => {
    const exec = okExec();
    const a = app(exec);
    const wrapped = (req, res) => { Object.defineProperty(req.socket, 'remoteAddress', { value: '192.168.1.9', configurable: true }); a(req, res); };
    const r = await request(wrapped).post('/api/demos/a/start').set('Host', 'localhost:4400').set(sameOrigin);
    expect([r.status, r.body.error]).toEqual([403, 'loopback-only']);
    expect(exec).not.toHaveBeenCalled();
  });
  it('refuses an unregistered id and never runs anything', async () => {
    const exec = okExec();
    for (const id of ['zzz', '..%2F..%2Fetc', 'a;id']) {
      const r = await post(app(exec), `/api/demos/${id}/start`, sameOrigin);
      expect(r.status).toBe(404);
    }
    expect(exec).not.toHaveBeenCalled();
  });
  it('refuses a registered demo with no compose file', async () => {
    const exec = okExec();
    const r = await post(app(exec), '/api/demos/b/start', sameOrigin);
    expect([r.status, r.body.error]).toEqual([400, 'no-compose-file']);
    expect(exec).not.toHaveBeenCalled();
  });
  it.each(['desktop-linux', 'default', ''])('refuses docker context "%s"', async (ctx) => {
    const exec = okExec(ctx);
    const r = await post(app(exec), '/api/demos/a/start', sameOrigin);
    expect([r.status, r.body.error]).toEqual([409, 'docker-context-not-orbstack']);
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it('refuses when docker cannot be run', async () => {
    const exec = vi.fn(async () => { throw new Error('ENOENT'); });
    const r = await post(app(exec), '/api/demos/a/start', sameOrigin);
    expect([r.status, r.body.error]).toEqual([503, 'docker-unavailable']);
  });
  it('refuses when a compose file is missing', async () => {
    const exec = okExec();
    const r = await post(app(exec, { fileExists: (f) => f !== '/tmp/a/o.yml' }), '/api/demos/a/start', sameOrigin);
    expect([r.status, r.body.error]).toEqual([409, 'compose-file-missing']);
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it('refuses a second start while one is running', async () => {
    let release;
    const exec = vi.fn(async (f, args) => {
      if (args[0] === 'context') return { stdout: 'orbstack', stderr: '' };
      await new Promise((r) => { release = r; });
      return { stdout: 'ok', stderr: '' };
    });
    const a = app(exec);
    const first = post(a, '/api/demos/a/start', sameOrigin).then((r) => r);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const second = await post(a, '/api/demos/a/start', sameOrigin);
    expect([second.status, second.body.error]).toEqual([409, 'busy']);
    release();
    expect((await first).status).toBe(200);
  });
  it('reports a timeout and a failure, with redacted trimmed output', async () => {
    const t = Object.assign(new Error('x'), { killed: true, stdout: '', stderr: '' });
    let r = await post(app(vi.fn(async (f, a) => { if (a[0] === 'context') return { stdout: 'orbstack' }; throw t; })), '/api/demos/a/start', sameOrigin);
    expect([r.status, r.body.error]).toEqual([502, 'timeout']);
    const f = Object.assign(new Error('x'), { stdout: '', stderr: 'boom TOKEN=abc123 Bearer qqq' });
    r = await post(app(vi.fn(async (fl, a) => { if (a[0] === 'context') return { stdout: 'orbstack' }; throw f; })), '/api/demos/a/start', sameOrigin);
    expect(r.body).toMatchObject({ error: 'compose-failed' });
    expect(r.body.output).toBe('boom TOKEN=[redacted] Bearer [redacted]');
  });
  it('invalidates the status cache after a change', async () => {
    fetchFn.mockClear();
    const a = app(okExec());
    await request(a).get('/api/shelf').set('Host', 'localhost');
    const before = fetchFn.mock.calls.length;
    await post(a, '/api/demos/a/start', sameOrigin);
    await request(a).get('/api/shelf').set('Host', 'localhost');
    expect(fetchFn.mock.calls.length).toBeGreaterThan(before);
  });
  it('exposes canStart per demo', async () => {
    const r = await request(app(okExec())).get('/api/shelf').set('Host', 'localhost');
    expect(r.body.demos.map((d) => d.canStart)).toEqual([true, false]);
    expect(r.body.startEnabled).toBe(true);
  });
});

describe('helpers', () => {
  it('redact scrubs jwts, secrets, long tokens and caps length', () => {
    expect(redact('a eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefgh b')).toBe('a [redacted] b');
    expect(redact('client_secret: hunter2')).toBe('client_secret: [redacted]');
    expect(redact('x'.repeat(50))).toBe('[redacted]');
    expect(redact('y '.repeat(5000)).length).toBeLessThanOrEqual(2000);
  });
  it('composeArgs is a fixed shape', () => {
    expect(composeArgs({ composeFile: '/a.yml', composeOverlays: [] }, 'start')).toEqual(['compose', '-f', '/a.yml', 'up', '-d']);
  });
  it('binds to loopback unless SHELF_BIND is set', () => {
    expect(resolveBind({})).toEqual({ host: '127.0.0.1', explicit: false, loopback: true });
    expect(resolveBind({ SHELF_BIND: '0.0.0.0' })).toEqual({ host: '0.0.0.0', explicit: true, loopback: false });
    expect(() => resolvePort({ SHELF_PORT: 'x' })).toThrow();
  });
  it('SHELF_SEED_FILE replaces the committed seed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-seed-'));
    const seed = path.join(dir, 'seed.json');
    fs.writeFileSync(seed, JSON.stringify({ demos: [{ id: 'only-one', name: 'Only', description: 'd', url: 'http://localhost:4599' }] }));
    const { demos: loaded } = loadAll({ SHELF_SEED_FILE: seed, SHELF_DATA_DIR: dir });
    expect(loaded.map((d) => d.id)).toEqual(['only-one']);
    fs.rmSync(dir, { recursive: true });
  });
});
