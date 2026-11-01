import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultExec } from '../src/control.js';

// Exercises the REAL defaultExec with a harmless fake `docker` on PATH.
describe('defaultExec runs without a shell', () => {
  let dir;
  let oldPath;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-fakedocker-'));
    oldPath = process.env.PATH;
    const script = `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${dir}/argv.txt"; done\necho ok\n`;
    fs.writeFileSync(path.join(dir, 'docker'), script, { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
  });
  afterEach(() => {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes docker only a minimal environment: no tokens or cloud credentials', async () => {
    fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/sh\nenv > "${dir}/env.txt"\n`, { mode: 0o755 });
    process.env.SHELF_TEST_SECRET = 'do-not-leak';
    process.env.AWS_SECRET_ACCESS_KEY = 'do-not-leak';
    try { await defaultExec('docker', ['compose']); } finally { delete process.env.SHELF_TEST_SECRET; delete process.env.AWS_SECRET_ACCESS_KEY; }
    const names = fs.readFileSync(path.join(dir, 'env.txt'), 'utf8').split('\n').map((l) => l.split('=')[0]).filter(Boolean);
    expect(names).not.toContain('SHELF_TEST_SECRET');
    expect(names).not.toContain('AWS_SECRET_ACCESS_KEY');
    expect(names).not.toContain('DOCKER_HOST');
  });

  it('passes shell metacharacters through as literal argv entries', async () => {
    const pwned = path.join(dir, 'pwned');
    const nasty = [`a b; touch ${pwned}`, '$(touch ' + pwned + ')', '`touch ' + pwned + '`', '| cat', '*'];
    const out = await defaultExec('docker', ['compose', ...nasty]);
    expect(out.stdout.trim()).toBe('ok');
    expect(fs.readFileSync(path.join(dir, 'argv.txt'), 'utf8').split('\n').slice(0, -1)).toEqual(['compose', ...nasty]);
    expect(fs.existsSync(pwned)).toBe(false);
  });
});
