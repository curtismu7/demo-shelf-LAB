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

  it('passes shell metacharacters through as literal argv entries', async () => {
    const pwned = path.join(dir, 'pwned');
    const nasty = [`a b; touch ${pwned}`, '$(touch ' + pwned + ')', '`touch ' + pwned + '`', '| cat', '*'];
    const out = await defaultExec('docker', ['compose', ...nasty]);
    expect(out.stdout.trim()).toBe('ok');
    expect(fs.readFileSync(path.join(dir, 'argv.txt'), 'utf8').split('\n').slice(0, -1)).toEqual(['compose', ...nasty]);
    expect(fs.existsSync(pwned)).toBe(false);
  });
});
