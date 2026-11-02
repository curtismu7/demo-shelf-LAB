import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadAll } from '../src/index.js';
import { allowedHostsFromEnv, alsoCatalogProblems, loadRegistry, RegistryError, validateDemos } from '../src/registry.js';

const ok = { id: 'demo-a', name: 'A', description: 'd', url: 'http://localhost:4500', composeFile: '/tmp/a/docker-compose.yml' };
const errs = (d, opts) => { try { validateDemos([d], opts); } catch (e) { return e.errors.join('\n'); } return ''; };

describe('validateDemos', () => {
  it('accepts a good entry and fills defaults', () => {
    const [d] = validateDemos([ok]);
    expect(d.healthPath).toBe('/api/health');
    expect(d.composeOverlays).toEqual([]);
  });
  it('accepts alsoCatalogIds as a short array of strings and refuses anything else', () => {
    expect(validateDemos([{ ...ok, alsoCatalogIds: ['A4', 'A5'] }])[0].alsoCatalogIds).toEqual(['A4', 'A5']);
    for (const bad of ['A4', [4], Array(11).fill('A4'), ['x'.repeat(41)]]) expect(errs({ ...ok, alsoCatalogIds: bad })).toMatch(/alsoCatalogIds must be an array/);
  });
  it('defaults where to installed and accepts mock and both with a mockUrl', () => {
    expect(validateDemos([ok])[0].where).toBe('installed');
    const mock = { ...ok, where: 'mock', mockUrl: 'http://localhost:4600' };
    expect(validateDemos([mock])[0]).toMatchObject({ where: 'mock', mockUrl: 'http://localhost:4600' });
    expect(validateDemos([{ ...mock, where: 'both' }])[0].where).toBe('both');
  });
  it('reserves <id>-mock when a both demo exists, in either order', () => {
    const both = { ...ok, id: 'aa', where: 'both', mockUrl: 'http://localhost:4600' };
    const clash = { ...ok, id: 'aa-mock' };
    expect(() => validateDemos([both, clash])).toThrow(/"aa-mock" is reserved/);
    expect(() => validateDemos([clash, both])).toThrow(/"aa-mock" is reserved/);
    expect(validateDemos([{ ...both, where: 'mock' }, clash])).toHaveLength(2);
  });
  it('lets a mock-only demo omit url', () => {
    const { url, ...noUrl } = ok; // eslint-disable-line no-unused-vars
    expect(errs({ ...noUrl, where: 'mock', mockUrl: 'http://localhost:4600' })).toBe('');
    expect(errs(noUrl)).toMatch(/url is not a valid URL/);
  });
  it('rejects mock or both without a mockUrl, and an unknown where', () => {
    expect(errs({ ...ok, where: 'mock' })).toMatch(/mockUrl is required when where is "mock"/);
    expect(errs({ ...ok, where: 'both' })).toMatch(/mockUrl is required when where is "both"/);
    expect(errs({ ...ok, where: 'cloud' })).toMatch(/where must be one of/);
  });
  it('applies the url rules to mockUrl', () => {
    const h = { ...ok, where: 'mock' };
    expect(errs({ ...h, mockUrl: 'ftp://localhost' })).toMatch(/mockUrl must be http or https/);
    expect(errs({ ...h, mockUrl: 'nope' })).toMatch(/mockUrl is not a valid URL/);
    expect(errs({ ...h, mockUrl: 'http://localhost/x' })).toBe('');
    expect(errs({ ...h, mockUrl: 'http://localhost/x?a=1' })).toMatch(/mockUrl must have no query or fragment/);
    expect(errs({ ...h, mockUrl: 'http://localhost/a%20b' })).toMatch(/mockUrl path must be a plain prefix/);
    expect(errs({ ...h, mockUrl: 'https://mocks.example/mock-authorize' }, { allowedHosts: ['mocks.example'] })).toBe('');
    expect(errs({ ...h, mockUrl: 'https://demos.example.com' })).toMatch(/SHELF_ALLOWED_HOSTS/);
    expect(errs({ ...h, mockUrl: 'https://demos.example.com' }, { allowedHosts: ['demos.example.com'] })).toBe('');
  });
  it('drops unknown keys', () => {
    expect(validateDemos([{ ...ok, evil: 1 }])[0].evil).toBeUndefined();
  });
  it('rejects duplicate ids', () => {
    expect(() => validateDemos([ok, ok])).toThrow(/duplicate id/);
  });
  it('rejects bad ids', () => {
    expect(errs({ ...ok, id: 'Bad Id' })).toMatch(/id must match/);
  });
  it('allows http(s) only', () => {
    expect(errs({ ...ok, url: 'ftp://localhost' })).toMatch(/http or https/);
    expect(errs({ ...ok, url: 'file:///etc/passwd' })).toMatch(/http or https/);
    expect(errs({ ...ok, url: 'nope' })).toMatch(/not a valid URL/);
  });
  it('allows loopback only, unless the host is explicitly allowed', () => {
    for (const u of ['http://127.0.0.1:1', 'http://localhost:1', 'http://[::1]:1', 'https://localhost']) expect(errs({ ...ok, url: u })).toBe('');
    expect(errs({ ...ok, url: 'http://169.254.169.254' })).toMatch(/not loopback/);
    expect(errs({ ...ok, url: 'http://example.com' })).toMatch(/SHELF_ALLOWED_HOSTS/);
    expect(errs({ ...ok, url: 'http://mac.local:4500' }, { allowedHosts: ['mac.local'] })).toBe('');
  });
  it('rejects credentials, paths and queries in the url', () => {
    expect(errs({ ...ok, url: 'http://u:p@localhost' })).toMatch(/credentials/);
    expect(errs({ ...ok, url: 'http://localhost/x?a=1' })).toMatch(/origin only/);
  });
  it('rejects a healthPath that is not a plain path', () => {
    for (const p of ['//evil.com/x', 'http://evil.com', '/a/../b', 'api/health', '/a?b=1']) expect(errs({ ...ok, healthPath: p })).toMatch(/healthPath/);
  });
  it('requires absolute compose paths with no shell characters', () => {
    expect(errs({ ...ok, composeFile: 'relative/x.yml' })).toMatch(/no demo root is set/);
    expect(errs({ ...ok, composeFile: '/tmp/a.yml; rm -rf /' })).toMatch(/shell characters/);
    expect(errs({ ...ok, composeFile: '/tmp/$(id)/a.yml' })).toMatch(/shell characters/);
    expect(errs({ ...ok, composeFile: '/tmp/../etc/a.yml' })).toMatch(/\.\./);
    expect(errs({ ...ok, composeFile: '/tmp/a.sh' })).toMatch(/\.yml/);
    expect(errs({ ...ok, composeOverlays: ['x.yml'] }, { demoRoot: undefined })).toMatch(/no demo root is set/);
    expect(errs({ ...ok, composeOverlays: 'a' })).toMatch(/array/);
    expect(errs({ ...ok, composeFile: undefined, composeOverlays: ['/tmp/o.yml'] })).toMatch(/needs composeFile/);
  });
  it('resolves a relative compose path against the demo root, so an entry works on any machine', () => {
    const a = validateDemos([{ ...ok, composeFile: 'p1az-inspector/docker-compose.yml', composeOverlays: ['x/o.yml'] }], { demoRoot: '/home/a/dev' })[0];
    const b = validateDemos([{ ...ok, composeFile: 'p1az-inspector/docker-compose.yml', composeOverlays: ['x/o.yml'] }], { demoRoot: '/home/b/src' })[0];
    expect(a.composeFile).toBe('/home/a/dev/p1az-inspector/docker-compose.yml');
    expect(b.composeFile).toBe('/home/b/src/p1az-inspector/docker-compose.yml');
    expect(a.composeOverlays).toEqual(['/home/a/dev/x/o.yml']);
    expect(errs({ ...ok, composeFile: '../outside/x.yml' }, { demoRoot: '/home/a/dev' })).toMatch(/\.\./);
  });
  it('an absolute compose path is kept exactly as written', () => {
    const out = validateDemos([{ ...ok, composeFile: '/opt/x/docker-compose.yml' }], { demoRoot: '/home/a/dev' })[0];
    expect(out.composeFile).toBe('/opt/x/docker-compose.yml');
  });
  it('reports every problem at once', () => {
    expect(errs({ id: 'x', url: 'ftp://x' })).toMatch(/id must[\s\S]*name[\s\S]*http or https/);
  });
});

describe('alsoCatalogProblems', () => {
  const cat = { items: [{ id: 'A4' }, { id: 'A5' }, { id: 'A11' }] };
  it('is quiet when every extra id is a catalog row nobody else claims', () => {
    expect(alsoCatalogProblems([{ id: 'x', catalogId: 'A11', alsoCatalogIds: ['A4', 'A5'] }], cat)).toEqual([]);
  });
  it('names a typo, the entry\'s own catalogId, and a row another demo claims', () => {
    const out = alsoCatalogProblems([{ id: 'x', catalogId: 'A11', alsoCatalogIds: ['A44', 'A11', 'A5'] }, { id: 'y', catalogId: 'A5' }], cat).join('\n');
    expect(out).toMatch(/x.*A44.*not a catalog row/);
    expect(out).toMatch(/x.*A11.*its own catalogId/);
    expect(out).toMatch(/x.*A5.*also claimed by y/);
  });
});

describe('loadRegistry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-reg-'));
  const seedFile = path.join(dir, 'demos.json');
  const localFile = path.join(dir, 'local.json');
  fs.writeFileSync(seedFile, JSON.stringify({ demos: [ok] }));
  it('works without a local file', () => {
    expect(loadRegistry({ seedFile, localFile }).map((d) => d.id)).toEqual(['demo-a']);
  });
  it('merges local overrides over the seed by id and appends new ids', () => {
    fs.writeFileSync(localFile, JSON.stringify({ demos: [{ id: 'demo-a', url: 'http://localhost:4501' }, { ...ok, id: 'demo-b' }] }));
    const r = loadRegistry({ seedFile, localFile });
    expect(r.map((d) => [d.id, d.url])).toEqual([['demo-a', 'http://localhost:4501'], ['demo-b', 'http://localhost:4500']]);
  });
  it('names the file when JSON is broken', () => {
    fs.writeFileSync(localFile, '{nope');
    expect(() => loadRegistry({ seedFile, localFile })).toThrow(/demos.local.json: not valid JSON/);
  });
  it('fails clearly when the seed is missing', () => {
    expect(() => loadRegistry({ seedFile: path.join(dir, 'none.json'), localFile })).toThrow(RegistryError);
  });
  it('no host is allowed unless SHELF_ALLOWED_HOSTS names it', () => {
    expect(allowedHostsFromEnv({})).toEqual([]);
    expect(allowedHostsFromEnv({ SHELF_ALLOWED_HOSTS: 'Mocks.Example, a.example' })).toEqual(['mocks.example', 'a.example']);
  });
  it('the committed seed is valid', () => {
    const seed = new URL('../../data/demos.json', import.meta.url).pathname;
    // The demo root is the folder above the shelf repo, the same default the server uses.
    const demoRoot = path.resolve(path.dirname(seed), '..', '..');
    const demos = loadRegistry({ seedFile: seed, localFile: path.join(dir, 'absent.json'), allowedHosts: allowedHostsFromEnv({}), demoRoot });
    expect(demos.map((d) => [d.id, d.catalogId, d.url])).toEqual([
      ['ai-gateway-client', 'D20', 'http://127.0.0.1:6880'],
      ['mcp-demo-client-privilege', 'D2', 'http://127.0.0.1:6884'],
      ['privilege-a2a-anthropic-demo', undefined, 'http://127.0.0.1:6881'],
      ['id-jag-standalone', 'C1', 'http://localhost:4720'],
      ['privilege-demo', 'D1', 'http://127.0.0.1:4510'],
      ['privilege-map', undefined, 'http://127.0.0.1:5301'],
      ['agent-mcp-door-demo', undefined, 'http://localhost:6850'],
      ['pingone-signin-lab', 'A11', 'http://127.0.0.1:6171'],
      ['pingone-lab', 'A29', 'http://127.0.0.1:5500'],
      ['pingfederate-lab', 'A28', 'http://127.0.0.1:5400'],
      ['customer-agent-lab', 'D24', 'http://127.0.0.1:5600'],
    ]);
  });
  it('the committed pingone-signin-lab entry covers A4 and A5 too, with real catalog rows and a portable compose path', () => {
    const seed = new URL('../../data/demos.json', import.meta.url).pathname;
    const entry = JSON.parse(fs.readFileSync(seed, 'utf8')).demos.find((d) => d.id === 'pingone-signin-lab');
    const catalog = JSON.parse(fs.readFileSync(new URL('../../data/catalog.json', import.meta.url), 'utf8'));
    expect(entry).toMatchObject({ name: 'PingOne Sign-in LAB', kind: 'Demo', catalogId: 'A11', alsoCatalogIds: ['A4', 'A5'], composeFile: 'pingone-signin-LAB/docker-compose.yml', where: 'installed' });
    expect(entry.tags).toEqual(['pingone', 'sign-in-and-mfa', 'ciba', 'step-up', 'simulated']);
    for (const id of [entry.catalogId, ...entry.alsoCatalogIds]) expect(catalog.items.find((i) => i.id === id)?.status, id).toBe('active');
  });
  it('the committed seed gives no demo a bad alsoCatalogId, and the real shelf lists A4, A5 and A11 as covered, not planned', async () => {
    const { demos, catalog } = loadAll({ SHELF_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-seed-')) });
    expect(alsoCatalogProblems(demos, catalog)).toEqual([]);
    const { createApp } = await import('../src/app.js');
    const r = await request(createApp({ demos, catalog, fetchFn: async () => { throw new Error('refused'); }, wait: async () => {} })).get('/api/shelf').set('Host', 'localhost:4400');
    const planned = r.body.planned.map((p) => p.id);
    for (const id of ['A4', 'A5', 'A11']) expect(planned).not.toContain(id);
    expect(r.body.demos.find((d) => d.id === 'pingone-signin-lab').alsoCatalogIds).toEqual(['A4', 'A5']);
  });
});

describe('repo field', () => {
  const repoOf = (repo) => validateDemos([{ ...ok, repo }])[0].repo;
  it.each([
    ['https://github.com/ping-sandbox/demo-shelf-LAB', 'https://github.com/ping-sandbox/demo-shelf-LAB'],
    ['https://github.com/ping-sandbox/demo-shelf-LAB.git', 'https://github.com/ping-sandbox/demo-shelf-LAB'],
    ['https://github.com/a/b.c_d-e', 'https://github.com/a/b.c_d-e'],
  ])('accepts %s', (input, want) => expect(repoOf(input)).toBe(want));
  it('is optional', () => expect(validateDemos([ok])[0]).not.toHaveProperty('repo'));
  it.each([
    ['javascript:alert(1)'],
    ['http://github.com/o/n'],
    ['HTTPS://github.com/o/n'],
    ['https://github.com/o/n?x=1'],
    ['https://github.com/o/n#frag'],
    ['https://user@github.com/o/n'],
    ['https://user:pw@github.com/o/n'],
    ['https://github.com:443/o/n'],
    ['https://github.com.evil.example/o/n'],
    ['https://evil.example/github.com/o/n'],
    ['https://gitlab.com/o/n'],
    ['https://github.com/o/n/'],
    ['https://github.com/o/n/extra'],
    ['https://github.com/o'],
    ['https://github.com//n'],
    ['https://github.com/o/'],
    ['https://github.com/../n'],
    ['https://github.com/o/..'],
    ['https://github.com/o/.'],
    ['https://github.com/o/n .git'],
    ['https://github.com/o/n.git.git'],
    ['https://github.com/o/ n'],
    ['https://github.com/o/n\n'],
    ['https://github.com/o/n\nrm -rf /'],
    ['https://github.com/o/n;rm'],
    ['https://github.com/o/n$(id)'],
    ['https://github.com/o/`id`'],
    ['https://github.com/o/n&x'],
    ['https://github.com/o/n|x'],
    ["https://github.com/o/n'"],
    ['https://github.com/o/n\\x'],
    ['https://github.com/o/n%20x'],
    [`https://github.com/o/${'n'.repeat(101)}`],
    [`https://github.com/${'o'.repeat(40)}/n`],
    [`https://github.com/o/${'n'.repeat(300)}`],
    ['git@github.com:o/n.git'],
    [''],
    [42],
    [null],
    [['https://github.com/o/n']],
  ])('rejects %j', (bad) => expect(errs({ ...ok, repo: bad })).toMatch(/repo must be https:\/\/github\.com/));
  it('a local override replaces the seed repo, and a bad override stops the server', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-repo-'));
    const seedFile = path.join(dir, 'seed.json');
    const localFile = path.join(dir, 'local.json');
    fs.writeFileSync(seedFile, JSON.stringify({ demos: [{ ...ok, repo: 'https://github.com/o/seed' }] }));
    fs.writeFileSync(localFile, JSON.stringify({ demos: [{ id: 'demo-a', repo: 'https://github.com/o/mine.git' }] }));
    expect(loadRegistry({ seedFile, localFile, demoRoot: dir })[0].repo).toBe('https://github.com/o/mine');
    fs.writeFileSync(localFile, JSON.stringify({ demos: [{ id: 'demo-a', repo: 'javascript:1' }] }));
    expect(() => loadRegistry({ seedFile, localFile, demoRoot: dir })).toThrow(/repo must be/);
  });
});
