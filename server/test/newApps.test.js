import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createNewApps, submoduleDirs } from '../src/newApps.js';
import { createApp } from '../src/app.js';

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-11-09T12:00:00Z');
const env = { SHELF_META_RAW_BASE: 'https://raw.example/meta', SHELF_META_API_URL: 'https://api.example/meta', SHELF_DEMOS_URL: 'https://raw.example/shelf/demos.json' };
const sha = (n) => String(n).repeat(40).slice(0, 40);
const mods = (...dirs) => dirs.map((d) => `[submodule "standalone/${d}"]\n\tpath = standalone/${d}\n\turl = https://github.com/x/${d}.git\n`).join('');
const iso = (hoursAgo) => new Date(NOW - hoursAgo * HOUR).toISOString();
const commit = (n, hoursAgo) => ({ sha: sha(n), commit: { committer: { date: iso(hoursAgo) } } });
const seed = { demos: [{ id: 'b-lab', name: 'B Lab', description: 'the b one', composeFile: 'b-LAB/docker-compose.yml' }] };

// window: commits newest first, as GitHub returns them; base: the last commit before the window; files: sha -> .gitmodules
function gh({ window = [], base = [], files = {}, demos = seed, fail = false } = {}) {
  return vi.fn(async (url) => {
    if (fail) throw new Error('offline');
    const u = String(url);
    if (u.startsWith('https://api.example/meta/commits?')) {
      const q = new URL(u).searchParams;
      expect(q.get('path')).toBe('.gitmodules');
      expect(q.get('sha')).toBe('main');
      return new Response(JSON.stringify(q.has('since') ? window : base));
    }
    if (u === env.SHELF_DEMOS_URL) return new Response(JSON.stringify(demos));
    const m = /^https:\/\/raw\.example\/meta\/([0-9a-f]{40})\/\.gitmodules$/.exec(u);
    if (m && files[m[1]] != null) return new Response(files[m[1]]);
    return new Response('nope', { status: 404 });
  });
}
const apiCalls = (f) => f.mock.calls.filter(([u]) => String(u).startsWith('https://api.example/')).length;

describe('submoduleDirs', () => {
  it('reads standalone/<dir> paths only', () => {
    expect([...submoduleDirs(`${mods('a-LAB', 'b-LAB')}[submodule "x"]\n\tpath = shared/x\n`)]).toEqual(['a-LAB', 'b-LAB']);
  });
});

describe('createNewApps', () => {
  it('lists a lab added inside the window, newest first, with names from the shelf seed and onThisMachine from the registry', async () => {
    const fetchFn = gh({
      window: [commit(2, 3), commit(1, 20)],
      base: [commit(9, 60)],
      files: { [sha(9)]: mods('old-LAB'), [sha(1)]: mods('old-LAB', 'a-LAB'), [sha(2)]: mods('old-LAB', 'a-LAB', 'b-LAB') },
    });
    const registry = [{ id: 'a-lab', name: 'A local', description: 'from the local registry', composeFile: '/Users/x/a-LAB/docker-compose.yml' }];
    const r = await createNewApps({ registry, fetchFn, env, now: () => NOW }).get();
    expect(r.windowHours).toBe(48);
    expect(r.since).toBe(iso(48));
    expect(r.apps).toEqual([
      { id: 'b-lab', dir: 'b-LAB', name: 'B Lab', description: 'the b one', addedAt: iso(3), onThisMachine: false },
      { id: 'a-lab', dir: 'a-LAB', name: 'A local', description: 'from the local registry', addedAt: iso(20), onThisMachine: true },
    ]);
    expect(apiCalls(fetchFn)).toBe(2);
  });

  it('does not list a lab that was there before the window, and falls back to the folder name', async () => {
    const fetchFn = gh({
      window: [commit(1, 5)],
      base: [commit(9, 50)],
      files: { [sha(9)]: mods('old-LAB'), [sha(1)]: mods('old-LAB', 'new-LAB') },
      demos: { demos: [] },
    });
    const r = await createNewApps({ fetchFn, env, now: () => NOW }).get();
    expect(r.apps.map((a) => [a.id, a.name, a.onThisMachine])).toEqual([['new-LAB', 'new-LAB', false]]);
  });

  it('does not list a lab added and then removed inside the window', async () => {
    const fetchFn = gh({
      window: [commit(2, 2), commit(1, 10)],
      base: [commit(9, 50)],
      files: { [sha(9)]: mods('old-LAB'), [sha(1)]: mods('old-LAB', 'gone-LAB'), [sha(2)]: mods('old-LAB') },
    });
    expect((await createNewApps({ fetchFn, env, now: () => NOW }).get()).apps).toEqual([]);
  });

  it('costs one API call when the window has no .gitmodules commits', async () => {
    const fetchFn = gh({ window: [] });
    expect((await createNewApps({ fetchFn, env, now: () => NOW }).get()).apps).toEqual([]);
    expect(apiCalls(fetchFn)).toBe(1);
  });

  it('caches for 10 minutes, then refetches; a cached app ages out of the rolling window without a refetch', async () => {
    let t = NOW;
    const fetchFn = gh({ window: [commit(1, 47.99)], base: [], files: { [sha(1)]: mods('a-LAB') } });
    const na = createNewApps({ fetchFn, env, now: () => t });
    expect((await na.get()).apps).toHaveLength(1);
    const calls = fetchFn.mock.calls.length;
    t += 2 * 60 * 1000; // 2 min later: cached, but the app is now 48h+ old
    const r = await na.get();
    expect(fetchFn.mock.calls.length).toBe(calls);
    expect(r.apps).toEqual([]);
    t = NOW + 10 * 60 * 1000;
    await na.get();
    expect(fetchFn.mock.calls.length).toBeGreaterThan(calls);
  });

  it('keeps the last good list when GitHub fails, and is empty (not an error) when it never worked', async () => {
    let t = NOW;
    let fail = false;
    const ok = gh({ window: [commit(1, 5)], base: [], files: { [sha(1)]: mods('a-LAB') } });
    const fetchFn = vi.fn(async (...a) => { if (fail) throw new Error('offline'); return ok(...a); });
    const na = createNewApps({ fetchFn, env, now: () => t });
    expect((await na.get()).apps.map((a) => a.dir)).toEqual(['a-LAB']);
    fail = true;
    t += 11 * 60 * 1000;
    expect((await na.get()).apps.map((a) => a.dir)).toEqual(['a-LAB']);
    const rateLimited = vi.fn(async () => new Response('{"message":"API rate limit exceeded"}', { status: 403 }));
    expect((await createNewApps({ fetchFn: rateLimited, env, now: () => NOW }).get()).apps).toEqual([]);
  });
});

describe('GET /api/new-apps', () => {
  it('answers 200 with the list, and 200 empty when GitHub is down', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      const fetchFn = gh({ window: [commit(1, 5)], base: [], files: { [sha(1)]: mods('b-LAB') } });
      const r = await request(createApp({ demos: [], catalog: { items: [] }, fetchFn, now: () => NOW })).get('/api/new-apps').set('Host', 'localhost:4400');
      expect(r.status).toBe(200);
      expect(r.body.apps.map((a) => a.id)).toEqual(['b-lab']);
      const down = await request(createApp({ demos: [], catalog: { items: [] }, fetchFn: gh({ fail: true }), now: () => NOW })).get('/api/new-apps').set('Host', 'localhost:4400');
      expect(down.status).toBe(200);
      expect(down.body).toMatchObject({ windowHours: 48, apps: [] });
    } finally {
      process.env = saved;
    }
  });
});
