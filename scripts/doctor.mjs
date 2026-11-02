#!/usr/bin/env node
// Checks the shelf can run here and names the fix. Reads no secrets; prints none.
import { execFile } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';
import { alsoCatalogProblems } from '../server/src/registry.js';
import { loadAll, resolveBind, resolvePort } from '../server/src/index.js';

const run = promisify(execFile);
const results = [];
const check = (name, ok, fix) => results.push({ name, ok, fix });

function portFree(host, port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

try {
  const bind = resolveBind();
  const port = resolvePort();
  check('Node 26 or newer', Number(process.versions.node.split('.')[0]) >= 26, 'Install Node 26 (nvm install 26).');
  check(`Bind address ${bind.host}`, bind.loopback || bind.explicit, 'Set SHELF_BIND on purpose to listen beyond loopback.');
  check(`Port ${port} is free`, await portFree(bind.host, port), `Something already listens on ${port}. Set SHELF_PORT to another 4400+ port.`);
  try {
    const { demos, catalog } = loadAll();
    check(`Registry valid (${demos.length} demos)`, true);
    const bad = alsoCatalogProblems(demos, catalog);
    check('alsoCatalogIds all name free catalog rows', !bad.length, bad.join('; '));
    check(`Catalog present (${catalog.items?.length ?? 0} items)`, (catalog.items?.length ?? 0) > 0, 'Run: npm run catalog -- <path to standalone-demo-family-plan.md>');
  } catch (e) {
    check('Registry valid', false, e.message);
  }
  // Docker on OrbStack is how every demo starts, so it is required, not optional.
  // A hosted CI runner has Docker but not OrbStack, so there the Docker checks only report.
  const ci = process.env.CI === 'true';
  let ctx = null;
  try { ctx = (await run('docker', ['context', 'show'])).stdout.trim(); } catch { /* reported below */ }
  check(`docker CLI runs${ci && ctx === null ? ' (not required in CI)' : ''}`, ci || ctx !== null, 'Install OrbStack and make sure `docker` is on PATH (open -a OrbStack).');
  if (ctx !== null) check(`docker context is orbstack (is "${ctx}")${ci && ctx !== 'orbstack' ? ' (not required in CI)' : ''}`, ci || ctx === 'orbstack', 'Run: docker context use orbstack. Never use Docker Desktop.');
  // The start agent is only needed by the shelf in a container; report it, do not fail on it.
  const agentPort = Number(process.env.SHELF_AGENT_PORT || 4405);
  const agentUp = !(await portFree('127.0.0.1', agentPort));
  check(`start agent ${agentUp ? `is listening on ${agentPort}` : 'is not running (only the container shelf needs it: npm run agent)'}`, true);
} catch (e) {
  check('Configuration', false, e.message);
}

for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      fix: ${r.fix}`}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
