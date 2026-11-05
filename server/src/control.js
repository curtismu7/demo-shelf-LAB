// Start/stop. Runs exactly `docker compose -f <file> [-f <overlay>...] up -d` or `down` for a
// registered demo, via execFile (no shell), and only when Docker's current context is OrbStack.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureRepo } from './deploy.js';

export const EXEC_TIMEOUT_MS = 60_000;
// The first Start builds the image, which takes minutes; killing it at 60 s made every first Start fail and look like nothing happened.
export const START_TIMEOUT_MS = 600_000;
const OUT_MAX = 2000;
// Only what docker needs. No tokens, no cloud credentials, no DOCKER_HOST (it could point away from the context we check).
const PASS_ENV = ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'DOCKER_CONFIG'];

export function defaultExec(file, args, { timeoutMs = EXEC_TIMEOUT_MS, cwd } = {}) {
  const env = Object.fromEntries(PASS_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1 << 20, env, shell: false, cwd }, (err, stdout, stderr) => {
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
  const tail = { start: ['up', '-d'], stop: ['down'], images: ['config', '--images'] }[action];
  if (!tail) throw new Error(`unknown action: ${action}`);
  return ['compose', ...files, ...tail];
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

// 'ok' only when Docker's current context is OrbStack. Shared by Start / Stop and the install check.
export async function orbstackGuard(exec, opts) {
  let ctx;
  try { ctx = (await (opts ? exec('docker', ['context', 'show'], opts) : exec('docker', ['context', 'show']))).stdout.trim(); } catch { return 'docker-unavailable'; }
  return ctx === 'orbstack' ? 'ok' : 'docker-context-not-orbstack';
}

// The one place that touches Docker. Used by the shelf (host-run) and by the start agent. Returns { status, body }.
// `exec` and `fileExists` are injectable for tests.
export async function runCompose(demo, action, { exec = defaultExec, fileExists = fs.existsSync, shelfDir = null } = {}) {
  const fail = (status, error, extra = {}) => ({ status, body: { ok: false, error, ...extra } });
  if (isShelfItself(demo, shelfDir)) return fail(409, 'is-the-shelf');
  const guard = await orbstackGuard(exec);
  if (guard === 'docker-unavailable') return fail(503, guard);
  if (guard !== 'ok') return fail(409, guard);
  const missing = [demo.composeFile, ...(demo.composeOverlays || [])].filter((f) => !fileExists(f));
  if (missing.length) return fail(409, 'compose-file-missing', { missing });
  try {
    // Run from the compose file's own folder, as a person would: relative paths, .env and build contexts then resolve the same way.
    const out = await exec('docker', composeArgs(demo, action), { cwd: path.dirname(demo.composeFile), timeoutMs: action === 'start' ? START_TIMEOUT_MS : EXEC_TIMEOUT_MS });
    return { status: 200, body: { ok: true, id: demo.id, action, output: redact(`${out.stdout}\n${out.stderr}`) } };
  } catch (e) {
    const timedOut = e.killed || e.signal === 'SIGTERM';
    return fail(502, timedOut ? 'timeout' : 'compose-failed', { output: redact(`${e.stdout || ''}\n${e.stderr || ''}`) });
  }
}

// Express middleware factory. With `agent` (the shelf in a container) the compose call is handed to the host-side start agent;
// without it the shelf runs Docker itself. `inDocker` skips the remote-address check, because inside a container every request
// arrives from the Docker network: the compose file publishes the port on 127.0.0.1 only, and the Host and Origin checks still apply.
export function createControlRouter({ express, getDemos, onChange, exec = defaultExec, fileExists = fs.existsSync, agent = null, inDocker = false, shelfDir = null, demoRoot = null }) {
  const router = express.Router({ caseSensitive: true });
  const busy = new Set();

  router.post('/demos/:id/:action(start|stop|deploy)', async (req, res) => {
    const fail = (code, error) => res.status(code).json({ ok: false, error });
    if (!inDocker && !isLoopbackAddr(req.socket.remoteAddress)) return fail(403, 'loopback-only');
    // Same-origin: a browser POST always carries Origin. A missing or foreign one is refused.
    // Behind the lab-proxy the browser's Origin is https://local.ping-devops.com:8443 while the
    // proxied Host header is the lab's own; the proxy forwards the original as X-Forwarded-*,
    // and that pair becomes the expected origin.
    const xfHost = req.headers['x-forwarded-host'];
    const expectedOrigin = xfHost ? `${req.headers['x-forwarded-proto'] || 'https'}://${xfHost}` : `http://${req.headers.host}`;
    if (!req.headers.origin || req.headers.origin !== expectedOrigin) return fail(403, 'bad-origin');
    const demo = getDemos().find((d) => d.id === req.params.id);
    if (!demo) return fail(404, 'unknown-demo');
    if (!demo.composeFile) return fail(400, 'no-compose-file');
    if (busy.has(demo.id)) return fail(409, 'busy');
    busy.add(demo.id);
    try {
      if (req.params.action === 'deploy') {
        if (!demo.repo) return fail(400, 'no-repo');
        if (agent) {
          // Containerised shelf: the host-side start agent owns the demo root and git. It
          // clones/fast-forwards the registry-validated repo, then runs compose start.
          if (!demoRoot) return fail(409, 'no-demo-root');
          const r = await agent.run(demo.id, 'deploy');
          if (r.status === 200) onChange?.(demo.id);
          return res.status(r.status).json(r.body);
        }
        if (!demoRoot) return fail(409, 'no-demo-root');
        const g = await ensureRepo(demo, demoRoot, { exec });
        if (!g.ok) return res.status(409).json({ ok: false, error: g.error, output: redact(g.output || '') });
        const r = await runCompose(demo, 'start', { exec, fileExists, shelfDir });
        if (r.status === 200) onChange?.(demo.id);
        return res.status(r.status).json({ ...r.body, deploy: g.how, dir: g.dir });
      }
      const r = agent ? await agent.run(demo.id, req.params.action) : await runCompose(demo, req.params.action, { exec, fileExists, shelfDir });
      if (r.status === 200) onChange?.(demo.id);
      return res.status(r.status).json(r.body);
    } catch {
      return fail(500, 'internal'); // Express 4 does not catch a rejected handler: answer instead of hanging
    } finally {
      busy.delete(demo.id);
    }
  });

  return router;
}
