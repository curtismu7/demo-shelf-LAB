#!/usr/bin/env node
// npm run docker        build and start the shelf container
// npm run docker:down   stop it
// Creates the start agent's token if it does not exist, and passes the container the two settings compose needs. The token goes
// in the container's environment only: it is never printed.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureToken } from '../server/src/agent.js';
import { loadShelfEnv } from '../server/src/dotenv.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadShelfEnv(root);
const action = process.argv[2] === 'down' ? 'down' : 'up';

try {
  // Any working Docker engine is fine (OrbStack preferred, Docker Desktop works).
  // Only fail when docker itself is missing or the daemon does not answer.
  execFileSync('docker', ['info'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  console.error(e.code === 'ENOENT' ? 'docker not found. Install OrbStack (open -a OrbStack).' : 'Docker is not running (docker info failed). Start OrbStack and re-run.');
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
  const url = `http://127.0.0.1:${process.env.SHELF_HOST_PORT || 4400}`;
  console.log(`\nShelf: ${url}`);
  console.log('Start / Stop on the cards need the start agent running on this machine: npm run agent.');
  // Open it in the default browser once it answers. SHELF_OPEN=0 (or CI) turns this off.
  if (process.env.SHELF_OPEN !== '0' && !process.env.CI) {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      up = await fetch(`${url}/api/health`).then((r) => r.ok, () => false);
      if (!up) await new Promise((r) => setTimeout(r, 500));
    }
    if (!up) console.log('The shelf did not answer within 30 s; not opening the browser. Check: docker compose logs');
    else {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      try { execFileSync(opener, [url], { stdio: 'ignore' }); } catch { console.log(`Could not open a browser; go to ${url}`); }
    }
  }
}
