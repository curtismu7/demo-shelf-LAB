import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createAgent } from '../src/agent.js';
import { createAgentClient } from '../src/agent-client.js';
import { NOTE_MAX, STATUSES, STATUS_INFO, cleanInput, createVerification, publish, readMarks, VerificationError } from '../src/verification.js';

let dir;
let seedFile;
let localFile;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
  seedFile = path.join(dir, 'verification.json');
  localFile = path.join(dir, 'verification.local.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (file, marks) => fs.writeFileSync(file, JSON.stringify({ schema: 'demo-verification/1', marks }));
const NOW = Date.parse('2026-11-15T12:00:00Z');
const mkStore = (over = {}) => createVerification({ seedFile, localFile, knownIds: () => ['a', 'b'], now: () => NOW, ...over });

describe('reading marks', () => {
  it('a missing, corrupt or wrongly shaped file is no marks, never an error', () => {
    expect(readMarks(seedFile).size).toBe(0);
    fs.writeFileSync(seedFile, '{nope');
    expect(readMarks(seedFile).size).toBe(0);
    fs.writeFileSync(seedFile, JSON.stringify({ marks: ['x'] }));
    expect(readMarks(seedFile).size).toBe(0);
  });

  it('skips a bad entry and keeps the good ones', () => {
    write(seedFile, {
      a: { status: 'verified', note: 'ok', updatedAt: '2026-11-01' },
      b: { status: 'great' },
      c: { status: 'verified', note: 'x'.repeat(NOTE_MAX + 1) },
      d: { status: 'in-progress', note: 'line\nbreak' },
      e: 'verified',
    });
    expect([...readMarks(seedFile).keys()]).toEqual(['a']);
  });
});

describe('cleanInput', () => {
  it('accepts each status, trims the note, and keeps no note for none', () => {
    for (const status of STATUSES) expect(cleanInput({ status, note: '  hi  ' }).status).toBe(status);
    expect(cleanInput({ status: 'verified', note: '  hi  ' })).toEqual({ status: 'verified', note: 'hi' });
    expect(cleanInput({ status: 'none', note: 'left over' })).toEqual({ status: 'none', note: '' });
    expect(cleanInput({ status: 'in-progress' })).toEqual({ status: 'in-progress', note: '' });
  });

  it('refuses an unknown status, a long note, a control character, a non-string note and a non-object body', () => {
    const code = (b) => { try { cleanInput(b); } catch (e) { return e.code; } return null; };
    expect(code({ status: 'done' })).toBe('bad-status');
    expect(code(undefined)).toBe('bad-status');
    expect(code([])).toBe('bad-status');
    expect(code({ status: 'verified', note: 'x'.repeat(NOTE_MAX + 1) })).toBe('bad-note');
    expect(code({ status: 'verified', note: 'a\nb' })).toBe('bad-note');
    expect(code({ status: 'verified', note: 5 })).toBe('bad-note');
    expect(cleanInput({ status: 'verified', note: 'x'.repeat(NOTE_MAX) }).note).toHaveLength(NOTE_MAX);
  });
});

describe('createVerification', () => {
  it('shows the committed marks as shipped and this machine\'s as local, local winning by id', () => {
    write(seedFile, { a: { status: 'verified', note: 'shipped note', updatedAt: '2026-11-01' }, b: { status: 'in-progress', note: '', updatedAt: '2026-11-02' } });
    write(localFile, { b: { status: 'verified', note: 'mine', updatedAt: '2026-11-15' } });
    const m = mkStore().marks();
    expect(m.get('a')).toEqual({ status: 'verified', label: 'Verified', note: 'shipped note', updatedAt: '2026-11-01', source: 'shipped' });
    expect(m.get('b')).toEqual({ status: 'verified', label: 'Verified', note: 'mine', updatedAt: '2026-11-15', source: 'local' });
  });

  it('a local "none" hides a committed mark', () => {
    write(seedFile, { a: { status: 'verified', note: 'n', updatedAt: '2026-11-01' } });
    write(localFile, { a: { status: 'none' } });
    expect(mkStore().marks().has('a')).toBe(false);
  });

  it('set writes the local file only (never the committed one), stamps today, and returns the mark in force', () => {
    write(seedFile, {});
    const before = fs.readFileSync(seedFile, 'utf8');
    const mark = mkStore().set('a', { status: 'verified', note: 'Checked against the mock' });
    expect(mark).toEqual({ status: 'verified', label: 'Verified', note: 'Checked against the mock', updatedAt: '2026-11-15', source: 'local' });
    expect(JSON.parse(fs.readFileSync(localFile, 'utf8'))).toEqual({ schema: 'demo-verification/1', marks: { a: { status: 'verified', note: 'Checked against the mock', updatedAt: '2026-11-15' } } });
    expect(fs.readFileSync(seedFile, 'utf8')).toBe(before);
    expect(fs.existsSync(`${localFile}.tmp`)).toBe(false);
  });

  it('set to none returns null, and an id that is not registered is refused', () => {
    const s = mkStore();
    s.set('a', { status: 'verified', note: 'n' });
    expect(s.set('a', { status: 'none' })).toBeNull();
    expect(() => s.set('zzz', { status: 'verified' })).toThrow(VerificationError);
    expect(() => s.set('../etc/passwd', { status: 'verified' })).toThrow('unknown-demo');
  });
});

describe('publish', () => {
  it('folds local marks into the committed file, none deletes, keys are sorted, the local file is left alone', () => {
    write(seedFile, { z: { status: 'verified', note: 'old', updatedAt: '2026-11-01' }, y: { status: 'verified', note: '', updatedAt: '2026-11-01' } });
    write(localFile, { z: { status: 'in-progress', note: 'recheck', updatedAt: '2026-11-15' }, y: { status: 'none' }, a: { status: 'verified', note: 'new', updatedAt: '2026-11-15' } });
    const localBefore = fs.readFileSync(localFile, 'utf8');
    expect(publish({ seedFile, localFile })).toEqual({ set: 2, cleared: 1, total: 2 });
    const out = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
    expect(Object.keys(out.marks)).toEqual(['a', 'z']);
    expect(out.marks.z).toEqual({ status: 'in-progress', note: 'recheck', updatedAt: '2026-11-15' });
    expect(fs.readFileSync(localFile, 'utf8')).toBe(localBefore);
  });

  it('is idempotent: a second run changes nothing', () => {
    write(seedFile, {});
    write(localFile, { a: { status: 'verified', note: 'n', updatedAt: '2026-11-15' } });
    publish({ seedFile, localFile });
    const first = fs.readFileSync(seedFile, 'utf8');
    expect(publish({ seedFile, localFile })).toEqual({ set: 0, cleared: 0, total: 1 });
    expect(fs.readFileSync(seedFile, 'utf8')).toBe(first);
  });
});

describe('the committed data/verification.json', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'data', 'verification.json'), 'utf8'));

  it('has the schema, only valid entries, and only ids that are in the seed registry; none is "none"', () => {
    expect(raw.schema).toBe('demo-verification/1');
    const ids = new Set(JSON.parse(fs.readFileSync(path.join(root, 'data', 'demos.json'), 'utf8')).demos.map((d) => d.id));
    const good = readMarks(path.join(root, 'data', 'verification.json'));
    expect(Object.keys(raw.marks).sort()).toEqual([...good.keys()].sort());
    for (const [id, e] of good) {
      expect(ids.has(id), `${id} is not a registered demo`).toBe(true);
      expect(e.status).not.toBe('none');
      expect(e.updatedAt, `${id} needs updatedAt`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

// ---- the shelf's PUT route -------------------------------------------------------------------------------------------------

const demos = [
  { id: 'a', name: 'A', description: 'x', url: 'http://localhost:4500', healthPath: '/api/health', composeFile: '/tmp/a/c.yml', composeOverlays: [] },
  { id: 'b', name: 'B', description: 'y', url: 'http://localhost:4501', healthPath: '/api/health', composeOverlays: [] },
];
const fetchFn = vi.fn(async () => Promise.reject(new Error('refused')));
const mkApp = (over = {}) => createApp({ demos, catalog: { items: [] }, fetchFn, wait: async () => {}, verification: mkStore(), ...over });
const put = (app, id, body, headers = { Origin: 'http://localhost:4400' }) => request(app).put(`/api/verification/${id}`).set('Host', 'localhost:4400').set(headers).send(body);

describe('GET /api/shelf verification', () => {
  it('carries each tile\'s mark (null when it has none) and says whether saving is on', async () => {
    write(seedFile, { a: { status: 'verified', note: 'Works', updatedAt: '2026-11-01' } });
    const r = await request(mkApp({ allowStart: true })).get('/api/shelf').set('Host', 'localhost:4400');
    expect(r.body.demos.map((d) => [d.id, d.verification?.status ?? null])).toEqual([['a', 'verified'], ['b', null]]);
    expect(r.body.demos[0].verification).toEqual({ status: 'verified', label: 'Verified', note: 'Works', updatedAt: '2026-11-01', source: 'shipped' });
    expect(r.body.verificationEditable).toBe(true);
    // One definition: the page's labels, meanings and note limit come from the server, in the order the page lists them.
    expect(r.body.verificationInfo).toEqual({ statuses: STATUS_INFO, noteMax: NOTE_MAX });
    expect(STATUS_INFO.map((s) => s.id)).toEqual(STATUSES);
    const off = await request(mkApp()).get('/api/shelf').set('Host', 'localhost:4400');
    expect(off.body.verificationEditable).toBe(false);
  });

  it('reads the files on every request, so a save shows at once; and works with no verification wired in', async () => {
    const app = mkApp({ allowStart: true });
    const get = () => request(app).get('/api/shelf').set('Host', 'localhost:4400');
    expect((await get()).body.demos[1].verification).toBeNull();
    write(localFile, { b: { status: 'in-progress', note: 'Rechecking', updatedAt: '2026-11-15' } });
    expect((await get()).body.demos[1].verification).toMatchObject({ status: 'in-progress', source: 'local' });
    const bare = await request(mkApp({ verification: null })).get('/api/shelf').set('Host', 'localhost:4400');
    expect(bare.body.demos.every((d) => d.verification === null)).toBe(true);
  });
});

describe('PUT /api/verification/:id', () => {
  it('saves a mark and the next /api/shelf shows it', async () => {
    const app = mkApp({ allowStart: true });
    const r = await put(app, 'a', { status: 'verified', note: 'Checked live' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, mark: { status: 'verified', label: 'Verified', note: 'Checked live', updatedAt: new Date(NOW).toISOString().slice(0, 10), source: 'local' } });
    expect(readMarks(localFile).get('a')).toMatchObject({ status: 'verified', note: 'Checked live' });
  });

  it('is not mounted when Start / Stop is off', async () => {
    const r = await put(mkApp({ allowStart: false }), 'a', { status: 'verified' });
    expect(r.status).toBe(404);
    expect(fs.existsSync(localFile)).toBe(false);
  });

  it('refuses a missing or foreign Origin, an unknown id, a bad status and a bad note, and writes nothing', async () => {
    const app = mkApp({ allowStart: true });
    expect((await put(app, 'a', { status: 'verified' }, {})).body.error).toBe('bad-origin');
    expect((await put(app, 'a', { status: 'verified' }, { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await put(app, 'nope', { status: 'verified' })).status).toBe(404);
    expect((await put(app, 'a', { status: 'done' })).body.error).toBe('bad-status');
    expect((await put(app, 'a', { status: 'verified', note: 'x'.repeat(NOTE_MAX + 1) })).body.error).toBe('bad-note');
    expect(fs.existsSync(localFile)).toBe(false);
  });

  it('honours the lab-proxy\'s forwarded origin, like Start / Stop', async () => {
    const r = await request(mkApp({ allowStart: true })).put('/api/verification/a').set('Host', 'localhost:4400').set('X-Forwarded-Host', 'shelf.example:8443').set('X-Forwarded-Proto', 'https').set('Origin', 'https://shelf.example:8443').send({ status: 'verified' });
    expect(r.status).toBe(200);
  });

  it('in a container it hands the save to the start agent and relays its answer', async () => {
    const agent = { ping: async () => 'up', setVerification: vi.fn(async () => ({ status: 200, body: { ok: true, mark: null } })) };
    const r = await put(mkApp({ allowStart: true, agent, inDocker: true, verification: null }), 'a', { status: 'none' });
    expect(r.status).toBe(200);
    expect(agent.setVerification).toHaveBeenCalledWith('a', { status: 'none' });
    const down = { ping: async () => 'down', setVerification: async () => ({ status: 503, body: { ok: false, error: 'agent-not-running' } }) };
    const d = await put(mkApp({ allowStart: true, agent: down, inDocker: true }), 'a', { status: 'verified' });
    expect([d.status, d.body.error]).toEqual([503, 'agent-not-running']);
  });
});

// ---- the start agent's route and the client --------------------------------------------------------------------------------

const TOKEN = 'a'.repeat(64);
const PORT = 4405;
const mkAgent = (over = {}) => createAgent({ getDemos: () => [], token: TOKEN, port: PORT, verification: mkStore(), ...over });
const agentPut = (app, id, body, token = TOKEN) => request(app).put(`/v1/verification/${id}`).set('Host', `127.0.0.1:${PORT}`).set('Authorization', `Bearer ${token}`).send(body);

describe('start agent PUT /v1/verification/:id', () => {
  it('saves for a registered id, validates, and needs the token', async () => {
    const app = mkAgent();
    const ok = await agentPut(app, 'b', { status: 'in-progress', note: 'Working on it' });
    expect(ok.status).toBe(200);
    expect(readMarks(localFile).get('b')).toMatchObject({ status: 'in-progress', note: 'Working on it' });
    expect((await agentPut(app, 'zzz', { status: 'verified' })).body.error).toBe('unknown-demo');
    expect((await agentPut(app, 'a', { status: 'meh' })).status).toBe(400);
    expect((await agentPut(app, 'a', { status: 'verified' }, 'b'.repeat(64))).status).toBe(401);
  });

  it('409 when the agent has no verification store', async () => {
    expect((await agentPut(mkAgent({ verification: null }), 'a', { status: 'verified' })).body.error).toBe('no-verification');
  });
});

describe('agent client setVerification', () => {
  const client = (fetchFn) => createAgentClient({ url: 'http://agent.example:4405/', token: TOKEN, fetchFn });
  it('PUTs the id and body with the bearer token and returns the agent\'s status and body', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true, mark: null }), { status: 200 }));
    const r = await client(fetchFn).setVerification('a b', { status: 'none' });
    expect(r).toEqual({ status: 200, body: { ok: true, mark: null } });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('http://agent.example:4405/v1/verification/a%20b');
    expect(init.method).toBe('PUT');
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body)).toEqual({ status: 'none' });
  });

  it('maps an unreachable agent, a refused token and a garbage reply to the same codes as Start / Stop', async () => {
    expect((await client(async () => { throw new Error('refused'); }).setVerification('a', {})).body.error).toBe('agent-not-running');
    expect((await client(async () => new Response('{}', { status: 401 })).setVerification('a', {})).body.error).toBe('agent-token-rejected');
    expect((await client(async () => new Response('not json', { status: 200 })).setVerification('a', {})).body.error).toBe('agent-bad-reply');
  });
});
