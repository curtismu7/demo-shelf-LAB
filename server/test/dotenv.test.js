import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadShelfEnv } from '../src/dotenv.js';

const KEYS = ['DOTENV_TEST_A', 'DOTENV_TEST_B'];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

const tmpRoot = (text) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotenv-'));
  if (text !== null) fs.writeFileSync(path.join(root, '.env'), text);
  return root;
};

describe('loadShelfEnv', () => {
  it('reads the shelf .env, and a variable already in the environment wins', () => {
    process.env.DOTENV_TEST_B = 'from-shell';
    const added = loadShelfEnv(tmpRoot('DOTENV_TEST_A=from-file\nDOTENV_TEST_B=from-file\n'));
    expect(process.env.DOTENV_TEST_A).toBe('from-file');
    expect(process.env.DOTENV_TEST_B).toBe('from-shell');
    expect(added).toEqual(['DOTENV_TEST_A']);
  });
  it('does nothing without a .env', () => {
    expect(loadShelfEnv(tmpRoot(null))).toBeNull();
  });
  it('SHELF_ENV_FILE points at another file', () => {
    const other = path.join(tmpRoot(null), 'other.env');
    fs.writeFileSync(other, 'DOTENV_TEST_A=other\n');
    loadShelfEnv(tmpRoot('DOTENV_TEST_A=root\n'), { ...process.env, SHELF_ENV_FILE: other });
    expect(process.env.DOTENV_TEST_A).toBe('other');
  });
  it('is skipped inside the container', () => {
    expect(loadShelfEnv(tmpRoot('DOTENV_TEST_A=x\n'), { ...process.env, SHELF_IN_DOCKER: '1' })).toBeNull();
    expect(process.env.DOTENV_TEST_A).toBeUndefined();
  });
});
