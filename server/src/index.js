import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedHostsFromEnv, loadRegistry, RegistryError } from './registry.js';
import { createApp } from './app.js';
import { loadShelfEnv } from './dotenv.js';
import { createAgentClient } from './agent-client.js';
import { createProbeFetch } from './probe.js';
import { loadCatalogTags, loadTaxonomy, tagIdSet, untaggedPlanned } from './tags.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

// Loopback unless SHELF_BIND is set on purpose.
export function resolveBind(env = process.env) {
  const host = env.SHELF_BIND?.trim() || '127.0.0.1';
  return { host, explicit: Boolean(env.SHELF_BIND?.trim()), loopback: LOOPBACK.has(host) };
}

// Start / Stop is always on. Host-run it needs a loopback bind (a non-loopback SHELF_BIND turns it off). In a container
// (SHELF_IN_DOCKER=1) the bind is 0.0.0.0 inside, so the shelf hands the compose call to the host-side start agent instead.
export function resolveAllowStart(env, bind) {
  const inDocker = env.SHELF_IN_DOCKER === '1';
  return { allowStart: inDocker || bind.loopback, refused: !inDocker && !bind.loopback, inDocker };
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
    loadShelfEnv(root);
    const bind = resolveBind();
    const port = resolvePort();
    const { demos, catalog, tags, catalogTags } = loadAll();
    const { allowStart, refused, inDocker } = resolveAllowStart(process.env, bind);
    if (refused) console.warn('Start/Stop disabled: it is only available when listening on loopback.');
    if (inDocker && !fs.existsSync('/.dockerenv')) throw new Error('SHELF_IN_DOCKER=1 is only for the container image; on the host run npm start');
    if (inDocker && !(process.env.SHELF_AGENT_URL && process.env.SHELF_AGENT_TOKEN)) throw new Error('SHELF_IN_DOCKER=1 needs SHELF_AGENT_URL and SHELF_AGENT_TOKEN (npm run docker sets them)');
    const agent = inDocker ? createAgentClient({ url: process.env.SHELF_AGENT_URL, token: process.env.SHELF_AGENT_TOKEN }) : null;
    const fetchFn = process.env.SHELF_PROBE_HOST ? createProbeFetch({ probeHost: process.env.SHELF_PROBE_HOST }) : undefined;
    const untagged = untaggedPlanned(catalog, demos, catalogTags);
    if (untagged.length) console.warn(`${untagged.length} planned idea${untagged.length > 1 ? 's have' : ' has'} no tags (add to data/catalog-tags.json): ${untagged.join(', ')}`);
    const app = createApp({ demos, catalog, tags, catalogTags, allowStart, agent, inDocker, fetchFn, loopbackOnly: bind.loopback || inDocker, shelfDir: root, webDist: path.join(root, 'web', 'dist') });
    app.listen(port, bind.host, () => {
      console.log(`demo-shelf on http://${bind.host}:${port}  (${demos.length} demos, start/stop ${allowStart ? (inDocker ? 'via the start agent' : 'on') : 'off'})`);
    });
  } catch (e) {
    console.error(e instanceof RegistryError ? e.message : `demo-shelf: ${e.message}`);
    process.exit(1);
  }
}
