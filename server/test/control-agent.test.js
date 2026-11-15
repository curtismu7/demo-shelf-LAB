import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

const demos = [
  { id: 'a', name: 'A', description: 'd', url: 'http://localhost:4500', healthPath: '/api/health', composeFile: '/h/a/docker-compose.yml', composeOverlays: [] },
  { id: 'b', name: 'B', description: 'd', url: 'http://localhost:4501', healthPath: '/api/health', composeOverlays: [] },
];
const fetchFn = async () => { throw new Error('refused'); };
const agentStub = (over = {}) => ({ run: vi.fn(async () => ({ status: 200, body: { ok: true, id: 'a', action: 'start', output: 'done' } })), ping: vi.fn(async () => 'up'), ...over });
const mk = (agent, over = {}) => createApp({ demos, catalog: { items: [] }, fetchFn, wait: async () => {}, allowStart: true, agent, inDocker: true, ...over });
const post = (app, path, headers = { Origin: 'http://localhost:4400' }) => request(app).post(path).set('Host', 'localhost:4400').set(headers);

describe('Start / Stop through the start agent (the shelf in a container)', () => {
  it('hands only the id and action to the agent, never a path or command', async () => {
    const agent = agentStub();
    const r = await post(mk(agent), '/api/demos/a/start');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, id: 'a', action: 'start' });
    expect(agent.run).toHaveBeenCalledWith('a', 'start');
  });
  it('does not write last-running itself: the agent owns it, and the container mounts .data read-only', async () => {
    const readOnly = { list: () => [], restoreIds: () => [], recordStart: vi.fn(() => { throw new Error('EROFS'); }), recordStop: vi.fn(() => { throw new Error('EROFS'); }) };
    const agent = agentStub({ run: vi.fn(async (id, action) => ({ status: 200, body: { ok: true, id, action, stopped: [{ id: 'old', name: 'Old' }], limit: 10 } })) });
    const app = mk(agent, { lastRunning: readOnly });
    for (const action of ['start', 'stop']) {
      const r = await post(app, `/api/demos/a/${action}`);
      expect([action, r.status, r.body.error]).toEqual([action, 200, undefined]); // used to be 500 internal after a successful start
    }
    expect((await post(app, '/api/demos/a/start')).body.stopped).toEqual([{ id: 'old', name: 'Old' }]); // the note can name what was stopped
    expect(readOnly.recordStart).not.toHaveBeenCalled();
    expect(readOnly.recordStop).not.toHaveBeenCalled();
  });
  it('still requires a same-origin POST and a registered demo with a compose file', async () => {
    const agent = agentStub();
    const app = mk(agent);
    expect((await post(app, '/api/demos/a/start', {})).status).toBe(403);
    expect((await post(app, '/api/demos/a/start', { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await post(app, '/api/demos/zzz/start')).status).toBe(404);
    expect((await post(app, '/api/demos/b/start')).status).toBe(400);
    expect(agent.run).not.toHaveBeenCalled();
  });
  it('passes the agent failure through, for example when it is not running', async () => {
    const agent = agentStub({ run: vi.fn(async () => ({ status: 503, body: { ok: false, error: 'agent-not-running' } })) });
    const r = await post(mk(agent), '/api/demos/a/start');
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('agent-not-running');
  });
  it('compares the whole Origin: a host that merely starts with the right one is refused', async () => {
    const agent = agentStub();
    const r = await post(mk(agent), '/api/demos/a/start', { Origin: 'http://localhost:4400.evil.example' });
    expect(r.status).toBe(403);
    expect(agent.run).not.toHaveBeenCalled();
  });
  it('matches the action case-sensitively', async () => {
    const agent = agentStub();
    expect((await post(mk(agent), '/api/demos/a/START')).status).toBe(404);
    expect(agent.run).not.toHaveBeenCalled();
  });
  it('releases the per-demo lock when the agent call throws, so the next click works', async () => {
    let n = 0;
    const agent = agentStub({ run: vi.fn(async () => { if (n++ === 0) throw new Error('boom'); return { status: 200, body: { ok: true } }; }) });
    const app = mk(agent);
    expect((await post(app, '/api/demos/a/start')).status).toBe(500);
    expect((await post(app, '/api/demos/a/start')).status).toBe(200);
  });
  it('keeps the Host check on in the container, so a foreign Host is refused', async () => {
    const r = await request(mk(agentStub())).get('/api/shelf').set('Host', 'evil.example');
    expect(r.status).toBe(403);
  });
  it('reports the agent state on /api/shelf, and "local" when the shelf runs Docker itself', async () => {
    const down = await request(mk(agentStub({ ping: async () => 'down' }))).get('/api/shelf').set('Host', 'localhost:4400');
    expect(down.body).toMatchObject({ startEnabled: true, agent: 'down' });
    const local = await request(mk(null, { inDocker: false })).get('/api/shelf').set('Host', 'localhost:4400');
    expect(local.body.agent).toBe('local');
  });
});

describe('the running count on /api/shelf', () => {
  const get = (app) => request(app).get('/api/shelf').set('Host', 'localhost:4400');
  it('passes the agent\'s count and limit through', async () => {
    const agent = agentStub({ running: vi.fn(async () => ({ running: 13, max: 10 })) });
    expect((await get(mk(agent, { maxRunningDemos: 10 }))).body.runningLimit).toEqual({ running: 13, max: 10 });
  });
  it('an older agent without the count still shows the limit the shelf knows', async () => {
    expect((await get(mk(agentStub(), { maxRunningDemos: 7 }))).body.runningLimit).toEqual({ running: null, max: 7 });
    expect((await get(mk(agentStub({ running: vi.fn(async () => null) }), { maxRunningDemos: 7 }))).body.runningLimit).toEqual({ running: null, max: 7 });
  });
  it('is null when Start / Stop is off', async () => {
    expect((await get(mk(agentStub(), { allowStart: false, maxRunningDemos: 10 }))).body.runningLimit).toBe(null);
  });
  // Counting asks Docker (1 to 5 s), so a request that already has a count must not wait for a new one.
  const clocked = (running, over = {}) => {
    const clock = { t: 1_000_000 };
    return { clock, app: mk(agentStub({ running }), { maxRunningDemos: 10, now: () => clock.t, ...over }) };
  };
  const held = () => { const h = {}; h.promise = new Promise((r) => { h.release = r; }); return h; };
  it('past 5 s it answers with the last count at once and asks again behind the request', async () => {
    const running = vi.fn(async () => ({ running: 3, max: 10 }));
    const { app, clock } = clocked(running);
    expect((await get(app)).body.runningLimit).toEqual({ running: 3, max: 10 });
    clock.t += 6_000;
    const h = held();
    running.mockImplementation(() => h.promise);
    expect((await get(app)).body.runningLimit).toEqual({ running: 3, max: 10 }); // the new ask is still pending
    h.release({ running: 4, max: 10 });
    await vi.waitFor(async () => expect((await get(app)).body.runningLimit).toEqual({ running: 4, max: 10 }));
    expect(running).toHaveBeenCalledTimes(2);
  });
  it('past 2 minutes it waits for a fresh count rather than show an old one', async () => {
    const running = vi.fn(async () => ({ running: 3, max: 10 }));
    const { app, clock } = clocked(running);
    await get(app);
    clock.t += 121_000;
    const h = held();
    running.mockImplementation(() => h.promise);
    let answered = false;
    const pending = get(app).then((r) => { answered = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(answered).toBe(false);
    h.release({ running: 9, max: 10 });
    expect((await pending).body.runningLimit).toEqual({ running: 9, max: 10 });
  });
  it('a Start or Stop makes the next request wait for a fresh count', async () => {
    const running = vi.fn().mockResolvedValueOnce({ running: 3, max: 10 }).mockResolvedValue({ running: 4, max: 10 });
    const { app } = clocked(running);
    expect((await get(app)).body.runningLimit).toEqual({ running: 3, max: 10 });
    expect((await post(app, '/api/demos/a/start')).status).toBe(200);
    expect((await get(app)).body.runningLimit).toEqual({ running: 4, max: 10 }); // same instant: the 5 s cache did not hide the change
  });
  it('a count that fails (the agent timed out) does not replace a good one under 2 minutes old', async () => {
    const running = vi.fn(async () => ({ running: 56, max: 60 }));
    const { app, clock } = clocked(running);
    expect((await get(app)).body.runningLimit).toEqual({ running: 56, max: 60 });
    const settle = async (calls) => { await vi.waitFor(() => expect(running).toHaveBeenCalledTimes(calls)); await new Promise((r) => setTimeout(r, 10)); };
    running.mockImplementation(async () => null); // what the agent client returns after its 30 s timeout
    clock.t += 6_000;
    expect((await get(app)).body.runningLimit).toEqual({ running: 56, max: 60 });
    await settle(2);
    clock.t += 6_000;
    expect((await get(app)).body.runningLimit).toEqual({ running: 56, max: 60 }); // not the shelf's own { running: null, max: 10 }
    await settle(3);
    running.mockImplementation(async () => ({ running: null, max: 60 })); // "Docker could not tell" is a failed count too
    clock.t += 6_000;
    expect((await get(app)).body.runningLimit).toEqual({ running: 56, max: 60 });
    await settle(4);
    clock.t += 6_000;
    expect((await get(app)).body.runningLimit).toEqual({ running: 56, max: 60 });
  });
  it('a good count is kept only while it is under 2 minutes old; after that the failure shows', async () => {
    const running = vi.fn(async () => ({ running: 56, max: 60 }));
    const { app, clock } = clocked(running);
    await get(app);
    running.mockImplementation(async () => null);
    clock.t += 121_000;
    expect((await get(app)).body.runningLimit).toEqual({ running: null, max: 10 });
    expect((await get(app)).body.runningLimit).toEqual({ running: null, max: 10 });
    expect(running).toHaveBeenCalledTimes(2); // the failure was cached; the old good count did not linger and force another wait
  });
  describe('keepWarmMs', () => {
    afterEach(() => { vi.useRealTimers(); });
    it('counts once at start and then every interval, so a page opened after an idle spell has one', async () => {
      vi.useFakeTimers();
      const running = vi.fn(async () => ({ running: 3, max: 10 }));
      clocked(running, { keepWarmMs: 30_000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(running).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(running).toHaveBeenCalledTimes(2);
    });
    it('does nothing when Start / Stop is off', async () => {
      vi.useFakeTimers();
      const running = vi.fn(async () => ({ running: 3, max: 10 }));
      clocked(running, { keepWarmMs: 30_000, allowStart: false });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(running).not.toHaveBeenCalled();
    });
  });
  it('host-run: counts with docker compose ls itself', async () => {
    const exec = vi.fn(async (file, args) => (args[1] === 'ls'
      ? { stdout: JSON.stringify([{ Name: 'a', Status: 'running(2)', ConfigFiles: '/h/a/docker-compose.yml' }]), stderr: '' }
      : { stdout: '', stderr: '' }));
    const app = createApp({ demos, catalog: { items: [] }, fetchFn, wait: async () => {}, allowStart: true, exec, maxRunningDemos: 10, pingProductsCheck: async () => [] });
    expect((await get(app)).body.runningLimit).toEqual({ running: 1, max: 10 });
  });
});

describe('a refused Start / Deploy reaches the page with the agent\'s words', () => {
  const refusal = { ok: false, error: 'too-many-running:13:10', output: '13 demos are running and the limit is 10. Stop some first (Stop all stops every one).' };
  it.each(['start', 'deploy'])('%s: passes the 409 and its output through unchanged', async (action) => {
    const agent = agentStub({ run: vi.fn(async () => ({ status: 409, body: refusal })) });
    const app = createApp({ demos: [{ ...demos[0], repo: 'https://github.com/curtismu7/a-LAB' }], catalog: { items: [] }, fetchFn, wait: async () => {}, allowStart: true, agent, inDocker: true, demoRoot: '/h' });
    const r = await post(app, `/api/demos/a/${action}`);
    expect(r.status).toBe(409);
    expect(r.body).toEqual(refusal);
    expect(agent.run).toHaveBeenCalledWith('a', action);
  });
});
