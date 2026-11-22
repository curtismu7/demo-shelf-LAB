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
const pairs = [...block.matchAll(/'([^']+)':\s*'([^']+)'/g)].map((m) => [m[1], m[2].replace(/^\/+|\/+$/g, '')]);
const keys = pairs.map(([id]) => id);
const seed = JSON.parse(fs.readFileSync(path.join(here, '../../data/demos.json'), 'utf8')).demos;
const ids = new Set(seed.map((d) => d.id));
const composeOf = new Map(seed.map((d) => [d.id, d.composeFile]));
// Two entries for one app (same compose file, e.g. mcp-tools and mcp-scanner) may share a path: either id starts the same app.
const sameApp = (a, b) => Boolean(composeOf.get(a)) && composeOf.get(a) === composeOf.get(b);

describe('PROXY_PATHS', () => {
  it('is found and not empty', () => expect(keys.length).toBeGreaterThan(0));
  it('uses only real shelf ids as keys', () => {
    expect(keys.filter((k) => !ids.has(k))).toEqual([]);
  });
  // Each proxy path is one lab's, and the down page's Start sends that path as the id (control.js resolves it):
  // a path shared by two labs, or equal to another lab's id, would start the wrong lab.
  it('gives every lab its own path, never another lab\'s id', () => {
    const seen = new Map();
    const clashes = [];
    for (const [id, seg] of pairs) {
      if (seen.has(seg) && !sameApp(seen.get(seg), id)) clashes.push(`${seg}: ${seen.get(seg)} and ${id}`);
      seen.set(seg, id);
      if (seg !== id && ids.has(seg) && !sameApp(seg, id)) clashes.push(`${id} uses ${seg}, which is another lab's id`);
    }
    expect(clashes).toEqual([]);
  });
});
