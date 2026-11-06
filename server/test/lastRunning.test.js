import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLastRunning } from '../src/lastRunning.js';

describe('lastRunning', () => {
  let dir, file, lr;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lastrunning-'));
    file = path.join(dir, 'last-running.json');
    lr = createLastRunning({ file });
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('starts empty on a missing file', () => {
    expect(lr.list()).toEqual([]);
    expect(lr.restoreIds(10)).toEqual([]);
  });

  it('records starts most-recent-first and dedupes', () => {
    lr.recordStart('a'); lr.recordStart('b'); lr.recordStart('a');
    expect(lr.list().map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('recordStop removes the demo', () => {
    lr.recordStart('a'); lr.recordStart('b');
    lr.recordStop('a');
    expect(lr.list().map((e) => e.id)).toEqual(['b']);
    lr.recordStop('not-there'); // no-op, no throw
    expect(lr.list().map((e) => e.id)).toEqual(['b']);
  });

  it('restoreIds returns least-recent-first, capped', () => {
    for (const id of ['a', 'b', 'c', 'd']) lr.recordStart(id);
    expect(lr.restoreIds(2)).toEqual(['c', 'd']);
    expect(lr.restoreIds()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('tolerates a corrupt file and rewrites it on the next record', () => {
    fs.writeFileSync(file, '{not json');
    expect(lr.list()).toEqual([]);
    lr.recordStart('x');
    expect(lr.list().map((e) => e.id)).toEqual(['x']);
  });

  it('persists across instances (machine restart)', () => {
    lr.recordStart('a');
    const lr2 = createLastRunning({ file });
    expect(lr2.list().map((e) => e.id)).toEqual(['a']);
  });
});
