import { describe, it, expect } from 'vitest';
import { PACKED_RANGE, RESERVED_PORTS, nextFreePorts, packedRangeSummary } from '../../scripts/ports-lib.mjs';

describe('packed port range for new apps', () => {
  it('is 7800-7999, above every app that predates the allocator', async () => {
    expect(PACKED_RANGE).toEqual({ lo: 7800, hi: 7999 });
    const demos = (await import('../../data/demos.json', { with: { type: 'json' } })).default.demos;
    const ports = demos.filter((d) => d.url).map((d) => Number(new URL(d.url).port));
    // Apps that were placed by the allocator live inside the range; every older app is below it.
    const allocated = new Set([7800, 7801, 7802, 7803, 7804, 7805, 7806, 7807, 7808, 7809, 7810, 7811, 7812, 7813, 7814, 7815, 7816, 7817, 7818, 7819, 7820, 7821, 7822, 7823, 7824, 7825, 7826, 7827, 7828, 7829, 7830, 7831, 7832, 7833, 7834, 7835, 7836, 7837, 7838, 7846]); // privilege-bedrock-assume-role-lab (7838), privilege-model-armor-lab (7846), privilege-model-fallback-lab (7836), privilege-rate-limit-lab (7837), salesforce-privilege-lab (7835), privilege-gateway-client-lab (7833), ciba-approval-sequence-LAB (7834) // privilege-gateway-client-lab (7833), the five ap console-area mocks (7839-7843, unregistered) // + intent-console-lab (7825), agent-privilege-guide-lab (7826, registry pending), privilege-google-secrets (7827), pf-array-claims-lab (7828), spiffe-issuer (7829), privilege-shelf (7830), agent-identity-academy (7831), meridian-air-lab (7832) // demo-map-lab, observability-lab, privilege-logging-lab, aggregate-entitlement-lab, pingone-events-lab, field-notes-lab, env-map-lab, pingcli-lab, mcp-skills-lab, privilege-k8-kits (7809, which is ALSO reserved for ping-shared's PingGateway: a clash to resolve), ai-demo-standalone (7810), privilege-owasp-lab (7811), pf-privilege-obo-lab (7812), privilege-api-explorer (7813), mfa-admin-mcp (7815), workload-identity-lab (7816), privilege-bulk-users (7817), pdf-to-md-lab (7818), wimse-lab (7822), workload-cert-lab (7823), pf-agent-client-sync (7824), intent-console-lab (7825)
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
  it('never hands out a port reserved by shared infrastructure (7809: ping-shared PingGateway)', () => {
    expect(Object.keys(RESERVED_PORTS)).toEqual(['7809']);
    const used = Array.from({ length: 9 }, (_, i) => 7800 + i); // 7800-7808 taken by apps
    expect(nextFreePorts(used)).toEqual([7810]);
    expect(nextFreePorts(used, 2)).toEqual([7810, 7811]);
  });
  it('summarises use of the range', () => {
    expect(packedRangeSummary([4510, 7800, 7801, 7999])).toEqual({ size: 200, inUse: 3, free: 197 });
  });
});
