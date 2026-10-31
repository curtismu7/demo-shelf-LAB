// Opt-in start/stop. Runs exactly `docker compose -f <file> [-f <overlay>...] up -d` or `down` for a
// registered demo, via execFile (no shell), and only when Docker's current context is OrbStack.
import { execFile } from 'node:child_process';
import fs from 'node:fs';

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
  return ['compose', ...files, ...(action === 'start' ? ['up', '-d'] : ['down'])];
}

const LOOPBACK_ADDR = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const isLoopbackAddr = (a) => LOOPBACK_ADDR.has(a);

// Express middleware factory. `exec` and `fileExists` are injectable for tests.
export function createControlRouter({ express, getDemos, onChange, exec = defaultExec, fileExists = fs.existsSync }) {
  const router = express.Router();
  const busy = new Set();

  router.post('/demos/:id/:action(start|stop)', async (req, res) => {
    const fail = (code, error) => res.status(code).json({ ok: false, error });
    if (!isLoopbackAddr(req.socket.remoteAddress)) return fail(403, 'loopback-only');
    // Same-origin: a browser POST always carries Origin. A missing or foreign one is refused.
    if (!req.headers.origin || req.headers.origin !== `http://${req.headers.host}`) return fail(403, 'bad-origin');
    const demo = getDemos().find((d) => d.id === req.params.id);
    if (!demo) return fail(404, 'unknown-demo');
    if (!demo.composeFile) return fail(400, 'no-compose-file');
    if (busy.has(demo.id)) return fail(409, 'busy');
    busy.add(demo.id);
    try {
      let ctx;
      try { ctx = (await exec('docker', ['context', 'show'])).stdout.trim(); } catch { return fail(503, 'docker-unavailable'); }
      if (ctx !== 'orbstack') return fail(409, 'docker-context-not-orbstack');
      if (![demo.composeFile, ...demo.composeOverlays].every((f) => fileExists(f))) return fail(409, 'compose-file-missing');
      try {
        const out = await exec('docker', composeArgs(demo, req.params.action));
        onChange?.();
        return res.json({ ok: true, id: demo.id, action: req.params.action, output: redact(`${out.stdout}\n${out.stderr}`) });
      } catch (e) {
        const timedOut = e.killed || e.signal === 'SIGTERM';
        return res.status(502).json({ ok: false, error: timedOut ? 'timeout' : 'compose-failed', output: redact(`${e.stdout || ''}\n${e.stderr || ''}`) });
      }
    } finally {
      busy.delete(demo.id);
    }
  });

  return router;
}
