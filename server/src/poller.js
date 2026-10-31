// Polls registered demos for health. The shelf's SERVER does this, so no browser CORS is involved.
// Only registered URLs are ever fetched (callers pass registry entries, never user input), redirects
// are followed by hand and only within the registered origin, bodies are capped, and results are
// cached so many open tabs do not multiply the load.
export const TIMEOUT_MS = 3000;
export const MAX_BODY = 4096;
export const CACHE_MS = 10_000;
export const MIN_REFRESH_MS = 2000;
const CONCURRENCY = 4;
const JITTER_MS = 150;
const MAX_HOPS = 3;

const STATES = new Set(['ready', 'needs-setup', 'broken', 'unknown']);
const RUNTIMES = new Set(['offline', 'live']);
const short = (v, n) => (typeof v === 'string' && v.length > 0 && v.length <= n ? v : null);

// Strict demo-health/1 check. Keeps only known fields; anything off-contract is 'unknown'.
export function parseHealth(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  if (j.schema === undefined) return null; // JSON with no schema field is not a health document (e.g. a JSON 404)
  if (j.schema !== 'demo-health/1') return { state: 'unknown', reason: 'unknown-schema' };
  if (!STATES.has(j.state)) return { state: 'unknown', reason: 'bad-state' };
  const at = typeof j.at === 'string' && j.at.length <= 40 && !Number.isNaN(Date.parse(j.at)) ? j.at : null;
  const d = j.demo && typeof j.demo === 'object' && !Array.isArray(j.demo) ? j.demo : {};
  return {
    state: j.state,
    runtime: RUNTIMES.has(j.runtime) ? j.runtime : null,
    reportedAt: at,
    demo: { id: short(d.id, 64), name: short(d.name, 80), version: short(d.version, 32) },
  };
}

// Reads at most MAX_BODY bytes. Returns { text, truncated }.
async function readCapped(res) {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) { truncated = true; await reader.cancel().catch(() => {}); break; }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

// GET with manual redirects, never leaving `origin`. Returns { status, text, truncated } or { offOrigin: true }.
async function getWithinOrigin(fetchFn, start, origin, timeoutMs) {
  let url = start;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await fetchFn(url, { method: 'GET', redirect: 'manual', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel?.().catch(() => {});
      const loc = res.headers.get('location');
      let next;
      try { next = new URL(loc, url); } catch { return { offOrigin: true }; }
      if (next.origin !== origin) return { offOrigin: true };
      url = next.href;
      continue;
    }
    return { status: res.status, ...(await readCapped(res)) };
  }
  return { offOrigin: true };
}

// Each request (health, then page) gets its own timeoutMs, so the worst case is about twice that.
export async function probeDemo(demo, { fetchFn = fetch, now = () => Date.now(), timeoutMs = TIMEOUT_MS } = {}) {
  const base = new URL(demo.url);
  const origin = base.origin;
  // A mock under a shared-host path prefix (/<mock-name>) keeps the prefix; a root-served demo keeps the health path as it is.
  const prefix = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  const t0 = now();
  const done = (r) => ({ ...r, lastChecked: new Date(now()).toISOString(), latencyMs: now() - t0 });
  try {
    // Any health failure (timeout, network error, bad body) means "no usable contract": fall through to the page.
    const h = await getWithinOrigin(fetchFn, new URL(`${prefix}${demo.healthPath.replace(/^\//, '')}`, origin).href, origin, timeoutMs).catch(() => ({ offOrigin: true }));
    if (!h.offOrigin) {
      if (h.truncated) return done({ state: 'unknown', reason: 'oversized' });
      const parsed = parseHealth(h.text);
      if (parsed) return done(parsed);
    }
    // No usable contract: does the page itself load?
    const p = await getWithinOrigin(fetchFn, origin + '/', origin, timeoutMs);
    if (p.offOrigin) return done({ state: 'down', reason: 'redirect-off-origin' });
    if (p.status >= 200 && p.status < 300) return done({ state: 'up-no-contract' });
    return done({ state: 'down', reason: `http-${p.status >= 500 ? '5xx' : p.status}` });
  } catch {
    return done({ state: 'down', reason: 'unreachable' });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cached poller. get() reuses a result younger than CACHE_MS; refresh() re-polls but not more often than MIN_REFRESH_MS.
export function createPoller({ getDemos, fetchFn = fetch, timeoutMs = TIMEOUT_MS, now = () => Date.now(), random = Math.random, wait = sleep, concurrency = CONCURRENCY }) {
  let cache = null; // { at, byId }
  let inflight = null;

  async function pollAll() {
    const demos = getDemos();
    const byId = {};
    let next = 0;
    async function worker() {
      while (next < demos.length) {
        const d = demos[next++];
        await wait(Math.floor(random() * JITTER_MS));
        byId[d.id] = await probeDemo(d, { fetchFn, now, timeoutMs });
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, demos.length) }, worker));
    return { at: now(), byId };
  }

  function run() {
    if (!inflight) inflight = pollAll().then((r) => { cache = r; return r; }).finally(() => { inflight = null; });
    return inflight;
  }

  return {
    async get() {
      if (cache && now() - cache.at < CACHE_MS) return cache.byId;
      return (await run()).byId;
    },
    async refresh() {
      if (cache && now() - cache.at < MIN_REFRESH_MS) return cache.byId;
      return (await run()).byId;
    },
    invalidate() { cache = null; },
  };
}
