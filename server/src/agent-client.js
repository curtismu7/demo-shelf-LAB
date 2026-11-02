import { COMPOSE_STATES, IMAGE_STATES } from './install.js';

// The shelf's side of the start agent: asks it to start or stop a registered demo, and whether it is running.
const RUN_TIMEOUT_MS = 70_000; // a little over the agent's own 60 s compose timeout
const PING_TIMEOUT_MS = 1500;
const PING_CACHE_MS = 5000;
const INSTALLS_TIMEOUT_MS = 30_000; // the agent answers within about 20 s even if Docker hangs

export function createAgentClient({ url, token, fetchFn = fetch, now = () => Date.now() }) {
  const base = url.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${token}` };
  let ping = null; // { at, state }

  return {
    // Returns { status, body } in the same shape as runCompose, so the control router treats both the same way.
    async run(id, action) {
      let res;
      try {
        res = await fetchFn(`${base}/v1/demos/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers, signal: AbortSignal.timeout(RUN_TIMEOUT_MS) });
      } catch {
        return { status: 503, body: { ok: false, error: 'agent-not-running' } };
      }
      const body = await res.json().catch(() => null);
      if (res.status === 401) return { status: 502, body: { ok: false, error: 'agent-token-rejected' } };
      if (!body || typeof body !== 'object') return { status: 502, body: { ok: false, error: 'agent-bad-reply' } };
      return { status: res.status, body };
    },
    // Map id -> { compose, images } from the agent, or null on any failure (not running, old agent, bad reply). Only known values are kept.
    async installs() {
      try {
        const res = await fetchFn(`${base}/v1/installs`, { headers, signal: AbortSignal.timeout(INSTALLS_TIMEOUT_MS) });
        if (!res.ok) return null;
        const body = await res.json();
        if (!body?.installs || typeof body.installs !== 'object') return null;
        const out = new Map();
        for (const [id, v] of Object.entries(body.installs)) {
          if (COMPOSE_STATES.has(v?.compose) && IMAGE_STATES.has(v?.images)) out.set(id, { compose: v.compose, images: v.images });
        }
        return out;
      } catch {
        return null;
      }
    },
    // 'up', 'down' (nothing answers) or 'token-rejected' (it answers but refuses our token). Cached for a few seconds so many open tabs do not multiply the checks.
    async ping() {
      if (ping && now() - ping.at < PING_CACHE_MS) return ping.state;
      let state = 'down';
      try {
        const res = await fetchFn(`${base}/v1/health`, { headers, signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
        state = res.ok ? 'up' : res.status === 401 ? 'token-rejected' : 'down';
      } catch { /* not running */ }
      ping = { at: now(), state };
      return state;
    },
  };
}
