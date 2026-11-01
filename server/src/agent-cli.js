// `npm run agent`: runs the start agent on this machine (loopback only). Keep it running while you use the shelf in Docker.
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
const agent = createAgent({ getDemos: () => expandWhere(loadAll().demos).filter((d) => d.where === 'installed'), token, port });
agent.listen(port, '127.0.0.1', () => {
  console.log(`start agent on http://127.0.0.1:${port} (token in ${path.join(dataDir, 'agent-token')}). Ctrl-C to stop.`);
});
