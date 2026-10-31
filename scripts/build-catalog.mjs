#!/usr/bin/env node
// Usage: node scripts/build-catalog.mjs <path-to-standalone-demo-family-plan.md> [--out data/catalog.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCatalog } from './lib/catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = path.resolve(root, outAt >= 0 ? args[outAt + 1] : 'data/catalog.json');
const plan = args.find((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));
if (!plan) {
  console.error('usage: node scripts/build-catalog.mjs <path-to-plan.md> [--out data/catalog.json]');
  process.exit(2);
}
const catalog = parseCatalog(fs.readFileSync(plan, 'utf8'));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(catalog, null, 2) + '\n');
const n = (s) => catalog.items.filter((i) => i.status === s).length;
console.log(`catalog: ${n('active')} active, ${n('backlog')} backlog, ${n('retired')} retired -> ${path.relative(root, out)}`);
