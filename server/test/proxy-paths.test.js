import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The shelf opens a lab through the lab-proxy only when PROXY_PATHS has an entry under the lab's
// registry id. A key that is not a real id silently sends that lab to its direct port instead
// (customer-agent, gateway-claims and agentcore-pingone-demo did, 2026-11-09).
const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '../src/app.js'), 'utf8');
const block = src.slice(src.indexOf('const PROXY_PATHS')).split('};')[0];
const keys = [...block.matchAll(/'([^']+)':\s*'([^']+)'/g)].map((m) => m[1]);
const ids = new Set(JSON.parse(fs.readFileSync(path.join(here, '../../data/demos.json'), 'utf8')).demos.map((d) => d.id));

describe('PROXY_PATHS', () => {
  it('is found and not empty', () => expect(keys.length).toBeGreaterThan(0));
  it('uses only real shelf ids as keys', () => {
    expect(keys.filter((k) => !ids.has(k))).toEqual([]);
  });
});
