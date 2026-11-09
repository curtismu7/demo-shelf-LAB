// New labs in the family: submodules (paths standalone/<dir>) that appeared in the meta-repo's .gitmodules within the last
// 48 hours, rolling from the request. GitHub use is kept small (unauthenticated limit is 60/hour per IP): one API call lists
// the .gitmodules commits inside the window and, when there are any, one more finds the last commit before it (the
// baseline). Every .gitmodules body comes from raw.githubusercontent.com. So one refresh costs 2 API calls (1 when the
// window has no commits). The result is cached 10 minutes; on any failure the last good result (or an empty one) stays.
const HOUR = 60 * 60 * 1000;
const META_RAW = 'https://raw.githubusercontent.com/curtismu7/AI-DEMO-Standalone';
const META_API = 'https://api.github.com/repos/curtismu7/AI-DEMO-Standalone';
const DEMOS_URL = 'https://raw.githubusercontent.com/curtismu7/demo-shelf-LAB/main/data/demos.json';
const DIR = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;

// The lab folders named in a .gitmodules body: `path = standalone/<dir>` lines only.
export function submoduleDirs(text) {
  const dirs = new Set();
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*path\s*=\s*standalone\/([^/\s]+)\s*$/.exec(line);
    if (m && DIR.test(m[1])) dirs.add(m[1]);
  }
  return dirs;
}

const segments = (p) => String(p || '').split(/[\\/]/).filter(Boolean);

export function createNewApps({ registry = [], fetchFn, now = () => Date.now(), env = process.env, windowHours = 48, ttlMs = 10 * 60 * 1000 } = {}) {
  const rawBase = (env.SHELF_META_RAW_BASE || META_RAW).replace(/\/$/, '');
  const apiBase = (env.SHELF_META_API_URL || META_API).replace(/\/$/, '');
  const demosUrl = env.SHELF_DEMOS_URL || DEMOS_URL;
  const f = (url, init = {}) => (fetchFn || fetch)(url, { signal: AbortSignal.timeout(8000), ...init });
  const api = async (pathAndQuery) => {
    const r = await f(`${apiBase}${pathAndQuery}`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(`github api ${r.status}`);
    const body = await r.json();
    if (!Array.isArray(body)) throw new Error('github api: not a list');
    return body;
  };
  const raw = async (url) => {
    const r = await f(url);
    if (!r.ok) throw new Error(`raw ${r.status}`);
    return r.text();
  };

  async function compute(nowMs) {
    const since = new Date(nowMs - windowHours * HOUR).toISOString();
    const inWindow = await api(`/commits?path=.gitmodules&sha=main&since=${encodeURIComponent(since)}&per_page=100`);
    const commits = inWindow
      .map((c) => ({ sha: c?.sha, date: c?.commit?.committer?.date || c?.commit?.author?.date }))
      .filter((c) => SHA.test(String(c.sha)) && !Number.isNaN(Date.parse(c.date)))
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date)); // oldest first
    if (!commits.length) return [];
    const before = await api(`/commits?path=.gitmodules&sha=main&until=${encodeURIComponent(since)}&per_page=1`);
    const baseSha = SHA.test(String(before[0]?.sha)) ? before[0].sha : null;
    const [baseline, ...sets] = await Promise.all([
      baseSha ? raw(`${rawBase}/${baseSha}/.gitmodules`).then(submoduleDirs) : Promise.resolve(new Set()),
      ...commits.map((c) => raw(`${rawBase}/${c.sha}/.gitmodules`).then(submoduleDirs)),
    ]);
    const latest = sets[sets.length - 1];
    const added = [...latest].filter((d) => !baseline.has(d));
    let shelfSeed = [];
    try {
      const seed = JSON.parse(await raw(demosUrl));
      if (Array.isArray(seed?.demos)) shelfSeed = seed.demos;
    } catch { /* names fall back to the local registry, then the folder name */ }
    return added.map((dir) => {
      const addedAt = commits[sets.findIndex((s) => s.has(dir))].date;
      const remote = shelfSeed.find((d) => segments(d?.composeFile)[0] === dir);
      const local = registry.find((d) => segments(d?.composeFile).includes(dir));
      const pick = remote || local;
      return {
        id: (typeof pick?.id === 'string' && pick.id) || dir,
        dir,
        name: (typeof pick?.name === 'string' && pick.name) || dir,
        description: (typeof pick?.description === 'string' && pick.description) || '',
        addedAt: new Date(addedAt).toISOString(),
        onThisMachine: Boolean(local),
      };
    });
  }

  let cache = { at: 0, apps: [] };
  let inflight = null;
  async function get() {
    const nowMs = now();
    if (cache.at === 0 || nowMs - cache.at >= ttlMs) {
      inflight ||= compute(nowMs)
        .then((apps) => { cache = { at: nowMs, apps }; })
        .catch(() => { cache = { ...cache, at: nowMs }; }) // keep the last good list; retry after the TTL
        .finally(() => { inflight = null; });
      await inflight;
    }
    // Rolling window at serve time: a cached app that has aged past 48 hours drops off without a refetch.
    const sinceMs = nowMs - windowHours * HOUR;
    const apps = cache.apps.filter((a) => Date.parse(a.addedAt) >= sinceMs).sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt));
    return { windowHours, since: new Date(sinceMs).toISOString(), apps };
  }
  return { get };
}
