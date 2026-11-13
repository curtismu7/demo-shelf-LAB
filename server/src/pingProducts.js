// Rule 20 (step 2 + 4): which shared Ping products does each lab need, and are they
// shared-and-healthy? A demo declares `pingProducts: []` in the registry; this module
// checks each product the way ~/Development/ping-shared/probe.mjs does (container up +
// endpoint answers) and caches results briefly so the shelf's frequent polls stay cheap.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';

const CACHE_MS = 30_000;

// Shared products that run as local containers, mapped to their container names (Rule 20).
// pingone / pingone-privilege are SaaS: nothing to start locally, so they are absent here.
export const SHARED_CONTAINERS = {
  pingfederate: 'ai-demo-pingfederate',
  pinggateway: 'ai-demo-ping-gateway',
  'privilege-gateway': 'ai-demo-ping-mcpgw',
};

// Shared products publish on the host's loopback. Inside the containerised shelf that host
// is host.docker.internal (SHELF_PING_HOST overrides); a host-run shelf probes 127.0.0.1.
const PING_HOST = process.env.SHELF_PING_HOST || (process.env.SHELF_IN_DOCKER ? 'host.docker.internal' : '127.0.0.1');

const HEALTH = {
  pingfederate: {
    container: 'ai-demo-pingfederate',
    url: `https://${PING_HOST}:9031/pf/heartbeat.ping`,
    ok: [200],
  },
  pinggateway: {
    container: 'ai-demo-ping-gateway',
    url: `https://${PING_HOST}:3036/mcp`,
    ok: [200, 401, 405], // 401 = the enforcement point is up and asking for auth
  },
  'privilege-gateway': {
    container: 'ai-demo-ping-mcpgw',
    url: `http://${PING_HOST}:8623/`,
    ok: [200],
  },
  pingone: {
    container: null,
    urlFromEnv: (env) => {
      const id = env.PINGONE_ENVIRONMENT_ID;
      if (!id) return null;
      // Region aliases per the family convention: na/us map to com (pingone-lab settings.js).
      const ALIAS = { na: 'com', us: 'com', com: 'com', eu: 'eu', ca: 'ca', ap: 'asia', asia: 'asia', au: 'asia' };
      const region = ALIAS[String(env.PINGONE_REGION || 'com').toLowerCase()] || 'com';
      return `https://auth.pingone.${region}/${id}/as/.well-known/openid-configuration`;
    },
    ok: [200],
  },
  'pingone-privilege': {
    container: null,
    urlFromEnv: (env) => env.PRIVILEGE_CONSOLE_URL || 'https://console.privilege.pingone.com/',
    ok: [200, 302, 401, 403],
  },
};

// Rule 94: the family's one shared settings file, ~/Development/.env. Existing process
// env wins; the file fills the rest. Read once per process: the file is owner-edited,
// not hot-reloaded.
function sharedEnv(env = process.env, envFile) {
  const out = { ...env };
  try {
    const p = envFile || `${process.env.HOME}/Development/.env`;
    const text = fs.readFileSync(p, 'utf8');
    for (const line of text.split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && !(m[1] in out)) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no file: SaaS probes report not-configured */ }
  return out;
}

function get(url) {
  const mod = url.startsWith('https:') ? https : http;
  return new Promise((resolve) => {
    const req = mod.get(url, { rejectUnauthorized: false, timeout: 3000 }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
}

function containerUp(container, exec = execFileSync) {
  if (!container) return true;
  try {
    const st = exec('docker', ['--context', 'orbstack', 'ps', '-a', '--filter', `name=^${container}$`, '--format', '{{.Status}}'], { encoding: 'utf8' }).trim();
    return st.startsWith('Up');
  } catch {
    // No docker CLI (the containerised shelf): the endpoint probe decides on its own.
    return true;
  }
}

export function createPingProducts({ envFile, now = Date.now, exec = execFileSync } = {}) {
  const env = sharedEnv(process.env, envFile || process.env.SHELF_SHARED_ENV);
  let cache = { at: 0, statuses: {} };

  async function statusOf(product) {
    const def = HEALTH[product];
    if (!def) return { product, state: 'unknown' };
    const url = def.urlFromEnv ? def.urlFromEnv(env) : def.url;
    if (!url) return { product, state: 'not-configured' };
    const up = containerUp(def.container, exec);
    const code = await get(url);
    if (up && def.ok.includes(code)) return { product, state: 'ready', url };
    if (up) return { product, state: 'unhealthy', url, code };
    return { product, state: 'down', url };
  }

  return async function pingProductsStatus(products) {
    const names = [...new Set(products || [])];
    if (!names.length) return [];
    const fresh = now() - cache.at < CACHE_MS;
    const todo = fresh ? names.filter((n) => !(n in cache.statuses)) : names;
    if (todo.length) {
      const results = await Promise.all(todo.map(statusOf));
      const statuses = fresh ? { ...cache.statuses } : {};
      for (const r of results) statuses[r.product] = r;
      cache = { at: now(), statuses };
    }
    return names.map((n) => cache.statuses[n] || { product: n, state: 'unknown' });
  };
}
