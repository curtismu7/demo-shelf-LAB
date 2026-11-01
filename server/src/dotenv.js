import fs from 'node:fs';
import path from 'node:path';

// Per-machine settings (SHELF_DEMO_ROOT and the like) from the shelf's git-ignored .env. Variables already set in the environment
// win. Host side only: the container gets its settings from compose, and the start agent's token never belongs in this file.
// SHELF_ENV_FILE points somewhere else (the tests point it at an empty file).
export function loadShelfEnv(root, env = process.env) {
  if (env.SHELF_IN_DOCKER === '1') return null;
  const file = path.resolve(env.SHELF_ENV_FILE || path.join(root, '.env'));
  if (!fs.existsSync(file)) return null;
  const before = { ...env };
  process.loadEnvFile(file);
  return Object.keys(process.env).filter((k) => !(k in before));
}
