// "Is this demo installed on this machine?" for the registered demos, answered where the files are (the host).
// Read-only: it looks for the registered compose file(s), then asks Docker (argv arrays, no shell) which images the compose file
// names and whether they exist locally. Ids come from the registry and are never used as paths. Every failure is "unknown".
import fs from 'node:fs';
import { composeArgs, defaultExec, isShelfItself, orbstackGuard } from './control.js';

export const IMAGE_CHECK_TIMEOUT_MS = 8000; // per docker call
export const INSTALL_TTL_MS = 30_000;
export const INSTALL_CONCURRENCY = 2; // demos checked at once
export const INSTALL_DEADLINE_MS = 20_000; // how long checkAll() waits before answering "unknown" for the rest
const MAX_IMAGES = 24;
// What `docker compose config --images` prints is the compose file's text, so check it before it becomes an argument.
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;

export const COMPOSE_STATES = new Set(['present', 'missing']);
export const IMAGE_STATES = new Set(['built', 'missing', 'unknown']);

const withTimeout = (fn, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), ms);
  Promise.resolve().then(fn).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

export const composeState = (demo, fileExists) => ([demo.composeFile, ...(demo.composeOverlays || [])].every((f) => fileExists(f)) ? 'present' : 'missing');

// 'built' | 'missing' | 'unknown'
async function imageState(demo, { exec, shelfDir, timeoutMs }) {
  if (isShelfItself(demo, shelfDir)) return 'unknown';
  const run = (args) => withTimeout(() => exec('docker', args, { timeoutMs }), timeoutMs);
  try {
    if ((await orbstackGuard((f, a) => run(a))) !== 'ok') return 'unknown';
    const refs = [...new Set((await run(composeArgs(demo, 'images'))).stdout.split('\n').map((l) => l.trim()).filter(Boolean))];
    if (!refs.length || refs.length > MAX_IMAGES || !refs.every((r) => IMAGE_REF.test(r))) return 'unknown';
    try {
      await run(['image', 'inspect', ...refs]);
      return 'built';
    } catch (e) {
      return /no such image/i.test(String(e?.stderr ?? '')) ? 'missing' : 'unknown';
    }
  } catch {
    return 'unknown';
  }
}

// `getDemos()` returns the registered installed demos (it may throw). Results are cached per id and invalidated by invalidate(id).
export function createInstallChecker({ getDemos, exec = defaultExec, fileExists = fs.existsSync, shelfDir = null, now = () => Date.now(), timeoutMs = IMAGE_CHECK_TIMEOUT_MS, ttlMs = INSTALL_TTL_MS, concurrency = INSTALL_CONCURRENCY, deadlineMs = INSTALL_DEADLINE_MS }) {
  const cache = new Map(); // id -> { at, images }
  const inflight = new Map(); // id -> Promise<images>
  const epoch = new Map(); // id -> bumped by invalidate(), so a check that started earlier is not cached
  let active = 0;
  const waiting = [];
  const slot = () => new Promise((resolve) => { const go = () => { active++; resolve(); }; if (active < concurrency) go(); else waiting.push(go); });
  const release = () => { active--; waiting.shift()?.(); };

  function images(demo) {
    const hit = cache.get(demo.id);
    if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.images);
    if (inflight.has(demo.id)) return inflight.get(demo.id);
    const gen = epoch.get(demo.id) || 0;
    const p = (async () => {
      await slot();
      try { return await imageState(demo, { exec, shelfDir, timeoutMs }); } finally { release(); }
    })().then((state) => {
      if ((epoch.get(demo.id) || 0) === gen) cache.set(demo.id, { at: now(), images: state });
      return state;
    }).finally(() => { if (inflight.get(demo.id) === p) inflight.delete(demo.id); });
    inflight.set(demo.id, p);
    return p;
  }

  return {
    invalidate(id) {
      cache.delete(id);
      inflight.delete(id);
      epoch.set(id, (epoch.get(id) || 0) + 1);
    },
    // Map id -> { compose, images } for every registered demo that has a compose file. Waits at most deadlineMs; a check still
    // running then reports images "unknown" (and goes on to fill the cache for the next call).
    async checkAll() {
      const out = new Map();
      const pending = [];
      for (const d of getDemos()) {
        if (!d.composeFile) continue;
        const entry = { compose: composeState(d, fileExists), images: 'unknown' };
        out.set(d.id, entry);
        if (entry.compose === 'present') pending.push(images(d).then((s) => { entry.images = s; }));
      }
      let timer;
      await Promise.race([Promise.all(pending), new Promise((r) => { timer = setTimeout(r, deadlineMs); })]);
      clearTimeout(timer);
      return new Map([...out].map(([id, e]) => [id, { ...e }])); // a copy: a late check must not change what was answered
    },
  };
}

// The shelf's side of the same thing (host-run: in-process; in a container: the start agent's answer). Never awaited by a request.
// source: { fetch(): Promise<Map|null>, invalidate?(id) }. snapshot() returns what is cached and starts a background refresh when stale.
// invalidate(id) keeps the old answer but marks it stale (pending), so a card does not blank until the next poll; force() is the
// Refresh button: it re-fetches now and resolves when the fresh answer is in.
export function createInstallState({ source, ttlMs = INSTALL_TTL_MS, failMs = 5000, now = () => Date.now() }) {
  let entry = null; // { at, map: Map|null }
  let stale = false;
  let inflight = null;
  let forcing = 0;
  let epoch = 0;
  function refresh() {
    if (inflight || !source) return inflight;
    const gen = epoch;
    const p = Promise.resolve().then(() => source.fetch()).then((m) => (m instanceof Map ? m : null), () => null).then((map) => {
      if (gen === epoch) { entry = { at: now(), map }; stale = false; }
    }).finally(() => { if (inflight === p) inflight = null; });
    inflight = p;
    return p;
  }
  return {
    snapshot() {
      if (!source) return { map: null, pending: false };
      if (!entry || stale || now() - entry.at >= (entry.map ? ttlMs : failMs)) refresh();
      return { map: entry?.map ?? null, pending: !entry || stale || forcing > 0 };
    },
    invalidate(id) {
      source?.invalidate?.(id);
      epoch++;
      stale = true;
    },
    async force() {
      if (!source) return;
      forcing++;
      try {
        if (inflight) await inflight; // one that started before this call may predate the change being looked for
        await (refresh() ?? inflight);
      } finally { forcing--; }
    },
  };
}
