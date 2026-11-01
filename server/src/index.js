import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedHostsFromEnv, loadRegistry, RegistryError } from './registry.js';
import { createApp } from './app.js';
import { loadCatalogTags, loadTaxonomy, tagIdSet, untaggedPlanned } from './tags.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

// Loopback unless SHELF_BIND is set on purpose.
export function resolveBind(env = process.env) {
  const host = env.SHELF_BIND?.trim() || '127.0.0.1';
  return { host, explicit: Boolean(env.SHELF_BIND?.trim()), loopback: LOOPBACK.has(host) };
}

// Start/Stop needs the explicit opt-in AND a loopback bind. A non-loopback SHELF_BIND always turns it off.
export function resolveAllowStart(env, bind) {
  // On by default on loopback; SHELF_ALLOW_START=0 turns it off. A non-loopback bind turns it off, with a warning only if it was asked for.
  const requested = env.SHELF_ALLOW_START !== '0';
  return { allowStart: requested && bind.loopback, refused: env.SHELF_ALLOW_START === '1' && !bind.loopback };
}

export function resolvePort(env = process.env) {
  const p = Number(env.SHELF_PORT ?? 4400);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('SHELF_PORT must be 1-65535');
  return p;
}

export function loadAll(env = process.env) {
  const tags = loadTaxonomy(env.SHELF_TAGS_FILE ? path.resolve(env.SHELF_TAGS_FILE) : path.join(root, 'data', 'tags.json'));
  const dataDir = path.resolve(env.SHELF_DATA_DIR || path.join(root, '.data'));
  const demos = loadRegistry({
    seedFile: env.SHELF_SEED_FILE ? path.resolve(env.SHELF_SEED_FILE) : path.join(root, 'data', 'demos.json'),
    localFile: path.join(dataDir, 'demos.local.json'),
    allowedHosts: allowedHostsFromEnv(env),
    demoRoot: env.SHELF_DEMO_ROOT ? path.resolve(env.SHELF_DEMO_ROOT) : path.dirname(root),
    tagIds: tagIdSet(tags),
  });
  let catalog = { items: [] };
  try { catalog = JSON.parse(fs.readFileSync(path.join(root, 'data', 'catalog.json'), 'utf8')); } catch { /* shelf still works without it */ }
  const catalogTags = loadCatalogTags(env.SHELF_CATALOG_TAGS_FILE ? path.resolve(env.SHELF_CATALOG_TAGS_FILE) : path.join(root, 'data', 'catalog-tags.json'), { tagIds: tagIdSet(tags), catalogIds: new Set((catalog.items || []).map((i) => i.id)) });
  return { demos, catalog, tags, catalogTags };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const bind = resolveBind();
    const port = resolvePort();
    const { demos, catalog, tags, catalogTags } = loadAll();
    const { allowStart, refused } = resolveAllowStart(process.env, bind);
    if (refused) console.warn('Start/Stop disabled: it is only available when listening on loopback.');
    const untagged = untaggedPlanned(catalog, demos, catalogTags);
    if (untagged.length) console.warn(`${untagged.length} planned idea${untagged.length > 1 ? 's have' : ' has'} no tags (add to data/catalog-tags.json): ${untagged.join(', ')}`);
    const app = createApp({ demos, catalog, tags, catalogTags, allowStart, onlineOnly: process.env.SHELF_ONLINE_ONLY === '1', loopbackOnly: bind.loopback, webDist: path.join(root, 'web', 'dist') });
    app.listen(port, bind.host, () => {
      console.log(`demo-shelf on http://${bind.host}:${port}  (${demos.length} demos${process.env.SHELF_ONLINE_ONLY === '1' ? ', online copies only' : ''}, start/stop ${allowStart ? 'on' : 'off'})`);
    });
  } catch (e) {
    console.error(e instanceof RegistryError ? e.message : `demo-shelf: ${e.message}`);
    process.exit(1);
  }
}
