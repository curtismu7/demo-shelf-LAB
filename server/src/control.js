// Start/stop. Runs exactly `docker compose -f <file> [-f <overlay>...] up -d` or `down` for a
// registered demo, via execFile (no shell), and only when Docker's current context is OrbStack.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureRepo } from './deploy.js';
// Shared Ping products a demo leans on (Rule 20): Start also brings these up.
import { SHARED_CONTAINERS } from './pingProducts.js';

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

// Start the shared product containers the demo declares (pingProducts). Already-running ones are left alone;
// a shared container that is missing entirely is not an error (that machine simply does not run that product).
// Returns the names it started.
export async function startSharedContainers(demo, exec) {
  const wanted = [...new Set(demo.pingProducts || [])].map((p) => SHARED_CONTAINERS[p]).filter(Boolean);
  if (!wanted.length) return [];
  const started = [];
  for (const container of wanted) {
    let st = '';
    try { st = (await exec('docker', ['ps', '-a', '--filter', `name=^${container}$`, '--format', '{{.Status}}'])).stdout.trim(); } catch { return started; }
    if (!st) continue; // no such container on this machine
    if (st.startsWith('Up')) continue;
    try { await exec('docker', ['start', container]); started.push(container); } catch { /* leave it: the demo still starts */ }
  }
  return started;
}

// Stop the shared product containers (Stop all: shared services go down with the demos).
// Never stopped by the running-cap logic — only by an explicit Stop all (or this route).
// Returns the names it stopped.
export async function stopSharedContainers(getDemos, exec) {
  const wanted = [...new Set((getDemos() || []).flatMap((d) => d.pingProducts || []))]
    .map((p) => SHARED_CONTAINERS[p]).filter(Boolean);
  const stopped = [];
  for (const container of [...new Set(wanted)]) {
    let st = '';
    try { st = (await exec('docker', ['ps', '-a', '--filter', `name=^${container}$`, '--format', '{{.Status}}'])).stdout.trim(); } catch { return stopped; }
    if (!st.startsWith('Up')) continue;
    try { await exec('docker', ['stop', container]); stopped.push(container); } catch { /* leave it running */ }
  }
  return stopped;
}

// At most this many shelf demos run at once (SHELF_MAX_RUNNING overrides). Starting one more stops the oldest, and says so.
export const MAX_RUNNING_DEFAULT = 10;
// Shared services other demos lean on: they still count toward the limit, but the limit never picks one to stop (Stop all and Stop do).
export const NEVER_AUTO_STOPPED = new Set(['ai-guard-sidecar']);
export function maxRunning() {
  const n = Number(process.env.SHELF_MAX_RUNNING);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : MAX_RUNNING_DEFAULT;
}
// Which registered demos are up right now: `docker compose ls` lists the running projects with their compose files. null = could not tell.
export async function runningDemos(demos, exec, shelfDir = null) {
  let projects;
  try { projects = JSON.parse((await exec('docker', ['compose', 'ls', '--format', 'json'])).stdout.trim() || '[]'); } catch { return null; }
  if (!Array.isArray(projects)) return null;
  const files = new Set(projects.filter((p) => /^running/.test(String(p.Status))).flatMap((p) => String(p.ConfigFiles).split(',')));
  return demos.filter((d) => d.composeFile && files.has(d.composeFile) && !isShelfItself(d, shelfDir));
}

// Docker's default address pool holds ~31 user networks; every compose project takes one for
// its lifetime. A machine with many labs hits "all predefined address pools have been fully
// subnetted" — a cryptic daemon error mid-deploy. The guard counts networks first and refuses
// with the fix, so the caller (the shelf UI) can show it where the button is.
const NETWORK_LIMIT_DEFAULT = 28;
// 28 fits stock Docker. A machine with its own address pools (OrbStack here: 10.200.0.0/16 cut into /24s, 256 networks) can hold
// far more, so read the pools from the daemon: capacity minus the same 3 of headroom. No pools reported or unreadable: 28.
export async function networkLimitFor(exec, limit) {
  if (limit !== undefined) return limit;
  try {
    const pools = JSON.parse((await exec('docker', ['info', '--format', '{{json .DefaultAddressPools}}'])).stdout.trim());
    const capacity = (Array.isArray(pools) ? pools : []).reduce((n, p) => {
      const prefix = Number(String(p?.Base).split('/')[1]);
      return Number.isInteger(prefix) && Number.isInteger(p?.Size) && p.Size >= prefix && p.Size - prefix <= 24 ? n + 2 ** (p.Size - prefix) : n;
    }, 0);
    if (capacity > 0) return Math.max(1, capacity - 3);
  } catch { /* fall through to the stock limit */ }
  return NETWORK_LIMIT_DEFAULT;
}
export async function networkPoolGuard(exec, limit = NETWORK_LIMIT_DEFAULT) {
  let out;
  try { out = (await exec('docker', ['network', 'ls', '--format', '{{.Name}}'])).stdout.trim().split('\n').filter(Boolean); } catch { return 'docker-unavailable'; }
  return out.length >= limit ? `network-pool-nearly-full:${out.length}` : 'ok';
}

// The one place that touches Docker. Used by the shelf (host-run) and by the start agent. Returns { status, body }.
// `exec` and `fileExists` are injectable for tests.
export async function runCompose(demo, action, { exec = defaultExec, fileExists = fs.existsSync, shelfDir = null, networkLimit, cap = null } = {}) {
  const fail = (status, error, extra = {}) => ({ status, body: { ok: false, error, ...extra } });
  if (isShelfItself(demo, shelfDir)) return fail(409, 'is-the-shelf');
  const guard = await orbstackGuard(exec);
  if (guard === 'docker-unavailable') return fail(503, guard);
  if (guard !== 'ok') return fail(409, guard);
  const missing = [demo.composeFile, ...(demo.composeOverlays || [])].filter((f) => !fileExists(f));
  if (missing.length) return fail(409, 'compose-file-missing', { missing });
  let stopped;
  let sharedStarted = [];
  if ((action === 'start' || action === 'deploy') && cap) {
    // Keep the shelf to cap.max running demos. At the limit: stop the oldest one, then start this one. Already over it (the user started
    // more by hand): refuse rather than stop several at once, and say how many are running.
    const others = (await runningDemos(cap.getDemos(), exec, shelfDir) || []).filter((d) => d.id !== demo.id);
    if (others.length > cap.max) {
      return fail(409, `too-many-running:${others.length}:${cap.max}`, { output: `${others.length} demos are running and the limit is ${cap.max}. Stop some first (Stop all stops every one).` });
    }
    if (others.length === cap.max) {
      const rank = (d) => { const i = (cap.lastRunning?.list() || []).findIndex((e) => e.id === d.id); return i < 0 ? Infinity : i; };
      const candidates = others.filter((d) => !NEVER_AUTO_STOPPED.has(d.id));
      if (!candidates.length) return fail(409, `no-demo-to-stop:${others.length}:${cap.max}`, { output: `${others.length} demos are running and the limit is ${cap.max}, and none of them may be stopped automatically. Stop one first.` });
      const oldest = candidates.reduce((a, b) => (rank(b) > rank(a) ? b : a));
      const r = await runCompose(oldest, 'stop', { exec, fileExists, shelfDir });
      if (r.status !== 200) return fail(502, 'could-not-stop-oldest', { output: `To stay within ${cap.max} running, ${oldest.name} had to stop, but it would not: ${r.body.error}` });
      cap.lastRunning?.recordStop(oldest.id);
      stopped = [{ id: oldest.id, name: oldest.name }];
    }
  }
  if (action === 'start' || action === 'deploy') {
    // Shared services first, so the demo's own compose has its dependencies when it comes up.
    sharedStarted = await startSharedContainers(demo, exec).catch(() => []);
    const limit = await networkLimitFor(exec, networkLimit);
    const pool = await networkPoolGuard(exec, limit);
    if (pool === 'docker-unavailable') return fail(503, pool);
    if (pool !== 'ok') return fail(409, pool, {
      output: `Docker has too many networks (${pool.split(':')[1]} >= limit ${limit}). Fix: docker network prune -f  (stops nothing running), or stop some labs from the shelf, or raise default-address-pools in the docker daemon settings.`,
    });
  }
  try {
    // Run from the compose file's own folder, as a person would: relative paths, .env and build contexts then resolve the same way.
    const out = await exec('docker', composeArgs(demo, action), { cwd: path.dirname(demo.composeFile), timeoutMs: action === 'start' ? START_TIMEOUT_MS : EXEC_TIMEOUT_MS });
    const body = { ok: true, id: demo.id, action, output: redact(`${out.stdout}\n${out.stderr}`), ...(stopped ? { stopped, limit: cap.max } : {}) };
    if (sharedStarted.length) body.sharedStarted = sharedStarted;
    return { status: 200, body };
  } catch (e) {
    const timedOut = e.killed || e.signal === 'SIGTERM';
    return fail(502, timedOut ? 'timeout' : 'compose-failed', { output: redact(`${e.stdout || ''}\n${e.stderr || ''}`) });
  }
}

// Express middleware factory. With `agent` (the shelf in a container) the compose call is handed to the host-side start agent;
// without it the shelf runs Docker itself. `inDocker` skips the remote-address check, because inside a container every request
// arrives from the Docker network: the compose file publishes the port on 127.0.0.1 only, and the Host and Origin checks still apply.
export function createControlRouter({ express, getDemos, onChange, exec = defaultExec, fileExists = fs.existsSync, agent = null, inDocker = false, shelfDir = null, demoRoot = null, lastRunning = null, networkLimit, maxRunningDemos = null }) {
  const router = express.Router({ caseSensitive: true });
  const cap = maxRunningDemos ? { getDemos, lastRunning, max: maxRunningDemos } : null;
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
          if (r.status === 200) onChange?.(demo.id); // the agent records last-running; this container's .data is read-only
          return res.status(r.status).json(r.body);
        }
        if (!demoRoot) return fail(409, 'no-demo-root');
        const g = await ensureRepo(demo, demoRoot, { exec });
        if (!g.ok) return res.status(409).json({ ok: false, error: g.error, output: redact(g.output || '') });
        const r = await runCompose(demo, 'start', { exec, fileExists, shelfDir, networkLimit, cap });
        if (r.status === 200) { lastRunning?.recordStart(demo.id); onChange?.(demo.id); }
        return res.status(r.status).json({ ...r.body, deploy: g.how, dir: g.dir });
      }
      const r = agent ? await agent.run(demo.id, req.params.action) : await runCompose(demo, req.params.action, { exec, fileExists, shelfDir, networkLimit, cap });
      if (r.status === 200) {
        if (lastRunning && !agent) { // with an agent it records the start/stop itself; this shelf's .data is mounted read-only
          if (req.params.action === 'start' || req.params.action === 'deploy') lastRunning.recordStart(demo.id);
          if (req.params.action === 'stop') lastRunning.recordStop(demo.id);
        }
        onChange?.(demo.id);
      }
      return res.status(r.status).json(r.body);
    } catch {
      return fail(500, 'internal'); // Express 4 does not catch a rejected handler: answer instead of hanging
    } finally {
      busy.delete(demo.id);
    }
  });

  // Stop all's second half: the shared Ping product containers (the demos themselves are stopped one by one by the UI).
  router.post('/shared/stop', async (req, res) => {
    const fail = (code, error) => res.status(code).json({ ok: false, error });
    if (!inDocker && !isLoopbackAddr(req.socket.remoteAddress)) return fail(403, 'loopback-only');
    const xfHost = req.headers['x-forwarded-host'];
    const expectedOrigin = xfHost ? `${req.headers['x-forwarded-proto'] || 'https'}://${xfHost}` : `http://${req.headers.host}`;
    if (!req.headers.origin || req.headers.origin !== expectedOrigin) return fail(403, 'bad-origin');
    try {
      const r = agent ? await agent.runSharedStop() : { status: 200, body: { ok: true, stopped: await stopSharedContainers(getDemos, exec) } };
      if (r.status === 200) onChange?.();
      return res.status(r.status).json(r.body);
    } catch {
      return fail(500, 'internal');
    }
  });

  return router;
}
