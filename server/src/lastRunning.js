// Last-running set: remembers which demos were started and in what order, so the machine can
// bring the same set back after a restart and so the bootstrap can start the most recently
// used ones. The state is plain JSON beside the registry (.data is git-ignored):
//   { "demos": [{ "id": "muse", "ts": 1793960000000 }, ...] }   (most recent first)
// Every successful `start` moves the demo to the front; a successful `stop` (or `down`)
// removes it. Nothing else writes the file. All functions are synchronous and tolerant:
// a missing or corrupt file means an empty set, never an error.
import fs from 'node:fs';
import path from 'node:path';

export function createLastRunning({ file, now = Date.now } = {}) {
  const read = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed?.demos)) return parsed.demos.filter((e) => e && typeof e.id === 'string' && Number.isFinite(e.ts));
    } catch { /* missing or corrupt: empty set */ }
    return [];
  };
  const write = (demos) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ demos }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  };

  return {
    file,
    // A successful start: front of the list, deduplicated.
    recordStart(id) {
      const demos = read().filter((e) => e.id !== id);
      demos.unshift({ id, ts: now() });
      write(demos);
    },
    // A successful stop or down: out of the list.
    recordStop(id) {
      const demos = read().filter((e) => e.id !== id);
      if (demos.length !== read().length) write(demos);
    },
    // Most recent first. The shelf UI and bootstrap read this.
    list: () => read(),
    // Ids to restore, in start order (least recently used first, so dependencies tend to
    // come up before their consumers). Capped by the caller.
    restoreIds(limit = Infinity) {
      return read().slice(0, limit).map((e) => e.id).reverse();
    },
  };
}
