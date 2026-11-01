// Start/stop. Runs exactly `docker compose -f <file> [-f <overlay>...] up -d` or `down` for a
// registered demo, via execFile (no shell), and only when Docker's current context is OrbStack.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const EXEC_TIMEOUT_MS = 60_000;
const OUT_MAX = 2000;
// Only what docker needs. No tokens, no cloud credentials, no DOCKER_HOST (it could point away from the context we check).
const PASS_ENV = ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'DOCKER_CONFIG'];

export function defaultExec(file, args) {
  const env = Object.fromEntries(PASS_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 1 << 20, env, shell: false }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
      resolve({ stdout, stderr });
    });
  });
}

// Trim and scrub command output before it reaches the browser.
export function redact(text) {
  return String(text ?? '')
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b([A-Za-z0-9_.-]*(?:secret|token|password|passwd|apikey|api_key|credential|authorization)[A-Za-z0-9_.-]*)(\s*[=:]\s*)\S+/gi, '$1$2[redacted]')
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '[redacted]')
    .trim()
    .slice(-OUT_MAX);
}

export function composeArgs(demo, action) {
  const files = [demo.composeFile, ...(demo.composeOverlays || [])].flatMap((f) => ['-f', f]);
  if (action !== 'start' && action !== 'stop') throw new Error(`unknown action: ${action}`);
  return ['compose', ...files, ...(action === 'start' ? ['up', '-d'] : ['down'])];
}

const LOOPBACK_ADDR = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const isLoopbackAddr = (a) => LOOPBACK_ADDR.has(a);

// Compose names a project after its folder (lower case, only a-z 0-9 _ -). `down` stops the whole project, so a demo whose compose file
// is in the shelf's own folder, or in a folder that gives the same project name, must never be stopped from the shelf.
const projectOf = (file) => path.basename(path.dirname(path.resolve(file))).toLowerCase().replace(/[^a-z0-9_-]/g, '');
export const isShelfItself = (demo, shelfDir) => {
  if (!shelfDir) return false;
  const mine = projectOf(path.join(shelfDir, 'docker-compose.yml'));
  return [demo.composeFile, ...(demo.composeOverlays || [])].some((f) => path.resolve(path.dirname(path.resolve(f))) === path.resolve(shelfDir) || projectOf(f) === mine);
};

// The one place that touches Docker. Used by the shelf (host-run) and by the start agent. Returns { status, body }.
// `exec` and `fileExists` are injectable for tests.
export async function runCompose(demo, action, { exec = defaultExec, fileExists = fs.existsSync, shelfDir = null } = {}) {
  const fail = (status, error, extra = {}) => ({ status, body: { ok: false, error, ...extra } });
  if (isShelfItself(demo, shelfDir)) return fail(409, 'is-the-shelf');
  let ctx;
  try { ctx = (await exec('docker', ['context', 'show'])).stdout.trim(); } catch { return fail(503, 'docker-unavailable'); }
  if (ctx !== 'orbstack') return fail(409, 'docker-context-not-orbstack');
  const missing = [demo.composeFile, ...(demo.composeOverlays || [])].filter((f) => !fileExists(f));
  if (missing.length) return fail(409, 'compose-file-missing', { missing });
  try {
    const out = await exec('docker', composeArgs(demo, action));
    return { status: 200, body: { ok: true, id: demo.id, action, output: redact(`${out.stdout}\n${out.stderr}`) } };
  } catch (e) {
    const timedOut = e.killed || e.signal === 'SIGTERM';
    return fail(502, timedOut ? 'timeout' : 'compose-failed', { output: redact(`${e.stdout || ''}\n${e.stderr || ''}`) });
  }
}

// Express middleware factory. With `agent` (the shelf in a container) the compose call is handed to the host-side start agent;
// without it the shelf runs Docker itself. `inDocker` skips the remote-address check, because inside a container every request
// arrives from the Docker network: the compose file publishes the port on 127.0.0.1 only, and the Host and Origin checks still apply.
export function createControlRouter({ express, getDemos, onChange, exec = defaultExec, fileExists = fs.existsSync, agent = null, inDocker = false, shelfDir = null }) {
  const router = express.Router({ caseSensitive: true });
  const busy = new Set();

  router.post('/demos/:id/:action(start|stop)', async (req, res) => {
    const fail = (code, error) => res.status(code).json({ ok: false, error });
    if (!inDocker && !isLoopbackAddr(req.socket.remoteAddress)) return fail(403, 'loopback-only');
    // Same-origin: a browser POST always carries Origin. A missing or foreign one is refused.
    if (!req.headers.origin || req.headers.origin !== `http://${req.headers.host}`) return fail(403, 'bad-origin');
    const demo = getDemos().find((d) => d.id === req.params.id);
    if (!demo) return fail(404, 'unknown-demo');
    if (!demo.composeFile) return fail(400, 'no-compose-file');
    if (busy.has(demo.id)) return fail(409, 'busy');
    busy.add(demo.id);
    try {
      const r = agent ? await agent.run(demo.id, req.params.action) : await runCompose(demo, req.params.action, { exec, fileExists, shelfDir });
      if (r.status === 200) onChange?.();
      return res.status(r.status).json(r.body);
    } catch {
      return fail(500, 'internal'); // Express 4 does not catch a rejected handler: answer instead of hanging
    } finally {
      busy.delete(demo.id);
    }
  });

  return router;
}
