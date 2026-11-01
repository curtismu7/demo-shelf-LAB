#!/usr/bin/env node
// npm run docker        build and start the shelf container
// npm run docker:down   stop it
// Creates the start agent's token if it does not exist, and passes the container the two settings compose needs. The token goes
// in the container's environment only: it is never printed.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureToken } from '../server/src/agent.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const action = process.argv[2] === 'down' ? 'down' : 'up';

try {
  const ctx = execFileSync('docker', ['context', 'show'], { encoding: 'utf8' }).trim();
  if (ctx !== 'orbstack') throw new Error(`Docker's context is "${ctx}", not orbstack. Run: docker context use orbstack`);
} catch (e) {
  console.error(e.code === 'ENOENT' ? 'docker not found. Install OrbStack (open -a OrbStack).' : e.message);
  process.exit(1);
}

const env = {
  ...process.env,
  SHELF_DEMO_ROOT: process.env.SHELF_DEMO_ROOT || path.dirname(root),
  SHELF_AGENT_TOKEN: ensureToken(path.join(root, '.data')),
};
try {
  execFileSync('docker', ['compose', ...(action === 'down' ? ['down'] : ['up', '-d', '--build'])], { cwd: root, env, stdio: 'inherit' });
} catch {
  process.exit(1);
}
if (action === 'up') {
  console.log(`\nShelf: http://127.0.0.1:${process.env.SHELF_HOST_PORT || 4400}`);
  console.log('For Start / Stop, keep the start agent running on this machine: npm run agent');
}
