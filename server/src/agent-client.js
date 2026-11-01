// The shelf's side of the start agent: asks it to start or stop a registered demo, and whether it is running.
const RUN_TIMEOUT_MS = 70_000; // a little over the agent's own 60 s compose timeout
const PING_TIMEOUT_MS = 1500;
const PING_CACHE_MS = 5000;

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
