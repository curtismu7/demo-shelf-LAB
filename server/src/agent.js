// The host-side start agent. The shelf in a container has no Docker access, so it asks this small process on the host to run
// `docker compose up -d` / `down` for a registered demo. It listens on loopback only, takes a bearer token, checks the Host header,
// and only ever acts on a demo id found in the host's own registry: the caller names an id and an action, never a path or a command.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { isLoopbackAddr, runCompose } from './control.js';

export const AGENT_PORT_DEFAULT = 4405;
const TOKEN_FILE = 'agent-token';

// A random token kept beside the registry (.data is git-ignored). Created once, mode 600. Never logged.
export function ensureToken(dataDir) {
  const file = path.join(dataDir, TOKEN_FILE);
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    fs.writeFileSync(file, `${crypto.randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const token = fs.readFileSync(file, 'utf8').trim();
  if (token.length < 32) throw new Error(`${file} does not hold a usable token; delete it and start the agent again`);
  return token;
}

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
export const sameToken = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

// `getDemos()` returns the host's registered installed demos; it may throw if the registry is invalid.
export function createAgent({ getDemos, token, port, exec, fileExists }) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `host.docker.internal:${port}`]);
  const busy = new Set();
  const app = express();
  app.disable('x-powered-by');
  app.set('case sensitive routing', true); // /START must not match start

  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!isLoopbackAddr(req.socket.remoteAddress)) return res.status(403).json({ ok: false, error: 'loopback-only' });
    if (!hosts.has((req.headers.host || '').toLowerCase())) return res.status(403).json({ ok: false, error: 'bad-host' });
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m || !sameToken(m[1], token)) return res.status(401).json({ ok: false, error: 'bad-token' });
    next();
  });

  app.get('/v1/health', (req, res) => res.json({ ok: true, schema: 'shelf-agent/1' }));

  app.post('/v1/demos/:id/:action(start|stop)', async (req, res) => {
    let demo;
    try { demo = getDemos().find((d) => d.id === req.params.id); } catch { return res.status(500).json({ ok: false, error: 'registry-invalid' }); }
    if (!demo) return res.status(404).json({ ok: false, error: 'unknown-demo' });
    if (!demo.composeFile) return res.status(400).json({ ok: false, error: 'no-compose-file' });
    if (busy.has(demo.id)) return res.status(409).json({ ok: false, error: 'busy' });
    busy.add(demo.id);
    try {
      const r = await runCompose(demo, req.params.action, { exec, fileExists });
      res.status(r.status).json(r.body);
    } catch {
      res.status(500).json({ ok: false, error: 'internal' });
    } finally {
      busy.delete(demo.id);
    }
  });

  app.use((req, res) => res.status(404).json({ ok: false, error: 'not-found' }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status >= 400 && err.status < 500 ? err.status : 500; // e.g. a malformed %-escape is the caller's 400
    res.status(status).json({ ok: false, error: status === 500 ? 'internal' : 'bad-request' });
  });
  return app;
}
