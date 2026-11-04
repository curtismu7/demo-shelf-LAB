import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { expandWhere, createApp } from '../src/app.js';
import { loadAll } from '../src/index.js';
import { RegistryError, validateDemos } from '../src/registry.js';
import { hostedTags, loadCatalogTags, loadTaxonomy, tagIdSet, untaggedPlanned, validateCatalogTags, validateTaxonomy } from '../src/tags.js';

const tax = { groups: [{ id: 'g1', label: 'One', tags: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', hint: 'bee' }] }, { id: 'g2', label: 'Two', tags: [{ id: 'simulated', label: 'Simulated' }, { id: 'real', label: 'Real' }] }] };
const demo = (over = {}) => ({ id: 'x-demo', name: 'X', description: 'x', url: 'http://localhost:4500', ...over });
const ids = tagIdSet(validateTaxonomy(tax));
const errs = (d, tagIds = ids) => { try { validateDemos([d], { tagIds }); return ''; } catch (e) { return e instanceof RegistryError ? e.message : String(e); } };

describe('taxonomy', () => {
  it('accepts the shape and keeps hints', () => {
    const t = validateTaxonomy(tax);
    expect(t.groups.map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(t.groups[0].tags[1]).toEqual({ id: 'b', label: 'B', hint: 'bee' });
    expect([...tagIdSet(t)].sort()).toEqual(['a', 'b', 'real', 'simulated']);
  });
  it('refuses duplicate ids across groups, bad ids, blank labels and a non-array', () => {
    expect(() => validateTaxonomy({ groups: [{ id: 'g', label: 'G', tags: [{ id: 'a', label: 'A' }] }, { id: 'h', label: 'H', tags: [{ id: 'a', label: 'A2' }] }] })).toThrow(/used twice/);
    expect(() => validateTaxonomy({ groups: [{ id: 'g', label: 'G', tags: [{ id: 'Bad Id', label: 'A' }] }] })).toThrow(/id must match/);
    expect(() => validateTaxonomy({ groups: [{ id: 'g', label: ' ', tags: [] }] })).toThrow(/label/);
    expect(() => validateTaxonomy({ groups: 'no' })).toThrow(RegistryError);
    expect(() => validateTaxonomy({ groups: [{ id: 'g', label: 'G', tags: [] }, { id: 'g', label: 'G2', tags: [] }] })).toThrow(/group ids must be unique/);
  });
  it('a missing file means no tags; bad JSON is a clear error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tags-'));
    expect(loadTaxonomy(path.join(dir, 'none.json')).groups).toEqual([]);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{nope');
    expect(() => loadTaxonomy(path.join(dir, 'bad.json'))).toThrow(/not valid JSON/);
  });
});

describe('tags on registry entries', () => {
  it('keeps known tags, de-duplicated, in order', () => {
    expect(validateDemos([demo({ tags: ['a', 'b', 'a'] })], { tagIds: ids })[0].tags).toEqual(['a', 'b']);
  });
  it('refuses an unknown tag and names it, and refuses a non-array or too many', () => {
    expect(errs(demo({ tags: ['a', 'oops'] }))).toMatch(/unknown tag "oops"/);
    expect(errs(demo({ tags: 'a' }))).toMatch(/array of up to 20/);
    expect(errs(demo({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }))).toMatch(/up to 20/);
    expect(errs(demo({ tags: [1] }))).toMatch(/unknown tag/);
  });
  it('an entry with no tags is fine', () => {
    expect(errs(demo())).toBe('');
  });
});

describe('hosted copies are always simulated', () => {
  it('hostedTags drops real and adds simulated; no tags stays no tags', () => {
    expect(hostedTags(['a', 'real', 'simulated'])).toEqual(['a', 'simulated']);
    expect(hostedTags(['a', 'real'])).toEqual(['a', 'simulated']);
    expect(hostedTags([])).toEqual([]);
    expect(hostedTags(undefined)).toEqual([]);
  });
  it('a "both" entry: the installed card keeps real, the -mock card does not', () => {
    const cards = expandWhere([demo({ where: 'both', mockUrl: 'https://mocks.example', tags: ['a', 'simulated', 'real'] })]);
    expect(cards.map((c) => [c.id, c.tags])).toEqual([['x-demo', ['a', 'simulated', 'real']], ['x-demo-mock', ['a', 'simulated']]]);
  });
});

describe('GET /api/shelf', () => {
  it('returns tagGroups and each card tags', async () => {
    const registry = validateDemos([demo({ tags: ['a', 'real'] })], { tagIds: ids });
    const app = createApp({ demos: registry, catalog: { items: [] }, tags: validateTaxonomy(tax), allowStart: false, fetchFn: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
    const res = await request(app).get('/api/shelf').set('Host', '127.0.0.1');
    expect(res.status).toBe(200);
    expect(res.body.tagGroups.map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(res.body.demos[0].tags).toEqual(['a', 'real']);
  });
});

describe('the committed seed', () => {
  const { demos, tags } = loadAll({ ...process.env, SHELF_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'seed-')) });
  const known = tagIdSet(tags);
  it('has the starter groups', () => {
    expect(tags.groups.map((g) => g.label)).toEqual(['Ping products', 'Use cases', 'Diagram packs', 'Simulated or real', 'Standards and protocols', 'What we built', 'AWS']);
  });
  // "An MCP tool we built" (servers, clients and tools): a curated list, so a new entry gets the tag on purpose.
  it('mcp-server-built is in the taxonomy and sits on exactly the entries the owner named', () => {
    expect(known.has('mcp-server-built')).toBe(true);
    expect(demos.filter((d) => d.tags.includes('mcp-server-built')).map((d) => d.id).sort()).toEqual(['hostile-mcp', 'mcp-resource-server', 'mcp-scanner', 'mcp-surface-lab', 'mcp-tools']);
    // mcp-tools and mcp-scanner are one app (port 4810) listed twice, kind Tester: the owner counts it as ours.
    expect(demos.find((d) => d.id === 'mcp-tools').url).toBe(demos.find((d) => d.id === 'mcp-scanner').url);
  });
  it('every entry is tagged, every tag exists, and every entry says simulated and/or real', () => {
    for (const d of demos) {
      expect(d.tags?.length, `${d.id} has no tags`).toBeGreaterThan(0);
      for (const t of d.tags) expect(known.has(t), `${d.id}: ${t}`).toBe(true);
      expect(d.tags.some((t) => t === 'simulated' || t === 'real'), `${d.id} needs simulated or real`).toBe(true);
    }
  });
  it('every tag in the taxonomy is used by a registered demo or a planned idea (no dead chips)', () => {
    const { catalogTags } = loadAll({ ...process.env, SHELF_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'seed-')) });
    const used = new Set([...demos.flatMap((d) => d.tags), ...Object.values(catalogTags).flat()]);
    expect([...known].filter((t) => !used.has(t))).toEqual([]);
  });
  it('mock-only copies are simulated and never real', () => {
    for (const d of expandWhere(demos).filter((c) => c.where === 'mock')) {
      expect(d.tags, d.id).toContain('simulated');
      expect(d.tags, d.id).not.toContain('real');
    }
  });
});

describe('tags on planned ideas (data/catalog-tags.json)', () => {
  const opts = { tagIds: ids, catalogIds: new Set(['A1', 'A2']) };
  const msg = (raw) => { try { validateCatalogTags(raw, opts); return ''; } catch (e) { return e instanceof RegistryError ? e.message : String(e); } };
  it('keeps known tags, de-duplicated', () => {
    expect(validateCatalogTags({ tags: { A1: ['a', 'b', 'a'] } }, opts)).toEqual({ A1: ['a', 'b'] });
  });
  it('refuses an unknown tag, an unknown catalog row and a bad shape, naming each', () => {
    expect(msg({ tags: { A1: ['nope'] } })).toMatch(/A1: unknown tag "nope"/);
    expect(msg({ tags: { Z9: ['a'] } })).toMatch(/Z9: not a row in data\/catalog.json/);
    expect(msg({ tags: { A1: 'a' } })).toMatch(/A1: must be an array/);
    expect(msg({ tags: [] })).toMatch(/"tags" must be an object/);
    expect(msg(null)).toMatch(/"tags" must be an object/);
  });
  it('a missing file means no tags; bad JSON is a clear error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctags-'));
    expect(loadCatalogTags(path.join(dir, 'none.json'), opts)).toEqual({});
    fs.writeFileSync(path.join(dir, 'bad.json'), '{nope');
    expect(() => loadCatalogTags(path.join(dir, 'bad.json'), opts)).toThrow(/not valid JSON/);
  });
  it('GET /api/shelf puts the tags on planned cards, and an untagged row gets []', async () => {
    const app = createApp({ demos: [], catalog: { items: [{ id: 'A1', name: 'One', status: 'active' }, { id: 'A2', name: 'Two', status: 'active' }] }, tags: validateTaxonomy(tax), catalogTags: { A1: ['a'] }, allowStart: false, fetchFn: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
    const res = await request(app).get('/api/shelf').set('Host', '127.0.0.1');
    expect(Object.fromEntries(res.body.planned.map((p) => [p.id, p.tags]))).toEqual({ A1: ['a'], A2: [] });
  });
});

describe('the committed planned-idea tags', () => {
  const { catalog, tags, demos, catalogTags } = loadAll({ ...process.env, SHELF_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'seed-')) });
  const known = tagIdSet(tags);
  const planned = catalog.items.filter((i) => i.status === 'active' && !demos.some((d) => d.catalogId === i.id || d.alsoCatalogIds?.includes(i.id)));
  it('every planned idea is tagged, with no mode tag (nothing is built yet)', () => {
    expect(planned.length).toBeGreaterThanOrEqual(0); // zero once every active idea has an app
    for (const i of planned) {
      expect(catalogTags[i.id]?.length, `${i.id} has no tags`).toBeGreaterThan(0);
      for (const t of catalogTags[i.id]) expect(known.has(t), `${i.id}: ${t}`).toBe(true);
      expect(catalogTags[i.id], i.id).not.toContain('simulated');
      expect(catalogTags[i.id], i.id).not.toContain('real');
    }
  });
});

describe('untaggedPlanned', () => {
  const catalog = { items: [{ id: 'A1', status: 'active' }, { id: 'A2', status: 'active' }, { id: 'A3', status: 'active' }, { id: 'A4', status: 'backlog' }] };
  it('lists active rows with no registered demo and no tags; ignores backlog and registered rows', () => {
    expect(untaggedPlanned(catalog, [{ catalogId: 'A3' }], { A1: ['a'] })).toEqual(['A2']);
    expect(untaggedPlanned(catalog, [], { A1: [] })).toEqual(['A1', 'A2', 'A3']);
    expect(untaggedPlanned(catalog, [{ catalogId: 'A3', alsoCatalogIds: ['A1'] }], {})).toEqual(['A2']);
  });
});

describe('where: both', () => {
  const registry = validateDemos([
    demo({ id: 'both-demo', catalogId: 'A1', where: 'both', mockUrl: 'https://mocks.example', tags: ['a', 'real'] }),
    demo({ id: 'local-demo', catalogId: 'A2', url: 'http://localhost:4501', tags: ['a', 'real'] }),
  ], { tagIds: ids, allowedHosts: ['mocks.example'] });
  const catalog = { items: ['A1', 'A2', 'A3'].map((id) => ({ id, name: id, status: 'active' })) };
  it('lists the installed and the hosted copy of a both-demo, and a registered row does not come back as planned', async () => {
    const app = createApp({ demos: registry, catalog, tags: validateTaxonomy(tax), allowStart: false, fetchFn: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
    const b = (await request(app).get('/api/shelf').set('Host', '127.0.0.1')).body;
    expect(b.demos.map((d) => d.id)).toEqual(['both-demo', 'both-demo-mock', 'local-demo']);
    expect(b.planned.map((p) => p.id)).toEqual(['A3']);
  });
});
