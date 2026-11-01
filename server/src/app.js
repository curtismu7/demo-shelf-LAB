import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { composeArgs, createControlRouter } from './control.js';
import { createPoller } from './poller.js';
import { hostedTags } from './tags.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

// Shell-safe display form of the exact command Start runs, for the Copy button.
const q = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
export const startCommand = (d) => (d.composeFile ? ['docker', ...composeArgs({ composeOverlays: [], ...d }, 'start')].map(q).join(' ') : null);

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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// `loopbackOnly` guards against DNS rebinding: a loopback-bound shelf only answers to loopback Host names.
export function createApp({ demos: registry, catalog, tags, catalogTags = {}, allowStart = false, agent = null, inDocker = false, onlineOnly = false, loopbackOnly = true, webDist, fetchFn, exec, fileExists, now, random, wait }) {
  const expanded = expandWhere(registry);
  // Online-only (the Docker image): installed copies point at localhost, which inside a container is the container itself, so only the
  // hosted copies are listed. Their catalog rows are still "registered", so they do not come back as planned ideas.
  const demos = onlineOnly ? expanded.filter((d) => d.where === 'mock') : expanded;
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    if (loopbackOnly && !LOOPBACK_HOSTS.has((req.headers.host || '').replace(/:\d+$/, '').toLowerCase())) return res.status(403).json({ error: 'bad-host' });
    next();
  });

  // demo-health/1 (docs/health-contract.md): public, GET only, no detail.
  app.get('/api/health', (req, res) => res.json({ schema: 'demo-health/1', at: new Date().toISOString(), state: 'ready', runtime: 'offline', demo: { id: 'demo-shelf-LAB', name: 'Demo Shelf LAB', version: VERSION } }));

  const poller = createPoller({ getDemos: () => demos, fetchFn, now, random, wait });
  const catalogItems = catalog?.items || [];
  const byCatalogId = new Map(catalogItems.map((i) => [i.id, i]));

  async function shelf(results) {
    const registered = demos.map((d) => ({
      id: d.id,
      name: d.name,
      catalogId: d.catalogId ?? null,
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
      status: results[d.id] || { state: 'unknown', reason: 'not-polled' },
    }));
    const have = new Set(expanded.map((d) => d.catalogId).filter(Boolean));
    const planned = catalogItems
      .filter((i) => i.status === 'active' && !have.has(i.id))
      .map(({ id, name, kind, group, wave, seed }) => ({ id, name, kind, group, wave, seed, tags: catalogTags[id] ?? [], status: { state: 'planned' } }));
    // 'local' = the shelf runs Docker itself; 'up' / 'down' = the start agent a containerised shelf depends on.
    const agentState = agent ? await agent.ping() : 'local';
    return { schema: 'demo-shelf/1', generatedAt: new Date().toISOString(), startEnabled: allowStart, agent: agentState, groups: catalog?.groups || {}, tagGroups: tags?.groups || [], demos: registered, planned };
  }

  app.get('/api/shelf', async (req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json(await shelf(await poller.get())); } catch (e) { next(e); }
  });
  app.post('/api/shelf/refresh', async (req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json(await shelf(await poller.refresh())); } catch (e) { next(e); }
  });

  if (allowStart) app.use('/api', createControlRouter({ express, getDemos: () => registry, onChange: () => poller.invalidate(), exec, fileExists, agent, inDocker }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'not-found' }));

  if (webDist && fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist));
    app.get('*', (req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    res.status(500).json({ error: 'internal' });
  });
  return app;
}
