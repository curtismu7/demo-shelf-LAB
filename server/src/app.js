import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { composeArgs, createControlRouter } from './control.js';
import { createInstallState } from './install.js';
import { createPoller } from './poller.js';
import { createPingProducts } from './pingProducts.js';
import { hostedTags } from './tags.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

// Shell-safe display form of what Start runs, for the Copy button: change into the compose file's folder first, as Start does,
// then bring the app up, wait for its health endpoint (curl, bounded ~2 min), echo the URL so it stays on screen, and open the browser.
// The URL is printed BEFORE the open so a failed `open` still leaves it visible. `open` is macOS; elsewhere the user sees the URL.
const q = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

export function startScript({ composeFile, composeOverlays = [], url, healthPath = '/api/health' }) {
  if (!composeFile) return null;
  const cmd = [
    `cd ${q(path.dirname(composeFile))}`,
    `docker compose ${[composeFile, ...composeOverlays].flatMap((f) => ['-f', q(f)]).join(' ')} up -d`,
  ];
  if (url) {
    const safe = (s) => s.replace(/'/g, `'\\''`);
    const u = q(url);
    const health = q(url.replace(/\/$/, '') + (healthPath || '/api/health'));
    cmd.push(
      `echo "When it is up, the app is at: ${safe(url)}"`,
      `i=0; until curl -sfso /dev/null ${health} || [ $i -ge 24 ]; do i=$((i+1)); sleep 5; done`,
      `open ${u} 2>/dev/null || echo "Could not open the browser automatically. Open: ${safe(url)}"`,
    );
  }
  return cmd.join(' && ');
}

export const startCommand = (d) => startScript(d);

// One registry entry becomes one card per place it lives. A mock copy is polled and linked at mockUrl and
// has no compose file, so Start / Stop never applies to it. A "both" demo gets a second, "-mock" card.
export function expandWhere(demos) {
  return demos.flatMap((d) => {
    const where = d.where || 'installed';
    const installed = where !== 'mock' ? [{ ...d, where: 'installed' }] : [];
    const { composeFile, composeOverlays, ...rest } = d; // eslint-disable-line no-unused-vars
    const mock = where !== 'installed' ? [{ ...rest, ...(d.tags ? { tags: hostedTags(d.tags) } : {}), id: where === 'both' ? `${d.id}-mock` : d.id, url: d.mockUrl, where: 'mock' }] : [];
    return [...installed, ...mock];
  });
}

// install: 'installed' | 'not-installed' | 'unknown', plus imagesBuilt true | false | null. Only an installed copy with a compose file
// has an install state, and only when the host answered. A demo that answers its health probe is never "not-installed": it is running
// from somewhere else, whatever the registered path says.
export function installOf(d, status, map) {
  const unknown = { install: 'unknown', imagesBuilt: null };
  const r = d.where === 'installed' && d.composeFile ? map?.get(d.id) : null;
  if (!r) return unknown;
  const answers = status && status.state !== 'down' && status.reason !== 'not-polled';
  if (r.compose === 'missing') return answers ? { install: 'installed', imagesBuilt: null } : { install: 'not-installed', imagesBuilt: null };
  return { install: 'installed', imagesBuilt: r.images === 'built' ? true : r.images === 'missing' ? false : null };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// `loopbackOnly` guards against DNS rebinding: a loopback-bound shelf only answers to loopback Host names.
export function createApp({ demos: registry, catalog, tags, catalogTags = {}, allowStart = false, agent = null, inDocker = false, installSource = null, demoRoot = null, refreshWaitMs = 4000, loopbackOnly = true, webDist, fetchFn, exec, fileExists, shelfDir, now, random, wait, pingProductsCheck }) {
  const demos = expandWhere(registry);
  const app = express();
  app.disable('x-powered-by');
  app.set('case sensitive routing', true);
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    if (loopbackOnly && !LOOPBACK_HOSTS.has((req.headers.host || '').replace(/:\d+$/, '').toLowerCase())) return res.status(403).json({ error: 'bad-host' });
    next();
  });

  // demo-health/1 (docs/health-contract.md): public, GET only, no detail.
  app.get('/api/health', (req, res) => res.json({ schema: 'demo-health/1', at: new Date().toISOString(), state: 'ready', runtime: 'offline', demo: { id: 'demo-shelf-LAB', name: 'Demo Shelf LAB', version: VERSION } }));

  // Update notice from the meta-repo's UPDATES.md (owner-edited, fetched from
  // GitHub). Cached for 5 minutes; empty/failed fetch = no banner. The user's
  // update action is always the same: re-run the install command.
  // Release notes + fleet version from the meta-repo: VERSION (the family-wide
  // version, e.g. "2.1") and RELEASE_NOTES.md (what changed). The UI opens the
  // notes when the version differs from the last one the user dismissed.
  // Version semantics: MAJOR bump = breaking (new setup requirements, lab removals);
  // MINOR bump = new labs/features worth showing the What's-new panel.
  const metaBase = process.env.SHELF_META_URL
    || 'https://raw.githubusercontent.com/curtismu7/AI-DEMO-Standalone/main';
  const releasesUrl = `${metaBase}/RELEASE_NOTES.md`;
  const versionUrl = `${metaBase}/VERSION`;
  let releasesCache = { at: 0, body: null };
  app.get('/api/releases', async (req, res) => {
    const nowMs = Date.now();
    if (nowMs - releasesCache.at > 5 * 60 * 1000) {
      try {
        const [r, v] = await Promise.all([
          (fetchFn || fetch)(releasesUrl, { signal: AbortSignal.timeout(8000) }),
          (fetchFn || fetch)(versionUrl, { signal: AbortSignal.timeout(8000) }).catch(() => null),
        ]);
        const text = r.ok ? await r.text() : '';
        const version = v && v.ok ? (await v.text()).trim() : null;
        const marker = '<!-- SHELF RELEASES BELOW';
        const idx = text.indexOf(marker);
        const content = idx >= 0 ? text.slice(idx + text.slice(idx).indexOf('-->') + 3).trim() : text;
        releasesCache = { at: nowMs, body: { version: version || null, notes: content || null } };
      } catch {
        releasesCache = { at: nowMs, body: releasesCache.body ?? { version: null, notes: null } };
      }
    }
    res.set('Cache-Control', 'no-store');
    res.json({
      ...(releasesCache.body || { version: null, notes: null }),
      updateCommand: 'curl -fsSL https://raw.githubusercontent.com/curtismu7/AI-DEMO-Standalone/main/scripts/install.sh | bash',
    });
  });

  const noticeUrl = process.env.SHELF_NOTICE_URL
    || 'https://raw.githubusercontent.com/curtismu7/AI-DEMO-Standalone/main/UPDATES.md';
  let noticeCache = { at: 0, body: null };
  app.get('/api/notice', async (req, res) => {
    const nowMs = Date.now();
    if (nowMs - noticeCache.at > 5 * 60 * 1000) {
      try {
        const r = await (fetchFn || fetch)(noticeUrl, { signal: AbortSignal.timeout(8000) });
        const text = r.ok ? await r.text() : '';
        const marker = '<!-- SHELF NOTICE BELOW — text after this marker is shown to users -->';
        const idx = text.indexOf(marker);
        noticeCache = { at: nowMs, body: idx >= 0 ? text.slice(idx + marker.length).trim() : '' };
      } catch {
        noticeCache = { at: nowMs, body: noticeCache.body ?? '' };
      }
    }
    res.set('Cache-Control', 'no-store');
    res.json({ notice: noticeCache.body || null, updateCommand: 'curl -fsSL https://raw.githubusercontent.com/curtismu7/AI-DEMO-Standalone/main/scripts/install.sh | bash' });
  });

  const poller = createPoller({ getDemos: () => demos, fetchFn, now, random, wait });
  const install = createInstallState({ source: installSource, now });
  // Rule 20: which shared Ping products each demo needs, and whether they are shared-and-healthy.
  const checkPing = pingProductsCheck || createPingProducts({ now, exec });
  const catalogItems = catalog?.items || [];
  const byCatalogId = new Map(catalogItems.map((i) => [i.id, i]));

  async function shelf(results) {
    const inst = install.snapshot(); // cached; a stale one is refreshed in the background, never awaited here
    const pingNeeded = [...new Set(demos.flatMap((d) => d.pingProducts || []))];
    const pingStatuses = pingNeeded.length ? await checkPing(pingNeeded) : [];
    const pingMap = new Map(pingStatuses.map((p) => [p.product, p]));
    const registered = demos.map((d) => ({
      id: d.id,
      name: d.name,
      catalogId: d.catalogId ?? null,
      alsoCatalogIds: d.alsoCatalogIds ?? [],
      kind: d.kind ?? byCatalogId.get(d.catalogId)?.kind ?? null,
      group: byCatalogId.get(d.catalogId)?.group ?? null,
      composeFile: d.composeFile ?? null,
      startCommand: startCommand(d),
      description: d.description,
      tags: d.tags ?? [],
      url: d.url,
      where: d.where,
      wave: byCatalogId.get(d.catalogId)?.wave ?? null,
      canStart: allowStart && Boolean(d.composeFile),
      repo: d.repo ?? null,
      pingProducts: d.pingProducts ? (d.pingProducts.map((p) => pingMap.get(p) || { product: p, state: 'unknown' })) : [],
      ...installOf(d, results[d.id], inst.map),
      status: results[d.id] || { state: 'unknown', reason: 'not-polled' },
    }));
    const have = new Set(demos.flatMap((d) => [d.catalogId, ...(d.alsoCatalogIds ?? [])]).filter(Boolean));
    const planned = catalogItems
      .filter((i) => i.status === 'active' && !have.has(i.id))
      .map(({ id, name, kind, group, wave, seed }) => ({ id, name, kind, group, wave, seed, tags: catalogTags[id] ?? [], status: { state: 'planned' } }));
    // 'local' = the shelf runs Docker itself; 'up' / 'down' = the start agent a containerised shelf depends on.
    const agentState = agent ? await agent.ping() : 'local';
    return { schema: 'demo-shelf/1', generatedAt: new Date().toISOString(), installPending: inst.pending, startEnabled: allowStart, agent: agentState, groups: catalog?.groups || {}, tagGroups: tags?.groups || [], demos: registered, planned };
  }

  app.get('/api/shelf', async (req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json(await shelf(await poller.get())); } catch (e) { next(e); }
  });
  app.post('/api/shelf/refresh', async (req, res, next) => {
    try {
      // Refresh re-checks the install state too (the card says "press Refresh" after a clone), but waits only a few seconds for it;
      // a slower answer shows up on the page's quick re-poll (installPending stays true until it lands).
      let timer;
      const forced = install.force();
      await Promise.race([forced, new Promise((r) => { timer = setTimeout(r, refreshWaitMs); })]);
      clearTimeout(timer);
      res.set('Cache-Control', 'no-store').json(await shelf(await poller.refresh()));
    } catch (e) { next(e); }
  });

  if (allowStart) app.use('/api', createControlRouter({ express, getDemos: () => registry, onChange: (id) => { poller.invalidate(); install.invalidate(id); }, exec, fileExists, agent, inDocker, shelfDir, demoRoot }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'not-found' }));

  if (webDist && fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist));
    app.get('*', (req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    res.status(status).json({ error: status === 500 ? 'internal' : 'bad-request' });
  });
  return app;
}
