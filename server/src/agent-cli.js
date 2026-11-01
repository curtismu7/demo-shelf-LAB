// `npm run agent`: runs the start agent on this machine (loopback only). Keep it running while you use the shelf in Docker.
// Once it is listening it also runs `npm run docker` (build and start the shelf container, then open the browser). The agent keeps
// running if that fails. Skipped under CI, with SHELF_AUTOSTART=0, or with a custom SHELF_DATA_DIR (the container reads ./.data).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_PORT_DEFAULT, createAgent, ensureToken } from './agent.js';
import { expandWhere } from './app.js';
import { loadAll } from './index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = Number(process.env.SHELF_AGENT_PORT || AGENT_PORT_DEFAULT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('SHELF_AGENT_PORT must be 1-65535');
  process.exit(1);
}
const dataDir = path.resolve(process.env.SHELF_DATA_DIR || path.join(root, '.data'));
const token = ensureToken(dataDir);
const agent = createAgent({ getDemos: () => expandWhere(loadAll().demos).filter((d) => d.where === 'installed'), token, port, shelfDir: root });
agent.listen(port, '127.0.0.1', () => {
  console.log(`start agent on http://127.0.0.1:${port} (token in ${path.join(dataDir, 'agent-token')}). Ctrl-C to stop.`);
  if (process.env.CI || process.env.SHELF_AUTOSTART === '0' || process.env.SHELF_DATA_DIR) return;
  console.log('Starting the shelf container (SHELF_AUTOSTART=0 to skip)...');
  const fix = 'The agent is still running; fix the cause and run: npm run docker';
  // Its own process group, so stopping the agent can cancel a build in flight (docker compose is a grandchild).
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'docker-up.mjs'), 'up'], { cwd: root, stdio: 'inherit', detached: true });
  child.on('error', (e) => console.error(`Could not run the shelf container script: ${e.message}. ${fix}`));
  child.on('exit', (code, signal) => { if (code || signal) console.error(`The shelf container did not start (${signal ? `killed by ${signal}` : `exit ${code}`}). ${fix}`); });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already finished */ }
      process.exit(0);
    });
  }
});
