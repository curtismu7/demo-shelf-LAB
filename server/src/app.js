import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { composeArgs, createControlRouter, defaultExec, runningDemos } from './control.js';
import { createInstallState } from './install.js';
import { createPoller } from './poller.js';
import { createNewApps } from './newApps.js';
import { createPingProducts } from './pingProducts.js';
import { hostedTags } from './tags.js';
import { isNewDemo, NEW_WINDOW_HOURS } from './registry.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

// Shell-safe display form of what Start runs, for the Copy button: change into the compose file's folder first, as Start does,
// then bring the app up, wait for its health endpoint (curl, bounded ~2 min), echo the URL so it stays on screen, and open the browser.
// The URL is printed BEFORE the open so a failed `open` still leaves it visible. `open` is macOS; elsewhere the user sees the URL.
const q = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

// The URL Open goes to: the registered origin plus openPath when one is set.
export const openUrl = ({ url, openPath }) => (url && openPath ? url.replace(/\/$/, '') + openPath : url);

export function startScript({ composeFile, composeOverlays = [], url, openPath, healthPath = '/api/health' }) {
  if (!composeFile) return null;
  const cmd = [
    `cd ${q(path.dirname(composeFile))}`,
    `docker compose ${[composeFile, ...composeOverlays].flatMap((f) => ['-f', q(f)]).join(' ')} up -d`,
  ];
  if (url) {
    const safe = (s) => s.replace(/'/g, `'\\''`);
    const u = q(openUrl({ url, openPath }));
    const health = q(url.replace(/\/$/, '') + (healthPath || '/api/health'));
    cmd.push(
      `echo "When it is up, the app is at: ${safe(url)}"`,
      `i=0; until curl -sfso /dev/null ${health} || [ $i -ge 24 ]; do i=$((i+1)); sleep 5; done`,
      `open ${u} 2>/dev/null || echo "Could not open the browser automatically. Open: ${safe(openUrl({ url, openPath }))}"`,
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
    const mock = where !== 'installed' ? [{ ...rest, ...(d.tags ? { tags: hostedTags(d.tags) } : {}), id: where === 'both' ? `${d.id}-mock` : d.id, url: d.mockUrl, openPath: undefined, where: 'mock' }] : [];
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
// The URL the visitor used to reach this shelf (the lab-proxy sends X-Forwarded-Host/-Proto). Apps served behind the proxy fetch
// /api/shelf without their lab cookie, so the request lands here: this is how their header "Shelf" button learns where to go.
// Host was already validated by the host check; the forwarded pair is only used when both are present and well formed.
function shelfOrigin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http');
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) || !/^https?$/.test(proto)) return null;
  return `${proto}://${host}`;
}

export function createApp({ demos: registry, catalog, tags, catalogTags = {}, allowStart = false, agent = null, inDocker = false, installSource = null, demoRoot = null, refreshWaitMs = 4000, loopbackOnly = true, webDist, fetchFn, exec, fileExists, shelfDir, now, random, wait, pingProductsCheck, lastRunning = null, networkLimit = undefined, maxRunningDemos = null }) {
  const demos = expandWhere(registry);
  const app = express();
  app.disable('x-powered-by');
  app.set('case sensitive routing', true);
  app.use(express.json({ limit: '4kb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    if (loopbackOnly && !LOOPBACK_HOSTS.has((req.headers.host || '').replace(/:\d+$/, '').toLowerCase())) return res.status(403).json({ error: 'bad-host' });
    next();
  });

  // demo-health/1 (docs/health-contract.md): public, GET only, no detail.
  app.get('/api/health', (req, res) => res.json({ schema: 'demo-health/1', at: new Date().toISOString(), state: 'ready', runtime: 'offline', demo: { id: 'demo-shelf-LAB', name: 'Demo Shelf LAB', version: VERSION } }));

  // Rule 19: the Mock/Real toggle's contract. The shelf is a launcher: it has no live mode of its own — it
  // starts, stops and health-checks the other demos. So realAvailable is always false with that honest reason.
  const REAL_REASON = 'The shelf is a launcher: it has no live mode. It starts, stops and health-checks the other demos, and each of those has its own Mock/Real toggle.';
  app.get('/api/info', (req, res) => res.json({ source: 'mock', realAvailable: false, realReason: REAL_REASON }));
  app.post('/api/mode', (req, res) => {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (Object.keys(b).length !== 1 || !['mock', 'real'].includes(b.source)) return res.status(400).json({ error: 'bad-request', message: 'body must be exactly {source: "mock" or "real"}' });
    if (b.source === 'real') return res.status(409).json({ error: 'real-not-available', message: REAL_REASON });
    return res.json({ source: 'mock', realAvailable: false, realReason: REAL_REASON });
  });

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

  // Labs added to the family in the last 48 hours (rolling), for the Updates banner. See newApps.js for the GitHub budget.
  const newApps = createNewApps({ registry, fetchFn, now });
  app.get('/api/new-apps', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await newApps.get());
  });

  const poller = createPoller({ getDemos: () => demos, fetchFn, now, random, wait });
  const install = createInstallState({ source: installSource, now });
  // Rule 20: which shared Ping products each demo needs, and whether they are shared-and-healthy.
  const checkPing = pingProductsCheck || createPingProducts({ now, exec });
  const catalogItems = catalog?.items || [];
  const byCatalogId = new Map(catalogItems.map((i) => [i.id, i]));

  // { running, max } for the "13 running · limit 10" line: the agent's own count and limit (it is the one that refuses), or this
  // process's when the shelf runs Docker itself. running is null when it cannot be told (an older agent): the page then shows the limit.
  let runningCache = { at: 0, value: null };
  async function runningCount() {
    if (agent) {
      const v = typeof agent.running === 'function' ? await agent.running() : null;
      if (v && v.max !== null) return v;
      return maxRunningDemos ? { running: v ? v.running : null, max: maxRunningDemos } : null;
    }
    if (!maxRunningDemos) return null;
    if (Date.now() - runningCache.at < 5000) return runningCache.value;
    const list = await runningDemos(demos.filter((d) => d.where === 'installed'), exec || defaultExec, shelfDir).catch(() => null);
    runningCache = { at: Date.now(), value: { running: list ? list.length : null, max: maxRunningDemos } };
    return runningCache.value;
  }

  async function shelf(results) {
    const nowMs = (now || Date.now)();
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
      addedAt: d.addedAt ?? null,
      isNew: isNewDemo(d.addedAt, nowMs),
      tags: d.tags ?? [],
      url: openUrl(d),
      proxyUrl: PROXY_PATHS[d.id] ? `https://local.ping-devops.com:8443${PROXY_PATHS[d.id]}` : null,
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
    const runningLimit = allowStart ? await runningCount() : null;
    return { schema: 'demo-shelf/1', generatedAt: new Date().toISOString(), installPending: inst.pending, startEnabled: allowStart, agent: agentState, runningLimit, newWindowHours: NEW_WINDOW_HOURS, groups: catalog?.groups || {}, tagGroups: tags?.groups || [], demos: registered, planned };
  }

  // Labs reachable through the lab-proxy (https://local.ping-devops.com:8443/<path>/).
  // Keyed by shelf id; keep in sync with shared/lab-proxy/nginx.conf routes.
  const PROXY_PATHS = {
    'ai-gateway-client': '/ai-gateway-client/',
    'ai-guard-sidecar': '/ai-guard-sidecar/',
    'agentcore-pingone-demo-lab': '/agentcore-pingone/',
    'ciba-hitl-lab': '/ciba-hitl-lab/',
    'hitl-mfa-lab': '/hitl-mfa-lab/',
    'delegation-lab': '/delegation-lab/',
    'a2a-lab': '/a2a-lab/',
    'agent-preferences-lab': '/agent-preferences-lab/',
    'demo-field-guide': '/demo-field-guide/',
    'diagram-prove-lab': '/diagram-prove-lab/',
    'idjag-runner': '/idjag-runner/',
    'cimd-lab': '/cimd-lab/',
    'customer-agent-lab': '/customer-agent/',
    'gateway-claims-lab': '/gateway-claims/',
    'gateway-suite-lab': '/gateway-suite/',
    'hostile-mcp': '/hostile-mcp/',
    'meridian-a2a-hop': '/meridian-a2a-hop/',
    'mcp-gateway-lab': '/mcp-gateway-lab/',
    'no-tool-no-promise': '/no-tool-no-promise/',
    'pingfederate-lab': '/pingfederate-lab/',
    'pingone-lab': '/pingone-lab/',
    'pingone-events-lab': '/pingone-events-lab/',
    'pingcli-lab': '/pingcli/',
    'mcp-skills-lab': '/mcp-skills-lab/',
    'aggregate-entitlement-lab': '/aggregate-entitlement-lab/',
    'privilege-demo': '/privilege-demo/',
    'token-workbench': '/token-workbench/',
    'agent-kill-switch': '/agent-kill-switch/',
    'agent-registry-demo': '/agent-registry-demo/',
    // First-run labs (AI-DEMO-Standalone scripts/first-run-labs.txt), routed 2026-11-09.
    'mcp-demo-client-privilege': '/mcp-demo-client/',
    'privilege-a2a-anthropic-demo': '/privilege-a2a/',
    'id-jag-standalone': '/id-jag-kit/',
    'hostile-a2a': '/hostile-a2a/',
    'data-protection-lab': '/data-protection/',
    // Routed and checked through the launcher on the Air, 2026-11-09.
    'privilege-map': '/privilege-map/',
    'mcp-discovery': '/mcp-discovery/',
    'intent-purpose-behaviour-lab': '/intent-purpose-behaviour/',
    'coding-agents-lab': '/coding-agents/',
    'saas-access-lab': '/saas-access/',
    'p1az-inspector': '/p1az-inspector/',
    'pingone-mcp-inspector': '/pingone-mcp-inspector/',
    'jev-lab': '/jev-lab/',
    'obo-lab': '/obo-lab/',
    'jit-lab': '/jit-lab/',
    'observability-lab': '/observability-lab/',
    'privilege-logging-lab': '/privilege-logging-lab/',
    'deploy-test-lab': '/deploy-test/',
    'attack-gallery': '/attack-gallery/',
    'worker-demo': '/worker-demo/',
    'session-lab': '/session-lab/',
    'intent-par-inspector': '/intent-par-inspector/',
    'poppy-agent-tester': '/poppy-agent-tester/',
    'agent-governance-lab': '/agent-governance-lab/',
    'mcp-surface-lab': '/mcp-surface-lab/',
    'federated-identity-lab': '/federated-identity-lab/',
    'stolen-token-lab': '/stolen-token-lab/',
    'mcp-elicitation-lab': '/mcp-elicitation-lab/',
    'mcp-tools': '/mcp-tools/',
    'mcp-scanner': '/mcp-tools/',
    'field-notes-lab': '/field-notes-lab/',
    'env-map-lab': '/env-map-lab/',
    'ping-services-stub': '/ping-services-stub/',
    'muse': '/muse/',
    'agent-mcp-door-demo': '/agent-mcp-door-demo/',
    'pingone-signin-lab': '/pingone-signin-lab/',
    'diagram-studio': '/diagram-studio/',
    'mcp-auth-conformance-lab': '/mcp-auth-conformance-lab/',
    'p1-third-party-exchange': '/p1-third-party-exchange/',
    'personal-agent-demo': '/personal-agent-demo/',
    'ping-gateway-route-lab': '/ping-gateway-route-lab/',
    'secrets-vault-lab': '/secrets-vault-lab/',
    'ai-policies-lab': '/ai-policies-lab/',
    'agent-gateway-inspector': '/agent-gateway-inspector/',
    'progressive-trust-ladder': '/progressive-trust-ladder/',
    'chatgpt-mcp-flow': '/chatgpt-mcp-flow/',
    'mock-authorize': '/mock-authorize/',
    'agent-audit-trail-lab': '/agent-audit-trail-lab/',
  };
  app.get('/api/shelf', async (req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json({ ...(await shelf(await poller.get())), shelfUrl: shelfOrigin(req) }); } catch (e) { next(e); }
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

  // The last-running set on the host-run path: the UI reads the ids and starts each demo
  // through the normal control router (the same pattern as stop-all). The container path
  // uses the start agent's POST /v1/restore-last instead.
  if (allowStart && lastRunning) {
    app.get('/api/last-running', (req, res) => {
      res.set('Cache-Control', 'no-store').json({ ok: true, schema: 'shelf-last-running/1', ids: lastRunning.restoreIds(10) });
    });
  }
  if (allowStart) app.use('/api', createControlRouter({ express, getDemos: () => registry, onChange: (id) => { poller.invalidate(); install.invalidate(id); }, exec, fileExists, agent, inDocker, shelfDir, demoRoot, lastRunning, networkLimit, maxRunningDemos }));
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
