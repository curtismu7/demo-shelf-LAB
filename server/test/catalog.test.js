import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCatalog } from '../../scripts/lib/catalog.mjs';

const plan = fs.readFileSync(new URL('./fixtures/plan.md', import.meta.url), 'utf8');

describe('parseCatalog', () => {
  const c = parseCatalog(plan);
  it('reads id, name, kind, group, seed, wave and status', () => {
    expect(c.items).toEqual([
      { id: 'A1', name: 'MFA tester', kind: 'Tester', group: 'A', seed: 'built', wave: 0, status: 'active' },
      { id: 'A2', name: 'Passkey', kind: 'Tester', group: 'A', seed: 'partial', wave: 1, status: 'active' },
      { id: 'A3', name: 'Big thing', kind: null, group: 'A', seed: 'none', wave: 'backlog', status: 'backlog' },
      { id: 'B12', name: 'Old', kind: null, group: 'B', seed: null, wave: null, status: 'retired' },
      { id: 'E2', name: 'SE demo shelf (launcher)', kind: 'Tool', group: 'E', seed: 'none', wave: 1, status: 'active' },
    ]);
  });
  it('names the groups and ignores tables outside the catalog sections', () => {
    expect(c.groups).toEqual({ A: 'Identity: things', E: 'Learning' });
    expect(c.items.some((i) => i.id === 'Z9')).toBe(false);
  });
  it('is deterministic', () => {
    expect(JSON.stringify(parseCatalog(plan))).toBe(JSON.stringify(parseCatalog(plan)));
  });
  it('rejects an id that appears in two parsed tables', () => {
    expect(() => parseCatalog(plan.replace('| B12 | Old', '| A1 | Old'))).toThrow(/A1/);
  });
});
