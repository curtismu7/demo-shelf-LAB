import { describe, expect, it, vi } from 'vitest';
import { createPoller, MAX_BODY, parseHealth, probeDemo } from '../src/poller.js';

const demo = { id: 'd', url: 'http://localhost:4500', healthPath: '/api/health' };
const good = { schema: 'demo-health/1', at: '2026-10-21T10:00:00Z', state: 'ready', runtime: 'offline', demo: { id: 'd', name: 'D', version: '1.0.0' } };
const json = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const page = (status = 200) => new Response('<html></html>', { status });

// fetch fake keyed by pathname
const fake = (routes) => vi.fn(async (url) => {
  const r = routes[new URL(url).pathname];
  if (r instanceof Error) throw r;
  return typeof r === 'function' ? r(url) : r ? r.clone() : new Response('', { status: 404 });
});

describe('probeDemo under a shared-host path prefix', () => {
  it('fetches the health path under the prefix, on the same origin', async () => {
    const f = fake({ '/mock-authorize/api/health': json(good), '/mock-authorize': page() });
    const r = await probeDemo({ id: 'm', url: 'https://mocks.example/mock-authorize', healthPath: '/api/health' }, { fetchFn: f, timeoutMs: 1000 });
    expect(r.state).toBe('ready');
    expect(f.mock.calls.map((c) => new URL(c[0]).pathname)).toContain('/mock-authorize/api/health');
    expect(f.mock.calls.every((c) => new URL(c[0]).origin === 'https://mocks.example')).toBe(true);
  });
});

describe('parseHealth', () => {
  it('accepts the contract and keeps only known fields', () => {
    const p = parseHealth(JSON.stringify({ ...good, secret: 'x', demo: { ...good.demo, extra: 1 } }));
    expect(p).toEqual({ state: 'ready', runtime: 'offline', reportedAt: good.at, demo: { id: 'd', name: 'D', version: '1.0.0' } });
  });
  it('unknown schema is unknown', () => {
    expect(parseHealth(JSON.stringify({ ...good, schema: 'demo-health/2' }))).toMatchObject({ state: 'unknown', reason: 'unknown-schema' });
  });
  it('bad state is unknown', () => {
    expect(parseHealth(JSON.stringify({ ...good, state: 'great' }))).toMatchObject({ state: 'unknown' });
  });
  it('drops oversized or wrong-typed fields', () => {
    const p = parseHealth(JSON.stringify({ ...good, runtime: 'cloud', at: 'x'.repeat(100), demo: { id: 5, name: 'n'.repeat(500), version: null } }));
    expect(p).toEqual({ state: 'ready', runtime: null, reportedAt: null, demo: { id: null, name: null, version: null } });
  });
  it('not JSON / not an object means no contract', () => {
    for (const t of ['<html>', '[]', 'null', '"x"', '{"error":"not_found"}']) expect(parseHealth(t)).toBeNull();
  });
});

describe('probeDemo', () => {
  it.each(['ready', 'needs-setup', 'broken', 'unknown'])('reports contract state %s', async (state) => {
    const f = fake({ '/api/health': json({ ...good, state }) });
    expect((await probeDemo(demo, { fetchFn: f })).state).toBe(state);
  });
  it('honours a contract body even on a 503', async () => {
    const f = fake({ '/api/health': json({ ...good, state: 'broken' }, 503) });
    expect((await probeDemo(demo, { fetchFn: f })).state).toBe('broken');
  });
  it('records lastChecked and latency', async () => {
    let t = 1_000;
    const r = await probeDemo(demo, { fetchFn: fake({ '/api/health': json(good) }), now: () => (t += 7) });
    expect(r.latencyMs).toBeGreaterThanOrEqual(7);
    expect(new Date(r.lastChecked).toString()).not.toBe('Invalid Date');
  });
  it('page loads but no health endpoint = up-no-contract', async () => {
    expect((await probeDemo(demo, { fetchFn: fake({ '/': page() }) })).state).toBe('up-no-contract');
  });
  it('SPA fallback html at the health path = up-no-contract', async () => {
    expect((await probeDemo(demo, { fetchFn: fake({ '/api/health': page(), '/': page() }) })).state).toBe('up-no-contract');
  });
  it('nothing answers = down', async () => {
    const f = fake({ '/api/health': new Error('ECONNREFUSED'), '/': new Error('ECONNREFUSED') });
    expect(await probeDemo(demo, { fetchFn: f })).toMatchObject({ state: 'down', reason: 'unreachable' });
  });
  it('page 500 and no contract = down', async () => {
    expect((await probeDemo(demo, { fetchFn: fake({ '/': page(500) }) }))).toMatchObject({ state: 'down', reason: 'http-5xx' });
  });
  it('body over the cap is unknown, and the read stops early', async () => {
    const big = () => json('{"schema":"demo-health/1","pad":"' + 'a'.repeat(MAX_BODY * 3) + '"}');
    expect(await probeDemo(demo, { fetchFn: fake({ '/api/health': big }) })).toMatchObject({ state: 'unknown', reason: 'oversized' });
  });
  it('uses manual redirects and times out requests', async () => {
    const f = fake({ '/api/health': json(good) });
    await probeDemo(demo, { fetchFn: f });
    expect(f.mock.calls[0][1].redirect).toBe('manual');
    expect(f.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  it('follows a redirect inside the origin', async () => {
    const f = fake({
      '/api/health': () => new Response(null, { status: 302, headers: { location: '/api/v2/health' } }),
      '/api/v2/health': json(good),
    });
    expect((await probeDemo(demo, { fetchFn: f })).state).toBe('ready');
  });
  it('never follows a redirect off the registered origin', async () => {
    const hits = [];
    const f = vi.fn(async (url) => {
      hits.push(url);
      if (new URL(url).origin !== demo.url) throw new Error('left the origin');
      return new Response(null, { status: 302, headers: { location: 'http://evil.example/x' } });
    });
    const r = await probeDemo(demo, { fetchFn: f });
    expect(hits.every((u) => u.startsWith(demo.url))).toBe(true);
    expect(r).toMatchObject({ state: 'down', reason: 'redirect-off-origin' });
  });
  it('a different port counts as off-origin', async () => {
    const away = () => new Response(null, { status: 302, headers: { location: 'http://localhost:9999/' } });
    const f = fake({ '/api/health': away, '/': away });
    expect((await probeDemo(demo, { fetchFn: f })).reason).toBe('redirect-off-origin');
  });
  it('gives up on a redirect loop', async () => {
    const f = fake({ '/api/health': () => new Response(null, { status: 302, headers: { location: '/api/health' } }) });
    expect((await probeDemo(demo, { fetchFn: f })).state).toBe('down');
  });
});

describe('createPoller', () => {
  const demos = Array.from({ length: 6 }, (_, i) => ({ ...demo, id: `d${i}` }));
  const base = (over = {}) => {
    let t = 0;
    const clock = { now: () => t, advance: (ms) => { t += ms; } };
    const fetchFn = vi.fn(async () => json(good));
    return { clock, fetchFn, poller: createPoller({ getDemos: () => demos, fetchFn, now: clock.now, random: () => 0.5, wait: async () => {}, ...over }) };
  };
  it('caches for 10 s so tabs do not multiply load', async () => {
    const { poller, fetchFn, clock } = base();
    await Promise.all([poller.get(), poller.get(), poller.get()]);
    expect(fetchFn).toHaveBeenCalledTimes(6);
    clock.advance(9_000);
    await poller.get();
    expect(fetchFn).toHaveBeenCalledTimes(6);
    clock.advance(1_500);
    await poller.get();
    expect(fetchFn).toHaveBeenCalledTimes(12);
  });
  it('refresh re-polls but is rate limited', async () => {
    const { poller, fetchFn, clock } = base();
    await poller.get();
    clock.advance(500);
    await poller.refresh();
    expect(fetchFn).toHaveBeenCalledTimes(6);
    clock.advance(2_000);
    await poller.refresh();
    expect(fetchFn).toHaveBeenCalledTimes(12);
  });
  it('caps concurrency', async () => {
    let live = 0;
    let peak = 0;
    const fetchFn = async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return json(good); };
    const { poller } = base({ fetchFn, concurrency: 2 });
    await poller.get();
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  });
  it('applies jitter before each probe', async () => {
    const waits = [];
    const { poller } = base({ random: () => 0.5, wait: async (ms) => { waits.push(ms); } });
    await poller.get();
    expect(waits).toHaveLength(6);
    expect(waits.every((w) => w > 0 && w < 200)).toBe(true);
  });
});
