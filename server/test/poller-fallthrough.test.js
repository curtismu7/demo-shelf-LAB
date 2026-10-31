import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createPoller, probeDemo, TIMEOUT_MS } from '../src/poller.js';

const good = { schema: 'demo-health/1', at: '2026-10-21T10:00:00Z', state: 'ready', runtime: 'offline', demo: { id: 'd', name: 'D', version: '1.0.0' } };
const servers = [];
// handlers: { health, page } each (req, res) => void
async function fakeDemo({ health, page }) {
  const s = http.createServer((req, res) => (req.url === '/api/health' ? health : page)(req, res));
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { id: 'd', url: `http://localhost:${s.address().port}`, healthPath: '/api/health' };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
});

const hang = () => {};
const pageOk = (req, res) => res.end('<html>hi</html>');
const send = (status, body) => (req, res) => { res.statusCode = status; res.end(body); };
const drop = (req) => req.socket.destroy();

describe('probeDemo falls through to the page when health fails', () => {
  // 1 s, not 250 ms: the page request uses the same timeout and must not time out on a loaded machine.
  const T = { timeoutMs: 1000 };
  it('health hangs, page ok: up-no-contract', async () => {
    expect((await probeDemo(await fakeDemo({ health: hang, page: pageOk }), T)).state).toBe('up-no-contract');
  });
  it('health 500, page ok: up-no-contract', async () => {
    expect((await probeDemo(await fakeDemo({ health: send(500, 'boom'), page: pageOk }), T)).state).toBe('up-no-contract');
  });
  it('health closes the connection, page ok: up-no-contract', async () => {
    expect((await probeDemo(await fakeDemo({ health: drop, page: pageOk }), T)).state).toBe('up-no-contract');
  });
  it('health is not JSON, page ok: up-no-contract', async () => {
    expect((await probeDemo(await fakeDemo({ health: send(200, '<html>'), page: pageOk }), T)).state).toBe('up-no-contract');
  });
  it('both fail: down', async () => {
    const r = await probeDemo(await fakeDemo({ health: drop, page: drop }), T);
    expect(r).toMatchObject({ state: 'down', reason: 'unreachable' });
  });
  it('health ok: ready', async () => {
    expect((await probeDemo(await fakeDemo({ health: send(200, JSON.stringify(good)), page: pageOk }), T)).state).toBe('ready');
  });
  it('both hang: down, bounded by the timeout (one timeout per request)', async () => {
    const d = await fakeDemo({ health: hang, page: hang });
    const t0 = Date.now();
    const r = await probeDemo(d, { timeoutMs: 200 });
    const took = Date.now() - t0;
    expect(r.state).toBe('down');
    expect(took).toBeGreaterThanOrEqual(350);
    expect(took).toBeLessThan(1500);
  });
});

describe('poll timeout', () => {
  it('the default is a few seconds, not effectively infinite', () => {
    expect(TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
    expect(TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
  it('the poller passes its timeout to each probe', async () => {
    const d = await fakeDemo({ health: hang, page: hang });
    const t0 = Date.now();
    const byId = await createPoller({ getDemos: () => [d], timeoutMs: 150, wait: async () => {} }).get();
    expect(byId.d.state).toBe('down');
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
