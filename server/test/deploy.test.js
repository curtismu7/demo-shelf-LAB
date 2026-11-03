import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { deployFolderOf, ensureRepo } from '../src/deploy.js';

const good = { schema: 'demo-health/1', at: '2026-10-21T10:00:00Z', state: 'ready', runtime: 'live', demo: { id: 'a', name: 'A', version: '1' } };
const fetchFn = vi.fn(async () => new Response(JSON.stringify(good)));
const demo = (over = {}) => ({ id: 'a', name: 'A', description: 'x', url: 'http://localhost:4500', healthPath: '/api/health', composeFile: '/tmp/a/c.yml', composeOverlays: [], repo: 'https://github.com/ping-sandbox/id-jag-standalone-LAB', ...over });
const mk = (over = {}) => createApp({ demos: [demo()], fetchFn, allowStart: true, ...over });
const post = (app, p) => request(app).post(p).set('Host', 'localhost:4400').set('Origin', 'http://localhost:4400');

describe('deployFolderOf', () => {
  it('takes the name from a registry-shaped URL only', () => {
    expect(deployFolderOf('https://github.com/ping-sandbox/id-jag-standalone-LAB')).toBe('id-jag-standalone-LAB');
    expect(deployFolderOf('https://github.com/ping-sandbox/x.git')).toBeNull(); // .git still on the name
    expect(deployFolderOf('https://github.com/../etc')).toBeNull();
    expect(deployFolderOf('https://evil.example/ping-sandbox/x')).toBeNull();
    expect(deployFolderOf('')).toBeNull();
    expect(deployFolderOf(undefined)).toBeNull();
  });
});

describe('ensureRepo', () => {
  const fakeExec = (scripted = [], { failUnscripted = false } = {}) => {
    const calls = [];
    const exec = vi.fn(async (file, args) => {
      calls.push([file, ...args]);
      const key = args.join(' ');
      for (const [match, result] of scripted) if (key.includes(match)) return typeof result === 'function' ? result() : typeof result === 'string' ? { stdout: result } : result;
      if (failUnscripted) throw Object.assign(new Error('scripted'), { stdout: '', stderr: 'boom' });
      return { stdout: 'ok' };
    });
    return { exec, calls };
  };

  it('clones when the folder is absent', async () => {
    const { exec, calls } = fakeExec([['rev-parse', () => { throw Object.assign(new Error('absent'), { stdout: '', stderr: 'No such directory' }); }]]);
    const r = await ensureRepo(demo(), '/demo-root', { exec });
    expect(r).toMatchObject({ ok: true, how: 'cloned', dir: '/demo-root/id-jag-standalone-LAB' });
    expect(calls.some((c) => c[1] === 'clone' && c[2] === 'https://github.com/ping-sandbox/id-jag-standalone-LAB.git' && c[3] === '/demo-root/id-jag-standalone-LAB')).toBe(true);
  });
  it('fast-forwards an existing clone and reports up-to-date when git says so', async () => {
    const { exec } = fakeExec([['rev-parse', { stdout: 'true\n' }], ['pull --ff-only', { stdout: 'Already up to date.\n' }]]);
    const r = await ensureRepo(demo(), '/demo-root', { exec });
    expect(r.how).toBe('up-to-date');
    const { exec: e2 } = fakeExec([['rev-parse', { stdout: 'true\n' }], ['pull --ff-only', { stdout: 'Fast-forward\n' }]]);
    expect((await ensureRepo(demo(), '/demo-root', { exec: e2 })).how).toBe('fast-forwarded');
  });
  it('refuses a folder that exists but is not a clone', async () => {
    const { exec } = fakeExec([['rev-parse', { stdout: 'fatal: not a git repository\n' }]]);
    await expect(ensureRepo(demo(), '/demo-root', { exec })).resolves.toMatchObject({ ok: false, error: 'deploy-dir-not-a-repo' });
  });
  it('reports pull failure instead of starting', async () => {
    const { exec } = fakeExec([['rev-parse', { stdout: 'true\n' }], ['pull --ff-only', () => { throw Object.assign(new Error('conflict'), { stdout: '', stderr: 'conflict' }); }]]);
    const r = await ensureRepo(demo(), '/demo-root', { exec });
    expect(r).toMatchObject({ ok: false, error: 'git-pull-failed' });
  });
  it('a detached checkout already at origin/main is up to date, no pull', async () => {
    const { exec, calls } = fakeExec([
      ['rev-parse --is-inside-work-tree', { stdout: 'true\n' }],
      ['branch --show-current', { stdout: '' }],
      ['fetch origin main', { stdout: '' }],
      ['rev-parse HEAD', { stdout: 'bf9fc42' }],
      ['rev-parse origin/main', { stdout: 'bf9fc42' }],
    ]);
    const r = await ensureRepo(demo(), '/demo-root', { exec });
    expect(r).toMatchObject({ ok: true, how: 'up-to-date' });
    expect(calls.some((c) => c.includes('pull'))).toBe(false);
  });
  it('a detached checkout behind origin/main is refused with detached-head', async () => {
    const { exec } = fakeExec([
      ['rev-parse --is-inside-work-tree', { stdout: 'true\n' }],
      ['branch --show-current', { stdout: '' }],
      ['fetch origin main', { stdout: '' }],
      ['rev-parse HEAD', { stdout: 'aaa' }],
      ['rev-parse origin/main', { stdout: 'bbb' }],
    ]);
    await expect(ensureRepo(demo(), '/demo-root', { exec })).resolves.toMatchObject({ ok: false, error: 'detached-head' });
  });
  it('never clones without a validated repo or a root', async () => {
    const { exec } = fakeExec([]);
    await expect(ensureRepo(demo({ repo: undefined }), '/demo-root', { exec })).resolves.toMatchObject({ ok: false, error: 'no-repo' });
    await expect(ensureRepo(demo(), null, { exec })).resolves.toMatchObject({ ok: false, error: 'no-repo' });
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('POST /api/demos/:id/deploy', () => {
  it('clones then starts, and reports both', async () => {
    const exec = vi.fn(async (file, args) => {
      const key = args.join(' ');
      if (key.includes('rev-parse')) throw Object.assign(new Error('no'), { stdout: '', stderr: '' });
      if (args[0] === 'clone') return { stdout: 'Cloning...' };
      if (args[0] === 'context') return { stdout: 'orbstack' };
      return { stdout: 'started' };
    });
    const r = await post(mk({ exec, demoRoot: '/demo-root', fileExists: () => true }), '/api/demos/a/deploy');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, action: 'start', deploy: 'cloned' });
    expect(r.body.output).not.toMatch(/do-not-leak/);
  });
  it('keeps the Start guards: origin, loopback, unknown demo', async () => {
    const r = await request(mk({ demoRoot: '/x' })).post('/api/demos/a/deploy').set('Host', 'localhost:4400'); // no Origin
    expect(r.status).toBe(403);
    const r2 = await post(mk({ demoRoot: '/x' }), '/api/demos/nope/deploy');
    expect(r2.status).toBe(404);
  });
  it('refuses without a repo, without a demo root, and under the start agent', async () => {
    const noRepo = await post(mk({ demoRoot: '/x', demos: [demo({ repo: undefined })] }), '/api/demos/a/deploy');
    expect(noRepo.status).toBe(400);
    const noRoot = await post(mk({}), '/api/demos/a/deploy');
    expect(noRoot.status).toBe(409);
    const withAgent = await post(mk({ demoRoot: '/x', agent: { ping: async () => 'up', run: async () => ({ status: 200, body: { ok: true } }) } }), '/api/demos/a/deploy');
    expect(withAgent.status).toBe(409);
    expect(withAgent.body.error).toBe('deploy-needs-host-shelf');
  });
  it('does not start when the git step fails', async () => {
    const exec = vi.fn(async (file, args) => {
      const key = args.join(' ');
      if (key.includes('rev-parse')) throw Object.assign(new Error('no'), { stdout: '', stderr: '' });
      if (args[0] === 'clone') throw Object.assign(new Error('x'), { stdout: '', stderr: 'fatal: could not read' });
      return { stdout: 'should-not-happen' };
    });
    const r = await post(mk({ exec, demoRoot: '/demo-root' }), '/api/demos/a/deploy');
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(exec.mock.calls.filter((c) => c[1][0] === 'docker')).toHaveLength(0);
  });
});
