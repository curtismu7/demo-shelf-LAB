import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createAgent } from '../src/agent.js';
import { createAgentClient } from '../src/agent-client.js';
import { createApp, installOf } from '../src/app.js';
import { createInstallChecker, createInstallState } from '../src/install.js';

const TOKEN = 'a'.repeat(64);
const PORT = 4405;
const OPTS = { timeoutMs: 8000 };
const demoA = { id: 'a', name: 'A', description: 'd', url: 'http://localhost:4500', healthPath: '/api/health', composeFile: '/x/a/docker-compose.yml', composeOverlays: ['/x/a/o.yml'], where: 'installed' };
const demoB = { id: 'b', name: 'B', description: 'd', url: 'http://localhost:4501', healthPath: '/api/health', composeFile: '/x/b/docker-compose.yml', composeOverlays: [], where: 'installed' };
const noCompose = { id: 'nocompose', name: 'N', description: 'd', url: 'http://localhost:4502', healthPath: '/api/health', composeOverlays: [], where: 'installed' };

// A docker stand-in. `over(args)` may return { stdout } or throw to simulate a failure of one call.
const dockerExec = (over = () => undefined) => vi.fn(async (file, args) => {
  const o = await over(args);
  if (o) return { stderr: '', ...o };
  if (args[0] === 'context') return { stdout: 'orbstack\n', stderr: '' };
  if (args.includes('config')) return { stdout: 'img-a:latest\nimg-b\n', stderr: '' };
  return { stdout: '[]', stderr: '' };
});
const checker = (over = {}) => createInstallChecker({ getDemos: () => [demoA], exec: dockerExec(), fileExists: () => true, ...over });
const noSuchImage = Object.assign(new Error('x'), { stderr: 'Error response from daemon: No such image: img-a:latest' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('install check: what it runs', () => {
  it('runs exactly context show, compose config --images, image inspect, as argv arrays with a short timeout', async () => {
    const exec = dockerExec();
    const r = await checker({ exec }).checkAll();
    expect([...r]).toEqual([['a', { compose: 'present', images: 'built' }]]);
    expect(exec.mock.calls).toEqual([
      ['docker', ['context', 'show'], OPTS],
      ['docker', ['compose', '-f', '/x/a/docker-compose.yml', '-f', '/x/a/o.yml', 'config', '--images'], OPTS],
      ['docker', ['image', 'inspect', 'img-a:latest', 'img-b'], OPTS],
    ]);
  });
  it('reports images "missing" only when Docker says the image does not exist', async () => {
    const exec = dockerExec((args) => { if (args[0] === 'image') throw noSuchImage; });
    expect((await checker({ exec }).checkAll()).get('a').images).toBe('missing');
  });
  it('does not run anything for a demo whose compose file (or overlay) is not there', async () => {
    const exec = dockerExec();
    const noOverlay = (f) => f !== '/x/a/o.yml';
    expect([...(await checker({ exec, fileExists: noOverlay }).checkAll())]).toEqual([['a', { compose: 'missing', images: 'unknown' }]]);
    expect(exec).not.toHaveBeenCalled();
  });
  it('skips demos with no compose file, and never runs docker for the shelf\'s own entry', async () => {
    const exec = dockerExec();
    const r = await checker({ exec, getDemos: () => [noCompose, demoA], shelfDir: '/x/a' }).checkAll();
    expect([...r.keys()]).toEqual(['a']);
    expect(r.get('a')).toEqual({ compose: 'present', images: 'unknown' });
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('install check: every failure is "unknown"', () => {
  const cases = {
    'Docker context is not OrbStack': (args) => (args[0] === 'context' ? { stdout: 'desktop-linux\n' } : undefined),
    'docker context show fails': (args) => { if (args[0] === 'context') throw new Error('no docker'); },
    'compose cannot interpolate required variables': (args) => { if (args.includes('config')) throw Object.assign(new Error('x'), { stderr: 'required variable FOO is missing a value' }); },
    'compose prints no images': (args) => (args.includes('config') ? { stdout: '\n' } : undefined),
    'an image name that looks like a flag': (args) => (args.includes('config') ? { stdout: '--privileged\n' } : undefined),
    'an image name with a space': (args) => (args.includes('config') ? { stdout: 'a b\n' } : undefined),
    'an image name with shell characters': (args) => (args.includes('config') ? { stdout: 'a;rm\n' } : undefined),
    'more than 24 images': (args) => (args.includes('config') ? { stdout: Array.from({ length: 25 }, (_, i) => `i${i}`).join('\n') } : undefined),
    'inspect fails for another reason': (args) => { if (args[0] === 'image') throw Object.assign(new Error('x'), { stderr: 'Cannot connect to the Docker daemon' }); },
    'inspect is killed by its timeout': (args) => { if (args[0] === 'image') throw Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' }); },
  };
  it.each(Object.entries(cases))('%s', async (_name, over) => {
    const r = await checker({ exec: dockerExec(over) }).checkAll();
    expect(r.get('a')).toEqual({ compose: 'present', images: 'unknown' });
  });
  it('a docker call that never answers is cut off at the per-call timeout', async () => {
    const exec = vi.fn(() => new Promise(() => {}));
    const t0 = Date.now();
    const r = await checker({ exec, timeoutMs: 40 }).checkAll();
    expect(r.get('a').images).toBe('unknown');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(exec).toHaveBeenCalledTimes(1); // it did not go on to the next call
  });
  it('checkAll answers "unknown" for a check still running at its deadline, and does not wait', async () => {
    const exec = vi.fn(() => new Promise(() => {}));
    const t0 = Date.now();
    const r = await checker({ exec, timeoutMs: 400, deadlineMs: 30 }).checkAll();
    expect(r.get('a')).toEqual({ compose: 'present', images: 'unknown' });
    expect(Date.now() - t0).toBeLessThan(300);
    await sleep(450); // let the timers of the pending check end
  });
});

describe('install check: cache, invalidation, concurrency', () => {
  it('serves a cached result for 30 s, then checks again', async () => {
    let t = 1000;
    const exec = dockerExec();
    const c = checker({ exec, now: () => t });
    await c.checkAll();
    t += 29_000;
    await c.checkAll();
    expect(exec).toHaveBeenCalledTimes(3);
    t += 2000;
    await c.checkAll();
    expect(exec).toHaveBeenCalledTimes(6);
  });
  it('still reads the compose file every time (a fresh clone shows up at once)', async () => {
    const present = { v: false };
    const c = checker({ fileExists: () => present.v });
    expect((await c.checkAll()).get('a').compose).toBe('missing');
    present.v = true;
    expect((await c.checkAll()).get('a').compose).toBe('present');
  });
  it('invalidate(id) drops that demo only', async () => {
    const exec = dockerExec();
    const c = checker({ exec, getDemos: () => [demoA, demoB] });
    await c.checkAll();
    expect(exec).toHaveBeenCalledTimes(6);
    c.invalidate('a');
    await c.checkAll();
    expect(exec).toHaveBeenCalledTimes(9); // only a was checked again
    expect(exec.mock.calls.slice(6).every(([, args]) => !args.includes('/x/b/docker-compose.yml'))).toBe(true);
  });
  it('a check that was running when the demo was started is not cached', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const exec = dockerExec(async (args) => { if (args.includes('config')) await gate; });
    const c = checker({ exec });
    const first = c.checkAll();
    await sleep(20);
    c.invalidate('a');
    release();
    await first;
    const before = exec.mock.calls.length;
    await c.checkAll();
    expect(exec.mock.calls.length).toBeGreaterThan(before); // checked again, the stale answer was not kept
  });
  it('shares one check between concurrent callers', async () => {
    const exec = dockerExec(async () => { await sleep(10); });
    const c = checker({ exec });
    await Promise.all([c.checkAll(), c.checkAll(), c.checkAll()]);
    expect(exec).toHaveBeenCalledTimes(3);
  });
  it('checks at most 2 demos at once', async () => {
    let now = 0;
    let max = 0;
    const exec = dockerExec(async () => { now++; max = Math.max(max, now); await sleep(15); now--; });
    const demos = Array.from({ length: 6 }, (_, i) => ({ ...demoB, id: `d${i}`, composeFile: `/x/d${i}/c.yml` }));
    const r = await checker({ exec, getDemos: () => demos }).checkAll();
    expect([...r.values()].every((v) => v.images === 'built')).toBe(true);
    expect(max).toBe(2);
  });
});

describe('start agent: GET /v1/installs', () => {
  const agentDemos = [demoA, noCompose];
  const mk = (over = {}) => createAgent({ getDemos: () => agentDemos, token: TOKEN, port: PORT, exec: dockerExec(), fileExists: () => true, ...over });
  const call = (app, method, url, { host = `127.0.0.1:${PORT}`, token = TOKEN } = {}) => {
    const r = request(app)[method](url).set('Host', host);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };

  it('needs the token, a loopback Host, and answers GET only', async () => {
    const exec = dockerExec();
    const app = mk({ exec });
    expect((await call(app, 'get', '/v1/installs', { token: null })).status).toBe(401);
    expect((await call(app, 'get', '/v1/installs', { token: 'b'.repeat(64) })).status).toBe(401);
    expect((await call(app, 'get', '/v1/installs', { host: 'evil.example' })).status).toBe(403);
    expect((await call(app, 'post', '/v1/installs')).status).toBe(404);
    expect((await call(app, 'get', '/v1/installs/a')).status).toBe(404);
    expect(exec).not.toHaveBeenCalled();
    expect((await call(app, 'get', '/v1/installs', { host: `host.docker.internal:${PORT}` })).status).toBe(200);
  });
  it('answers for registered demos with a compose file, as enum values only', async () => {
    const r = await call(mk(), 'get', '/v1/installs');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, schema: 'shelf-agent-installs/1', installs: { a: { compose: 'present', images: 'built' } } });
  });
  it('never leaks a path, a command or output, whatever Docker prints', async () => {
    const exec = dockerExec((args) => {
      if (args.includes('config')) throw Object.assign(new Error('/Users/someone/secret/docker-compose.yml: bad'), { stderr: '/Users/someone/secret token=abc' });
    });
    const missing = await call(mk({ exec, fileExists: () => false }), 'get', '/v1/installs');
    const failed = await call(mk({ exec }), 'get', '/v1/installs');
    for (const r of [missing, failed]) {
      expect(JSON.stringify(r.body)).not.toMatch(/\/x\/|\/Users|docker|orbstack|token|compose\.yml|\.yml/);
      expect(Object.keys(r.body.installs.a).sort()).toEqual(['compose', 'images']);
    }
  });
  it('ignores the query string: nothing in the request reaches a path or a command', async () => {
    const exec = dockerExec();
    await call(mk({ exec }), 'get', '/v1/installs?id=../../etc/passwd&file=/etc/hosts&x=%00');
    expect(exec.mock.calls.flatMap(([, args]) => args).join(' ')).not.toMatch(/etc|passwd|\.\./);
  });
  it('is an error body in the usual shape when the registry is invalid', async () => {
    const r = await call(mk({ getDemos: () => { throw new Error('bad'); } }), 'get', '/v1/installs');
    expect([r.status, r.body]).toEqual([500, { ok: false, error: 'registry-invalid' }]);
  });
  it('answers within its deadline even if Docker hangs', async () => {
    const t0 = Date.now();
    const r = await call(mk({ exec: vi.fn(() => new Promise(() => {})), installOptions: { deadlineMs: 30, timeoutMs: 3000 } }), 'get', '/v1/installs');
    expect(r.body.installs.a).toEqual({ compose: 'present', images: 'unknown' });
    // the per-call timeout is 3 s, so an answer well before that came from the deadline (the bound is loose on purpose: a loaded machine)
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it('forgets a demo\'s image state after Start or Stop on it', async () => {
    const exec = dockerExec();
    const app = mk({ exec });
    await call(app, 'get', '/v1/installs');
    await call(app, 'get', '/v1/installs');
    const configs = () => exec.mock.calls.filter(([, args]) => args.includes('config')).length;
    expect(configs()).toBe(1);
    await call(app, 'post', '/v1/demos/a/start');
    await call(app, 'get', '/v1/installs');
    expect(configs()).toBe(2);
  });
});

describe('shelf side: /api/shelf never waits for the install check', () => {
  const reg = [demoA, demoB, noCompose];
  const up = new Response(JSON.stringify({ schema: 'demo-health/1', at: '2026-10-21T10:00:00Z', state: 'ready', runtime: 'live', demo: { id: 'a' } }));
  const fetchFn = vi.fn(async (url) => (new URL(url).port === '4500' ? up.clone() : Promise.reject(new Error('refused'))));
  const mk = (installSource, over = {}) => createApp({ demos: reg, catalog: { items: [] }, fetchFn, wait: async () => {}, installSource, ...over });
  const get = (app) => request(app).get('/api/shelf').set('Host', 'localhost:4400');
  const byId = (r) => Object.fromEntries(r.body.demos.map((d) => [d.id, [d.install, d.imagesBuilt]]));
  const settled = async (app, predicate) => { for (let i = 0; i < 50; i++) { const r = await get(app); if (predicate(r)) return r; await sleep(10); } throw new Error('never settled'); };

  it('answers at once, with "unknown", while the check never finishes', async () => {
    const source = { fetch: vi.fn(() => new Promise(() => {})) };
    const app = mk(source);
    const t0 = Date.now();
    const r = await get(app);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.body.installPending).toBe(true);
    expect(byId(r)).toEqual({ a: ['unknown', null], b: ['unknown', null], nocompose: ['unknown', null] });
    await get(app);
    expect(source.fetch).toHaveBeenCalledTimes(1); // one refresh at a time
  });
  it('shows the result from the next request on', async () => {
    const map = new Map([['a', { compose: 'present', images: 'built' }], ['b', { compose: 'present', images: 'missing' }], ['nocompose', { compose: 'missing', images: 'unknown' }]]);
    const app = mk({ fetch: async () => map });
    expect((await get(app)).body.installPending).toBe(true);
    const r = await settled(app, (x) => x.body.installPending === false);
    // nocompose has no compose file: whatever the host says, the shelf has nothing to base a claim on
    expect(byId(r)).toEqual({ a: ['installed', true], b: ['installed', false], nocompose: ['unknown', null] });
  });
  it('says not-installed only for a demo that is down; one that answers its health probe is never not-installed', async () => {
    const map = new Map([['a', { compose: 'missing', images: 'unknown' }], ['b', { compose: 'missing', images: 'unknown' }]]);
    const app = mk({ fetch: async () => map });
    await get(app);
    const r = await settled(app, (x) => x.body.installPending === false);
    expect(byId(r).a).toEqual(['installed', null]); // a answers (ready)
    expect(byId(r).b).toEqual(['not-installed', null]); // b is down
  });
  it('is "unknown" for everything when the host cannot answer (agent not running, old agent)', async () => {
    const app = mk({ fetch: async () => null });
    await get(app);
    const r = await settled(app, (x) => x.body.installPending === false);
    expect(Object.values(byId(r)).every(([i, b]) => i === 'unknown' && b === null)).toBe(true);
    const thrown = mk({ fetch: async () => { throw new Error('boom'); } });
    await get(thrown);
    expect(Object.values(byId(await settled(thrown, (x) => x.body.installPending === false))).every(([i]) => i === 'unknown')).toBe(true);
  });
  it('has no install check at all without a source: everything unknown, nothing pending', async () => {
    const r = await get(mk(null));
    expect(r.body.installPending).toBe(false);
    expect(byId(r).b).toEqual(['unknown', null]);
  });
  it('mock cards, both-cards and planned ideas: only the installed copy has an install state', async () => {
    const both = { ...demoB, id: 'both', where: 'both', mockUrl: 'http://localhost:4501' };
    const mockOnly = { ...demoB, id: 'mockonly', where: 'mock', mockUrl: 'http://localhost:4501', composeFile: undefined };
    const map = new Map([['both', { compose: 'missing', images: 'unknown' }], ['mockonly', { compose: 'missing', images: 'unknown' }], ['both-mock', { compose: 'missing', images: 'unknown' }]]);
    const app = createApp({ demos: [both, mockOnly], catalog: { items: [{ id: 'P1', name: 'Idea', kind: 'Demo', group: 'A', seed: 'none', wave: 1, status: 'active' }] }, fetchFn, wait: async () => {}, installSource: { fetch: async () => map } });
    await get(app);
    const r = await settled(app, (x) => x.body.installPending === false);
    expect(byId(r)).toEqual({ both: ['not-installed', null], 'both-mock': ['unknown', null], mockonly: ['unknown', null] });
    expect(r.body.planned[0]).not.toHaveProperty('install');
  });
  it('carries the validated repo through', async () => {
    const r = await get(mk(null, { demos: [{ ...demoB, repo: 'https://github.com/ping-sandbox/b-LAB' }, demoA] }));
    expect(r.body.demos.map((d) => d.repo)).toEqual(['https://github.com/ping-sandbox/b-LAB', null]);
  });
  it('Start / Stop invalidates that demo\'s install state (and passes the id to the source)', async () => {
    const invalidate = vi.fn();
    const agent = { run: vi.fn(async () => ({ status: 200, body: { ok: true } })), ping: async () => 'up' };
    const app = mk({ fetch: async () => new Map(), invalidate }, { allowStart: true, agent, inDocker: true });
    await request(app).post('/api/demos/b/start').set('Host', 'localhost:4400').set('Origin', 'http://localhost:4400');
    expect(invalidate).toHaveBeenCalledWith('b');
  });
  it('Refresh re-checks the install state and returns the new answer in the same response', async () => {
    let compose = 'missing';
    const source = { fetch: vi.fn(async () => new Map([['b', { compose, images: 'built' }]])) };
    const app = mk(source);
    await get(app);
    expect(byId(await settled(app, (x) => x.body.installPending === false)).b).toEqual(['not-installed', null]);
    compose = 'present'; // the repo was cloned, well inside the 30 s the state is cached for
    const r = await request(app).post('/api/shelf/refresh').set('Host', 'localhost:4400');
    expect(r.status).toBe(200);
    expect(byId(r).b).toEqual(['installed', true]);
    expect(r.body.installPending).toBe(false);
    expect(source.fetch).toHaveBeenCalledTimes(2);
  });
  it('Refresh waits only refreshWaitMs for a slow check, then says installPending', async () => {
    const source = { fetch: vi.fn(() => new Promise(() => {})) };
    const app = mk(source, { refreshWaitMs: 20 });
    const r = await request(app).post('/api/shelf/refresh').set('Host', 'localhost:4400');
    expect(r.status).toBe(200);
    expect(r.body.installPending).toBe(true);
  });
  it('an invalidated state keeps its old answer, marked pending, until the fresh one lands', async () => {
    const source = { fetch: vi.fn(async () => new Map([['b', { compose: 'present', images: 'built' }]])), invalidate: vi.fn() };
    const st = createInstallState({ source });
    st.snapshot();
    await sleep(10);
    expect(st.snapshot().pending).toBe(false);
    st.invalidate('b');
    const s = st.snapshot(); // old answer still served, a refresh starts
    expect(s.map.get('b').images).toBe('built');
    expect(s.pending).toBe(true);
    await sleep(10);
    expect(st.snapshot().pending).toBe(false);
    expect(source.fetch).toHaveBeenCalledTimes(2);
  });
  it('a fetch that started before an invalidate is discarded, and a new one follows', async () => {
    const resolvers = [];
    const source = { fetch: vi.fn(() => new Promise((r) => resolvers.push(r))) };
    const st = createInstallState({ source });
    st.snapshot(); // fetch #1 in flight
    await sleep(5);
    st.invalidate('b');
    resolvers[0](new Map([['b', { compose: 'present', images: 'missing' }]])); // predates the change
    await sleep(10);
    expect(st.snapshot().map).toBeNull(); // not kept
    await sleep(10);
    expect(source.fetch).toHaveBeenCalledTimes(2); // that same snapshot() started a fresh one
    resolvers[1](new Map([['b', { compose: 'present', images: 'built' }]]));
    await sleep(10);
    expect(st.snapshot().map.get('b').images).toBe('built');
  });
  it('refreshes after the ttl and keeps serving the old answer meanwhile', async () => {
    let t = 0;
    let n = 0;
    const source = { fetch: vi.fn(async () => new Map([['b', { compose: 'present', images: n++ ? 'built' : 'missing' }]])) };
    const st = createInstallState({ source, now: () => t });
    st.snapshot();
    await sleep(10);
    expect(st.snapshot().map.get('b').images).toBe('missing');
    expect(source.fetch).toHaveBeenCalledTimes(1);
    t = 31_000;
    expect(st.snapshot().map.get('b').images).toBe('missing'); // stale, served while it refreshes
    await sleep(10);
    expect(st.snapshot().map.get('b').images).toBe('built');
  });
});

describe('installOf', () => {
  const m = (compose, images) => new Map([['a', { compose, images }]]);
  const down = { state: 'down' };
  it.each([
    ['present + built', demoA, down, m('present', 'built'), { install: 'installed', imagesBuilt: true }],
    ['present + not built', demoA, down, m('present', 'missing'), { install: 'installed', imagesBuilt: false }],
    ['present + images unknown', demoA, down, m('present', 'unknown'), { install: 'installed', imagesBuilt: null }],
    ['missing + down', demoA, down, m('missing', 'unknown'), { install: 'not-installed', imagesBuilt: null }],
    ['missing + answering', demoA, { state: 'ready' }, m('missing', 'unknown'), { install: 'installed', imagesBuilt: null }],
    ['missing + off-contract answer', demoA, { state: 'unknown', reason: 'bad-state' }, m('missing', 'unknown'), { install: 'installed', imagesBuilt: null }],
    ['missing + never polled', demoA, { state: 'unknown', reason: 'not-polled' }, m('missing', 'unknown'), { install: 'not-installed', imagesBuilt: null }],
    ['no host answer', demoA, down, null, { install: 'unknown', imagesBuilt: null }],
    ['id not in the answer', demoB, down, m('missing', 'unknown'), { install: 'unknown', imagesBuilt: null }],
    ['mock card', { ...demoA, where: 'mock' }, down, m('missing', 'unknown'), { install: 'unknown', imagesBuilt: null }],
  ])('%s', (_n, d, status, map, want) => expect(installOf(d, status, map)).toEqual(want));
});

describe('agent client: installs()', () => {
  const client = (fetchFn) => createAgentClient({ url: 'http://127.0.0.1:4405/', token: TOKEN, fetchFn });
  const reply = (status, body) => vi.fn(async () => ({ ok: status < 300, status, json: async () => body }));
  it('asks GET /v1/installs with the bearer token and keeps only known values', async () => {
    const body = JSON.parse('{"ok":true,"installs":{"a":{"compose":"present","images":"built"},"b":{"compose":"weird","images":"built"},"c":{"compose":"missing","images":"x"},"d":7,"__proto__":{"compose":"present","images":"built"}}}');
    const f = reply(200, body);
    const r = await client(f).installs();
    expect(r.get('a')).toEqual({ compose: 'present', images: 'built' });
    expect(({}).compose).toBeUndefined(); // an own "__proto__" key in the reply is just a key
    expect(r.get('b')).toBeUndefined();
    expect(r.get('c')).toBeUndefined();
    expect(f.mock.calls[0][0]).toBe('http://127.0.0.1:4405/v1/installs');
    expect(f.mock.calls[0][1].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(f.mock.calls[0][1].method).toBeUndefined();
  });
  it.each([
    ['token rejected', () => reply(401, { ok: false })],
    ['old agent without the route', () => reply(404, { ok: false })],
    ['no installs object', () => reply(200, { ok: true })],
    ['agent not running', () => vi.fn(async () => { throw new Error('ECONNREFUSED'); })],
    ['not JSON', () => vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('x'); } }))],
  ])('null when %s', async (_n, mkF) => expect(await client(mkF()).installs()).toBeNull());
});
