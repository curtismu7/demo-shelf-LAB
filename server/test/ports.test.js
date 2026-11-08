import { describe, it, expect } from 'vitest';
import { PACKED_RANGE, nextFreePorts, packedRangeSummary } from '../../scripts/ports-lib.mjs';

describe('packed port range for new apps', () => {
  it('is 7800-7999, above every app that predates the allocator', async () => {
    expect(PACKED_RANGE).toEqual({ lo: 7800, hi: 7999 });
    const demos = (await import('../../data/demos.json', { with: { type: 'json' } })).default.demos;
    const ports = demos.filter((d) => d.url).map((d) => Number(new URL(d.url).port));
    // Apps that were placed by the allocator live inside the range; every older app is below it.
    const allocated = new Set([7800, 7801, 7802, 7804]); // observability-lab, privilege-logging-lab, aggregate-entitlement-lab, field-notes-lab
    expect(Math.max(...ports.filter((p) => p < 8000 && !allocated.has(p)))).toBeLessThan(PACKED_RANGE.lo);
  });
  it('hands out the lowest free ports in order and skips used ones', () => {
    expect(nextFreePorts([])).toEqual([7800]);
    expect(nextFreePorts([7800, 7802], 3)).toEqual([7801, 7803, 7804]);
  });
  it('ignores ports outside the range, string ports, and duplicates', () => {
    expect(nextFreePorts([4510, 7710, '7800', 7800, 8081], 2)).toEqual([7801, 7802]);
  });
  it('refuses a bad count and an exhausted range', () => {
    for (const bad of [0, -1, 1.5, NaN]) expect(() => nextFreePorts([], bad)).toThrow(/whole number/);
    const full = Array.from({ length: 200 }, (_, i) => 7800 + i);
    expect(() => nextFreePorts(full)).toThrow(/only 0 free/);
    expect(nextFreePorts(full.slice(0, 199))).toEqual([7999]);
    expect(() => nextFreePorts(full.slice(0, 199), 2)).toThrow(/only 1 free/);
  });
  it('summarises use of the range', () => {
    expect(packedRangeSummary([4510, 7800, 7801, 7999])).toEqual({ size: 200, inUse: 3, free: 197 });
  });
});
