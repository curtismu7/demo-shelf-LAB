import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(server, '..');
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const clean = (extra = {}) => ({ PATH: process.env.PATH, HOME: process.env.HOME, ...extra });

describe('entry points', () => {
  it('SHELF_IN_DOCKER=1 outside the container image refuses to start', () => {
    if (fs.existsSync('/.dockerenv')) return; // inside a container the guard is satisfied by design
    const r = spawnSync('node', ['src/index.js'], { cwd: server, env: clean({ SHELF_IN_DOCKER: '1', SHELF_BIND: '0.0.0.0', SHELF_PORT: String(4400 + Math.floor(Math.random() * 40)), SHELF_AGENT_URL: 'http://x:1', SHELF_AGENT_TOKEN: 'a'.repeat(64) }), encoding: 'utf8', timeout: 20000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/only for the container image/);
  });

  it('the agent CLI listens on loopback only, makes a mode-600 token, and never prints it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-cli-'));
    const port = await freePort();
    const child = spawn('node', ['src/agent-cli.js'], { cwd: server, env: clean({ SHELF_AGENT_PORT: String(port), SHELF_DATA_DIR: dir }) });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`agent did not start: ${out}`)), 15000);
        const tick = () => (out.includes('start agent on') ? (clearTimeout(t), resolve()) : setTimeout(tick, 100));
        tick();
      });
      const file = path.join(dir, 'agent-token');
      const token = fs.readFileSync(file, 'utf8').trim();
      expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
      expect(out).not.toContain(token);
      const ok = await fetch(`http://127.0.0.1:${port}/v1/health`, { headers: { authorization: `Bearer ${token}` } });
      expect(ok.status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/v1/health`)).status).toBe(401);
      // Not reachable on any non-loopback address of this machine.
      const external = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
      if (external) {
        const refused = await new Promise((resolve) => { const s = net.connect({ host: external.address, port, timeout: 2000 }, () => { s.destroy(); resolve(false); }); s.on('error', () => resolve(true)); s.on('timeout', () => { s.destroy(); resolve(true); }); });
        expect(refused).toBe(true);
      }
    } finally {
      child.kill();
    }
  });

  it('npm run docker works with any running Docker engine (desktop-linux or orbstack) and hands compose the token only through the environment', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-fakebin-'));
    const log = path.join(bin, 'log.txt');
    // fake docker: `info` must succeed for the engine check; context is informational only
    const fake = (ctx, infoOk = true) => fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\nif [ "$1" = info ]; then [ "\${FAKE_INFO_OK:-1}" = 1 ] && exit 0 || exit 1; fi\nprintf '%s ' "$@" >> "${log}"\nprintf 'TOKEN_SET=%s\\n' "\${SHELF_AGENT_TOKEN:+yes}" >> "${log}"\n`, { mode: 0o755 });
    const run = (infoOk = 1) => spawnSync('node', ['scripts/docker-up.mjs', 'up'], { cwd: repo, env: clean({ PATH: `${bin}:${process.env.PATH}`, SHELF_OPEN: '0', FAKE_INFO_OK: String(infoOk) }), encoding: 'utf8', timeout: 20000 });
    // engine answers (desktop-linux context): proceeds to compose
    fake('desktop-linux');
    const good = run();
    expect(good.status).toBe(0);
    expect(fs.readFileSync(log, 'utf8')).toBe('compose up -d --build TOKEN_SET=yes\n');
    const token = fs.readFileSync(path.join(repo, '.data', 'agent-token'), 'utf8').trim();
    expect(good.stdout + good.stderr).not.toContain(token);
    // engine does not answer: exits 1 with a clear message
    fake('orbstack');
    const bad = run(0);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/Docker is not running/);
  });
  describe('npm run docker opens the browser', { timeout: 60000 }, () => {
    const setup = () => {
      const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-fakebin-'));
      const opened = path.join(bin, 'opened.txt');
      fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nif [ "$1" = context ]; then echo orbstack; fi\nexit 0\n', { mode: 0o755 });
      for (const name of ['open', 'xdg-open']) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "$1" > "${opened}"\n`, { mode: 0o755 });
      return { bin, opened };
    };
    const runDocker = (bin, env) => new Promise((resolve) => {
      const child = spawn('node', ['scripts/docker-up.mjs', 'up'], { cwd: repo, env: clean({ PATH: `${bin}:${process.env.PATH}`, ...env }) });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (status) => resolve({ status, out }));
    });
    const healthServer = async (ok) => {
      const port = await freePort();
      const srv = http.createServer((req, res) => { res.statusCode = ok ? 200 : 503; res.end('{}'); });
      await new Promise((r) => srv.listen(port, '127.0.0.1', r));
      return { port, close: () => srv.close() };
    };

    it('opens the shelf URL once /api/health answers', async () => {
      const { bin, opened } = setup();
      const srv = await healthServer(true);
      try {
        const r = await runDocker(bin, { SHELF_HOST_PORT: String(srv.port) });
        expect(r.status).toBe(0);
        expect(fs.readFileSync(opened, 'utf8').trim()).toBe(`http://127.0.0.1:${srv.port}`);
      } finally { srv.close(); }
    });

    // npm run agent: start agent, then the same docker-up script. Default data dir, so it writes the repo's git-ignored .data/agent-token.
    const agents = [];
    afterEach(() => { for (const c of agents.splice(0)) c.kill(); });
    const runAgent = async (bin, env, until) => {
      const port = await freePort();
      const child = spawn('node', ['src/agent-cli.js'], { cwd: server, env: clean({ PATH: `${bin}:${process.env.PATH}`, SHELF_AGENT_PORT: String(port), ...env }) });
      agents.push(child);
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      const deadline = Date.now() + 45000;
      while (!until(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      return { child, port, out: () => out };
    };

    it('npm run agent also starts the shelf container and opens the browser', async () => {
      const { bin, opened } = setup();
      const srv = await healthServer(true);
      const a = await runAgent(bin, { SHELF_HOST_PORT: String(srv.port) }, () => fs.existsSync(opened));
      try {
        expect(fs.readFileSync(opened, 'utf8').trim()).toBe(`http://127.0.0.1:${srv.port}`);
        expect(a.out()).toMatch(/start agent on/);
        expect(a.out()).toMatch(/Shelf: http:\/\/127\.0\.0\.1:/);
        expect(a.out()).not.toMatch(/did not start/);
        const token = fs.readFileSync(path.join(repo, '.data', 'agent-token'), 'utf8').trim();
        expect(a.out()).not.toContain(token);
      } finally { a.child.kill(); srv.close(); }
    });

    it('npm run agent keeps running and says what to do when the container will not start', async () => {
      const { bin, opened } = setup();
      fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nif [ "$1" = context ]; then echo desktop-linux; fi\nexit 0\n', { mode: 0o755 });
      const a = await runAgent(bin, {}, (o) => /did not start/.test(o));
      try {
        expect(a.out()).toMatch(/did not start .*npm run docker/);
        const token = fs.readFileSync(path.join(repo, '.data', 'agent-token'), 'utf8').trim();
        const r = await fetch(`http://127.0.0.1:${a.port}/v1/health`, { headers: { authorization: `Bearer ${token}` } });
        expect(r.status).toBe(200);
        expect(fs.existsSync(opened)).toBe(false);
      } finally { a.child.kill(); }
    });

    it('npm run agent reports a container script that was killed by a signal', async () => {
      const { bin } = setup();
      fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nif [ "$1" = context ]; then echo orbstack; exit 0; fi\nkill -KILL $PPID\nsleep 1\n', { mode: 0o755 });
      const a = await runAgent(bin, {}, (o) => /did not start/.test(o));
      expect(a.out()).toMatch(/did not start \(killed by SIGKILL\)/);
      expect(a.child.exitCode).toBe(null);
    });

    it('stopping the agent with SIGTERM cancels a build in flight instead of orphaning it', async () => {
      const { bin } = setup();
      const pidFile = path.join(bin, 'compose.pid');
      fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\nif [ "$1" = context ]; then echo orbstack; exit 0; fi\necho $$ > "${pidFile}"\nexec sleep 60\n`, { mode: 0o755 });
      const a = await runAgent(bin, {}, () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '');
      const composePid = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(() => process.kill(composePid, 0)).not.toThrow();
      const exited = new Promise((resolve) => a.child.on('exit', resolve));
      a.child.kill('SIGTERM');
      await exited;
      const deadline = Date.now() + 5000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        try { process.kill(composePid, 0); await new Promise((r) => setTimeout(r, 100)); } catch { alive = false; }
      }
      expect(alive).toBe(false);
    });

    it.each([{ SHELF_AUTOSTART: '0' }, { CI: 'true' }, { SHELF_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-cli-')) }])('npm run agent starts no container with %o', async (env) => {
      const { bin, opened } = setup();
      const srv = await healthServer(true);
      const a = await runAgent(bin, { SHELF_HOST_PORT: String(srv.port), ...env }, (o) => /start agent on/.test(o));
      try {
        await new Promise((r) => setTimeout(r, 1500));
        expect(a.out()).not.toMatch(/Starting the shelf container/);
        expect(fs.existsSync(opened)).toBe(false);
      } finally { a.child.kill(); srv.close(); }
    });

    it('opens nothing when SHELF_OPEN=0 or CI is set', async () => {
      const { bin, opened } = setup();
      const srv = await healthServer(true);
      try {
        for (const env of [{ SHELF_OPEN: '0' }, { CI: 'true' }]) {
          const r = await runDocker(bin, { SHELF_HOST_PORT: String(srv.port), ...env });
          expect(r.status).toBe(0);
          expect(fs.existsSync(opened)).toBe(false);
        }
      } finally { srv.close(); }
    });
  });
});
