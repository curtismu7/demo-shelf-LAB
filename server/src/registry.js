// Registry of demos the shelf knows about: a committed seed (data/demos.json) with user overrides
// (.data/demos.local.json) merged over it by id. Validation collects every problem so the message
// can name them all. Nothing here reads a secret; nothing accepts a shell string.
import fs from 'node:fs';
import path from 'node:path';

const ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
const TAG_ID = /^[a-z0-9][a-z0-9-]{0,40}$/; // same pattern as data/tags.json
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
// Characters that mean something to a shell. execFile never uses one, but a path holding them is a typo or an attack.
const SHELL_CHARS = /[;&|$`<>\\"'*?(){}!#\n\r\t\0]/;
const WHERE = ['installed', 'mock', 'both'];
const FIELDS = ['id', 'addedAt', 'name', 'catalogId', 'alsoCatalogIds', 'kind', 'description', 'url', 'where', 'mockUrl', 'healthPath', 'openPath', 'composeFile', 'composeOverlays', 'notes', 'tags', 'repo', 'pingProducts'];

// https://github.com/<org>/<name> only (optional .git). Returns the canonical form without ".git", or null. The web page builds
// `git clone <repo>.git` from it (so a name that still ends in .git after one is stripped is refused: stripping twice would name another repo), so nothing else may get through: no query, fragment, userinfo, port, spaces or newlines.
const REPO = /^https:\/\/github\.com\/([A-Za-z0-9._-]{1,39})\/([A-Za-z0-9._-]{1,100})$/;
export function cleanRepo(value) {
  if (typeof value !== 'string' || value.length > 160) return null;
  const m = REPO.exec(value.endsWith('.git') ? value.slice(0, -4) : value);
  if (!m || m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..' || m[2].endsWith('.git')) return null;
  return `https://github.com/${m[1]}/${m[2]}`;
}

// When the app joined the shelf: an ISO date (YYYY-MM-DD, read as UTC midnight) or a full ISO timestamp with Z or an offset.
// Returns the time in ms, or null when the text is not a real calendar date (so 2026-02-30 is refused, not rolled into March).
const ADDED_AT = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;
export function parseAddedAt(value) {
  const m = typeof value === 'string' ? ADDED_AT.exec(value) : null;
  if (!m) return null;
  const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (day.getUTCFullYear() !== +m[1] || day.getUTCMonth() !== +m[2] - 1 || day.getUTCDate() !== +m[3]) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// An app is "new" for this many hours after addedAt. Rolling, from the server's clock, so every view agrees.
export const NEW_WINDOW_HOURS = 48;
export function isNewDemo(addedAt, nowMs, windowHours = NEW_WINDOW_HOURS) {
  const ms = parseAddedAt(addedAt);
  return ms !== null && ms <= nowMs && nowMs - ms < windowHours * 3600 * 1000;
}

export class RegistryError extends Error {
  constructor(errors) {
    super(`Registry is not valid:\n - ${errors.join('\n - ')}`);
    this.name = 'RegistryError';
    this.errors = errors;
  }
}

export function allowedHostsFromEnv(env = process.env) {
  const fromEnv = (env.SHELF_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return [...new Set(fromEnv)];
}

// A compose path is absolute, or relative to the demo root (the folder the demo repos sit in; SHELF_DEMO_ROOT, default: the
// folder above this shelf). A relative path is what makes an entry portable across machines (rule 9).
function checkPath(label, p, errors, demoRoot) {
  if (typeof p !== 'string' || !p) return errors.push(`${label} must be a path`);
  if (!path.isAbsolute(p) && !demoRoot) return errors.push(`${label} is relative and no demo root is set`);
  if (SHELL_CHARS.test(p)) return errors.push(`${label} contains shell characters`);
  if (p.split('/').includes('..')) return errors.push(`${label} must not contain ".."`);
  if (!/\.ya?ml$/.test(p)) errors.push(`${label} must be a .yml or .yaml file`);
}
const resolvePath = (p, demoRoot) => (path.isAbsolute(p) || !demoRoot ? p : path.resolve(demoRoot, p));

// A mock copy may sit under a path prefix on a shared SE host (mocks.<host>/<mock-name>); its health path is joined under it.
// A plain prefix only: no query, fragment, credentials or "..". Local and url values stay origin-only.
function checkMockUrl(label, value, allowedHosts, errors) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return errors.push(`${label} must be http or https`);
    if (u.username || u.password) return errors.push(`${label} must not carry credentials`);
    if (u.search || u.hash) return errors.push(`${label} must have no query or fragment`);
    if (!/^(\/[A-Za-z0-9._~-]+)*\/?$/.test(u.pathname) || u.pathname.includes('..')) return errors.push(`${label} path must be a plain prefix`);
    if (!LOOPBACK.has(u.hostname.toLowerCase()) && !allowedHosts.includes(u.hostname.toLowerCase())) errors.push(`${label}: host "${u.hostname.toLowerCase()}" is not loopback; add it to SHELF_ALLOWED_HOSTS to allow it`);
  } catch {
    errors.push(`${label} is not a valid URL`);
  }
}

function checkOrigin(label, value, allowedHosts, errors) {
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'http:' && u.protocol !== 'https:') errors.push(`${label} must be http or https`);
    else if (u.username || u.password) errors.push(`${label} must not carry credentials`);
    else if (u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) errors.push(`${label} must be an origin only (no path, query or fragment)`);
    else if (!LOOPBACK.has(host) && !allowedHosts.includes(host)) errors.push(`${label}: host "${host}" is not loopback; add it to SHELF_ALLOWED_HOSTS to allow it`);
  } catch {
    errors.push(`${label} is not a valid URL`);
  }
}

// Returns the cleaned demos (unknown keys dropped). Throws RegistryError.
export function validateDemos(demos, { allowedHosts = [], demoRoot, tagIds, now = Date.now } = {}) {
  const errors = [];
  if (!Array.isArray(demos)) throw new RegistryError(['"demos" must be an array']);
  const seen = new Set();
  const clean = [];
  demos.forEach((d, i) => {
    const at = `demos[${i}]${d && typeof d.id === 'string' ? ` (${d.id})` : ''}`;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return errors.push(`${at} must be an object`);
    if (typeof d.id !== 'string' || !ID.test(d.id)) errors.push(`${at}: id must match ${ID}`);
    else if (seen.has(d.id)) errors.push(`${at}: duplicate id`);
    else seen.add(d.id);
    for (const f of ['name', 'description']) {
      if (typeof d[f] !== 'string' || !d[f].trim() || d[f].length > 300) errors.push(`${at}: ${f} must be a non-empty string up to 300 characters`);
    }
    if (d.addedAt !== undefined) {
      const ms = parseAddedAt(d.addedAt);
      if (ms === null) errors.push(`${at}: addedAt must be a date (YYYY-MM-DD) or an ISO timestamp with Z or an offset`);
      else if (ms > now() + (d.addedAt.length === 10 ? 14 * 3600 * 1000 : 0)) errors.push(`${at}: addedAt ${d.addedAt} is in the future`);
    }
    for (const f of ['catalogId', 'kind']) {
      if (d[f] !== undefined && (typeof d[f] !== 'string' || d[f].length > 40)) errors.push(`${at}: ${f} must be a short string`);
    }
    // Extra catalog rows this one app also covers (the card sits under catalogId; these rows stop showing as planned ideas).
    if (d.alsoCatalogIds !== undefined && (!Array.isArray(d.alsoCatalogIds) || d.alsoCatalogIds.length > 10 || d.alsoCatalogIds.some((c) => typeof c !== 'string' || c.length > 40))) errors.push(`${at}: alsoCatalogIds must be an array of up to 10 short strings`);
    const where = d.where === undefined ? 'installed' : d.where;
    if (!WHERE.includes(where)) errors.push(`${at}: where must be one of ${WHERE.join(', ')}`);
    // A mock-only demo has no local copy, so url is optional there.
    if (where !== 'mock' || d.url !== undefined) checkOrigin(`${at}: url`, d.url, allowedHosts, errors);
    if (where === 'mock' || where === 'both' || d.mockUrl !== undefined) {
      if (d.mockUrl === undefined) errors.push(`${at}: mockUrl is required when where is "${where}"`);
      else checkMockUrl(`${at}: mockUrl`, d.mockUrl, allowedHosts, errors);
    }
    const hp = d.healthPath === undefined ? '/api/health' : d.healthPath;
    if (typeof hp !== 'string' || !/^\/[A-Za-z0-9._~\-/]*$/.test(hp) || hp.startsWith('//') || hp.includes('..')) errors.push(`${at}: healthPath must be a plain path starting with "/"`);
    // Where Open lands inside the app (for example "/#/diagram"); health checks still use url.
    if (d.openPath !== undefined && (typeof d.openPath !== 'string' || !/^\/[A-Za-z0-9._~\-/#]*$/.test(d.openPath) || d.openPath.startsWith('//') || d.openPath.includes('..'))) errors.push(`${at}: openPath must be a plain path starting with "/" (a "#" fragment is allowed)`);
    if (d.composeFile !== undefined) checkPath(`${at}: composeFile`, d.composeFile, errors, demoRoot);
    if (d.composeOverlays !== undefined) {
      if (!Array.isArray(d.composeOverlays)) errors.push(`${at}: composeOverlays must be an array of paths`);
      else d.composeOverlays.forEach((o, j) => checkPath(`${at}: composeOverlays[${j}]`, o, errors, demoRoot));
      if (d.composeFile === undefined && d.composeOverlays?.length) errors.push(`${at}: composeOverlays needs composeFile`);
    }
    const repo = d.repo === undefined ? undefined : cleanRepo(d.repo);
    if (d.repo !== undefined && !repo) errors.push(`${at}: repo must be https://github.com/<org>/<name> (letters, digits, ".", "_" and "-" only)`);
    let tags;
    if (d.tags !== undefined) {
      if (!Array.isArray(d.tags) || d.tags.length > 20) errors.push(`${at}: tags must be an array of up to 20 tag ids`);
      else {
        const bad = d.tags.filter((t) => typeof t !== 'string' || !TAG_ID.test(t) || (tagIds && !tagIds.has(t)));
        if (bad.length) errors.push(`${at}: unknown tag${bad.length > 1 ? 's' : ''} ${bad.map((t) => JSON.stringify(t)).join(', ')} (add ${bad.length > 1 ? 'them' : 'it'} to data/tags.json or fix the spelling)`);
        else tags = [...new Set(d.tags)];
      }
    }
    let pingProducts;
    if (d.pingProducts !== undefined) {
      const KNOWN = new Set(['pingfederate', 'pinggateway', 'privilege-gateway', 'pingone', 'pingone-privilege']);
      if (!Array.isArray(d.pingProducts) || d.pingProducts.length > 5 || d.pingProducts.some((p) => !KNOWN.has(p))) {
        errors.push(`${at}: pingProducts must be an array of known product names (${[...KNOWN].join(', ')})`);
      } else pingProducts = [...new Set(d.pingProducts)];
    }
    const out = {};
    for (const f of FIELDS) if (d[f] !== undefined) out[f] = d[f];
    if (tags) out.tags = tags;
    if (repo) out.repo = repo;
    if (pingProducts) out.pingProducts = pingProducts;
    out.where = where;
    out.healthPath = hp;
    if (d.composeFile !== undefined) out.composeFile = resolvePath(d.composeFile, demoRoot);
    out.composeOverlays = Array.isArray(d.composeOverlays) ? d.composeOverlays.map((o) => resolvePath(o, demoRoot)) : [];
    clean.push(out);
  });
  // A "both" demo also produces a "<id>-mock" card, so that id is reserved: another entry using it would
  // share a card id (and a health result) with the generated card.
  clean.forEach((d, i) => {
    if (d.where === 'both' && seen.has(`${d.id}-mock`)) errors.push(`demos[${i}] (${d.id}): id "${d.id}-mock" is reserved for its mock card, but another entry uses it`);
  });
  if (errors.length) throw new RegistryError(errors);
  return clean;
}

function readJson(file, label) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new RegistryError([`${label}: cannot read (${e.code})`]);
  }
  try { return JSON.parse(text); } catch { throw new RegistryError([`${label}: not valid JSON`]); }
}

// Seed first, then the local file: same id = fields overridden, new id = appended.
export function loadRegistry({ seedFile, localFile, allowedHosts = [], demoRoot, tagIds, now }) {
  const seed = readJson(seedFile, 'data/demos.json');
  if (!seed) throw new RegistryError([`seed registry not found: ${seedFile}`]);
  const local = readJson(localFile, 'demos.local.json');
  if (!Array.isArray(seed.demos)) throw new RegistryError(['data/demos.json: "demos" must be an array']);
  if (local && !Array.isArray(local.demos)) throw new RegistryError(['demos.local.json: "demos" must be an array']);
  const byId = new Map();
  const key = (d) => (typeof d?.id === 'string' ? d.id : Symbol('bad'));
  for (const d of seed.demos) byId.set(key(d), d);
  for (const d of local?.demos || []) {
    const k = key(d);
    byId.set(k, d && typeof d === 'object' ? { ...(byId.get(k) || {}), ...d } : d);
  }
  return validateDemos([...byId.values()], { allowedHosts, demoRoot, tagIds, now });
}

// Problems with alsoCatalogIds across the cleaned demos: an id that is not a catalog row (a typo leaves the planned card showing), the
// entry's own catalogId, or a row another demo already claims. Returns messages; the server prints them and the doctor fails on them.
export function alsoCatalogProblems(demos, catalog) {
  const rows = new Set((catalog?.items || []).map((i) => i.id));
  const out = [];
  for (const d of demos) {
    for (const c of d.alsoCatalogIds ?? []) {
      if (!rows.has(c)) out.push(`${d.id}: alsoCatalogIds "${c}" is not a catalog row`);
      else if (c === d.catalogId) out.push(`${d.id}: alsoCatalogIds "${c}" is its own catalogId`);
      else {
        const other = demos.find((o) => o !== d && (o.catalogId === c || o.alsoCatalogIds?.includes(c)));
        if (other) out.push(`${d.id}: alsoCatalogIds "${c}" is also claimed by ${other.id}`);
      }
    }
  }
  return out;
}
