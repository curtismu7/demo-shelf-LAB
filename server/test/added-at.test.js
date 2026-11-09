import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { isNewDemo, loadRegistry, NEW_WINDOW_HOURS, parseAddedAt, validateDemos } from '../src/registry.js';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const now = () => NOW;
const ok = { id: 'demo-a', name: 'A', description: 'd', url: 'http://localhost:4500' };
const errs = (d) => { try { validateDemos([d], { now }); } catch (e) { return e.errors.join('\n'); } return ''; };
const H = 3600 * 1000;

describe('addedAt in the registry', () => {
  it('is optional', () => {
    expect(errs(ok)).toBe('');
    expect(validateDemos([ok], { now })[0].addedAt).toBeUndefined();
  });
  it('accepts a date or an ISO timestamp with Z or an offset, and keeps it as written', () => {
    for (const v of ['2026-11-01', '2026-11-09T05:06:25-06:00', '2026-11-09T11:59:59Z', '2026-11-09T11:00:00.123Z']) {
      expect(errs({ ...ok, addedAt: v })).toBe('');
      expect(validateDemos([{ ...ok, addedAt: v }], { now })[0].addedAt).toBe(v);
    }
  });
  it('refuses text that is not a real date', () => {
    for (const v of ['yesterday', '2026-02-30', '2026-13-01', '2026-11-09T07:00', '2026-11-09 07:00:00Z', '9 Nov 2026', 20261109, '', null]) {
      expect(errs({ ...ok, addedAt: v })).toMatch(/addedAt must be a date/);
    }
  });
  it('refuses a date in the future', () => {
    expect(errs({ ...ok, addedAt: '2026-11-11' })).toMatch(/addedAt 2026-11-11 is in the future/);
    // A date-only value may run up to 14 h ahead of UTC (it is someone's local today): 2026-11-10 is 12 h ahead here.
    expect(errs({ ...ok, addedAt: '2026-11-10' })).toBe('');
    expect(() => validateDemos([{ ...ok, addedAt: '2026-11-10' }], { now: () => Date.parse('2026-11-09T09:59:59Z') })).toThrow(/in the future/);
    expect(errs({ ...ok, addedAt: '2026-11-09T12:00:01Z' })).toMatch(/in the future/);
    expect(errs({ ...ok, addedAt: '2026-11-09T12:00:00Z' })).toBe('');
  });
  it('is allowed in the local file too, and checked there', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-added-'));
    const seedFile = path.join(dir, 'seed.json');
    const localFile = path.join(dir, 'local.json');
    fs.writeFileSync(seedFile, JSON.stringify({ demos: [ok] }));
    fs.writeFileSync(localFile, JSON.stringify({ demos: [{ id: 'demo-a', addedAt: '2026-11-08' }] }));
    expect(loadRegistry({ seedFile, localFile, now })[0].addedAt).toBe('2026-11-08');
    fs.writeFileSync(localFile, JSON.stringify({ demos: [{ id: 'demo-a', addedAt: '2099-01-01' }] }));
    expect(() => loadRegistry({ seedFile, localFile, now })).toThrow(/in the future/);
  });
  it('parseAddedAt reads a date as UTC midnight', () => {
    expect(parseAddedAt('2026-11-09')).toBe(Date.parse('2026-11-09T00:00:00Z'));
    expect(parseAddedAt('2026-02-30')).toBeNull();
  });
});

describe('isNew: a rolling 48 hour window', () => {
  const at = (msAgo) => new Date(NOW - msAgo).toISOString();
  it('is 48 hours', () => expect(NEW_WINDOW_HOURS).toBe(48));
  it('is new at 47 h 59 min and not at 48 h 01 min', () => {
    expect(isNewDemo(at(47 * H + 59 * 60 * 1000), NOW)).toBe(true);
    expect(isNewDemo(at(48 * H + 60 * 1000), NOW)).toBe(false);
    expect(isNewDemo(at(48 * H), NOW)).toBe(false);
    expect(isNewDemo(at(0), NOW)).toBe(true);
  });
  it('is never new without a valid addedAt, or with one in the future', () => {
    expect(isNewDemo(undefined, NOW)).toBe(false);
    expect(isNewDemo('nope', NOW)).toBe(false);
    expect(isNewDemo(new Date(NOW + H).toISOString(), NOW)).toBe(false);
  });
});

describe('GET /api/shelf reports isNew from the server clock', () => {
  const demos = [
    { id: 'fresh', name: 'Fresh', description: 'x', url: 'http://localhost:4500', addedAt: new Date(NOW - 47 * H - 59 * 60 * 1000).toISOString() },
    { id: 'old', name: 'Old', description: 'y', url: 'http://localhost:4501', addedAt: new Date(NOW - 48 * H - 60 * 1000).toISOString() },
    { id: 'undated', name: 'Undated', description: 'z', url: 'http://localhost:4502' },
    { id: 'both-new', name: 'Both', description: 'w', url: 'http://localhost:4503', where: 'both', mockUrl: 'http://localhost:4600', addedAt: '2026-11-09' },
  ];
  const fetchFn = vi.fn(async () => { throw new Error('refused'); });
  it('carries addedAt, isNew per card and newWindowHours', async () => {
    let t = NOW;
    const app = createApp({ demos, catalog: { items: [] }, fetchFn, wait: async () => {}, now: () => t });
    const r = await request(app).get('/api/shelf').set('Host', 'localhost:4400');
    expect(r.status).toBe(200);
    expect(r.body.newWindowHours).toBe(48);
    expect(r.body.demos.map((d) => [d.id, d.isNew])).toEqual([['fresh', true], ['old', false], ['undated', false], ['both-new', true], ['both-new-mock', true]]);
    expect(r.body.demos.find((d) => d.id === 'undated').addedAt).toBeNull();
    expect(r.body.demos[0].addedAt).toBe(demos[0].addedAt);
    t = NOW + 2 * 60 * 1000; // two minutes later the fresh one has rolled out
    const later = await request(app).get('/api/shelf').set('Host', 'localhost:4400');
    expect(later.body.demos.find((d) => d.id === 'fresh').isNew).toBe(false);
  });
});

describe('the committed seed', () => {
  it('gives every demo a valid addedAt that is not in the future', () => {
    const seed = JSON.parse(fs.readFileSync(new URL('../../data/demos.json', import.meta.url), 'utf8'));
    const missing = seed.demos.filter((d) => parseAddedAt(d.addedAt) === null).map((d) => d.id);
    expect(missing).toEqual([]);
    for (const d of seed.demos) expect(parseAddedAt(d.addedAt)).toBeLessThanOrEqual(Date.now());
  });
});
