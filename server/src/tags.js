// The tag taxonomy (data/tags.json): groups of tags a demo can carry, so the shelf can be filtered by Ping product, use case,
// simulated or real, and standard or protocol. Entries in demos.json (and demos.local.json) list tag ids; unknown ids are refused.
import fs from 'node:fs';
import { RegistryError } from './registry.js';

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const SIMULATED = 'simulated';
export const REAL = 'real';
const MAX_GROUPS = 12;
const MAX_TAGS = 60;

export function validateTaxonomy(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.groups)) throw new RegistryError(['data/tags.json: "groups" must be an array']);
  if (raw.groups.length > MAX_GROUPS) errors.push(`data/tags.json: at most ${MAX_GROUPS} groups`);
  const seen = new Set();
  const groups = [];
  raw.groups.forEach((g, i) => {
    const at = `groups[${i}]${g && typeof g.id === 'string' ? ` (${g.id})` : ''}`;
    if (!g || typeof g !== 'object') return errors.push(`${at} must be an object`);
    if (typeof g.id !== 'string' || !ID.test(g.id)) errors.push(`${at}: id must match ${ID}`);
    if (typeof g.label !== 'string' || !g.label.trim() || g.label.length > 60) errors.push(`${at}: label must be 1-60 characters`);
    if (!Array.isArray(g.tags) || g.tags.length > MAX_TAGS) { errors.push(`${at}: tags must be an array of up to ${MAX_TAGS}`); return; }
    const tags = [];
    g.tags.forEach((t, j) => {
      const tat = `${at}.tags[${j}]`;
      if (!t || typeof t !== 'object') return errors.push(`${tat} must be an object`);
      if (typeof t.id !== 'string' || !ID.test(t.id)) return errors.push(`${tat}: id must match ${ID}`);
      if (seen.has(t.id)) return errors.push(`${tat}: tag id "${t.id}" is used twice (ids are unique across groups)`);
      seen.add(t.id);
      if (typeof t.label !== 'string' || !t.label.trim() || t.label.length > 60) errors.push(`${tat}: label must be 1-60 characters`);
      if (t.hint !== undefined && (typeof t.hint !== 'string' || t.hint.length > 300)) errors.push(`${tat}: hint must be a string up to 300 characters`);
      tags.push({ id: t.id, label: t.label, ...(t.hint ? { hint: t.hint } : {}) });
    });
    groups.push({ id: g.id, label: g.label, tags });
  });
  if (new Set(groups.map((g) => g.id)).size !== groups.length) errors.push('data/tags.json: group ids must be unique');
  if (errors.length) throw new RegistryError(errors);
  return { schema: 'demo-tags/1', groups };
}

export const tagIdSet = (taxonomy) => new Set(taxonomy.groups.flatMap((g) => g.tags.map((t) => t.id)));

// Missing file = no tags at all (the shelf still works; any entry that lists a tag is then refused with a clear message).
export function loadTaxonomy(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { schema: 'demo-tags/1', groups: [] };
    throw new RegistryError([`data/tags.json: cannot read (${e.code})`]);
  }
  let raw;
  try { raw = JSON.parse(text); } catch { throw new RegistryError(['data/tags.json: not valid JSON']); }
  return validateTaxonomy(raw);
}

// The hosted (mock) copy of a demo is always simulated, whatever the installed one can do.
export function hostedTags(tags = []) {
  if (!tags.length) return tags;
  return [...new Set([...tags.filter((t) => t !== REAL), SIMULATED])];
}

// Tags for the planned ideas (data/catalog-tags.json). The catalog itself is regenerated from the plan, so its tags live beside it,
// keyed by catalog id. Unknown tag ids or catalog ids stop the server with a message naming them, same as registry entries.
export function validateCatalogTags(raw, { tagIds, catalogIds }) {
  const errors = [];
  const map = raw && typeof raw === 'object' ? raw.tags : null;
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new RegistryError(['data/catalog-tags.json: "tags" must be an object of catalog id -> tag ids']);
  const out = {};
  for (const [id, list] of Object.entries(map)) {
    const at = `data/catalog-tags.json: ${id}`;
    if (!catalogIds.has(id)) { errors.push(`${at}: not a row in data/catalog.json`); continue; }
    if (!Array.isArray(list) || list.length > 20) { errors.push(`${at}: must be an array of up to 20 tag ids`); continue; }
    const bad = list.filter((t) => typeof t !== 'string' || !tagIds.has(t));
    if (bad.length) { errors.push(`${at}: unknown tag${bad.length > 1 ? 's' : ''} ${bad.map((t) => JSON.stringify(t)).join(', ')}`); continue; }
    out[id] = [...new Set(list)];
  }
  if (errors.length) throw new RegistryError(errors);
  return out;
}

// Missing file = planned ideas simply carry no tags.
export function loadCatalogTags(file, opts) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new RegistryError([`data/catalog-tags.json: cannot read (${e.code})`]);
  }
  let raw;
  try { raw = JSON.parse(text); } catch { throw new RegistryError(['data/catalog-tags.json: not valid JSON']); }
  return validateCatalogTags(raw, opts);
}

// Planned ideas (active catalog rows with no registered demo) that have no entry in data/catalog-tags.json. Not an error: a freshly
// regenerated catalog may bring new rows, and the shelf works without their tags. The server prints this list at startup.
export function untaggedPlanned(catalog, demos, catalogTags) {
  const have = new Set(demos.flatMap((d) => [d.catalogId, ...(d.alsoCatalogIds ?? [])]).filter(Boolean));
  return (catalog?.items || []).filter((i) => i.status === 'active' && !have.has(i.id) && !catalogTags[i.id]?.length).map((i) => i.id);
}
