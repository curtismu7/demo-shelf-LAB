// Verification marks: which shelf tiles the owner has checked ("verified") or is checking ("in-progress"), each with a short note.
// Two files, same shape, merged by id (the local one wins, like demos.local.json):
//   data/verification.json         committed; ships with the shelf, so everyone sees it
//   .data/verification.local.json  this machine's own marks; git-ignored; written by the Verification page
//   { "schema": "demo-verification/1", "marks": { "<demo id>": { "status": "verified" | "in-progress" | "none", "note": "...", "updatedAt": "YYYY-MM-DD" } } }
// "none" only means something in the local file: it hides a mark the committed file carries. Reading is forgiving (a bad entry is
// skipped, never fatal: the marks are only labels); writing is strict (the page's request is validated before it touches a file).
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA = 'demo-verification/1';
// The one definition of the marks. The label and the meaning shown anywhere (the tile, Details, the Verification page, a lab reading
// /api/shelf) come from here, so changing a word here changes it everywhere. "none" is "Not checked" and is not shown on a tile.
export const STATUS_INFO = [
  { id: 'verified', label: 'Verified', meaning: 'Checked and working as described.' },
  { id: 'in-progress', label: 'In progress', meaning: 'Being checked now. It may not work yet.' },
  { id: 'none', label: 'Not checked', meaning: 'Nobody has checked this one yet.' },
];
export const STATUSES = STATUS_INFO.map((s) => s.id);
const LABEL = Object.fromEntries(STATUS_INFO.map((s) => [s.id, s.label]));
export const NOTE_MAX = 140;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export class VerificationError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// One entry from a file, or null when it is unusable. A mark with status "none" keeps no note.
function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!STATUSES.includes(raw.status)) return null;
  const note = typeof raw.note === 'string' ? raw.note.trim() : '';
  if (note.length > NOTE_MAX || CONTROL.test(note)) return null;
  const updatedAt = typeof raw.updatedAt === 'string' && DATE.test(raw.updatedAt) ? raw.updatedAt : null;
  return { status: raw.status, note: raw.status === 'none' ? '' : note, updatedAt };
}

// Map id -> entry. A missing or corrupt file is an empty map.
export function readMarks(file) {
  const out = new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [id, raw] of Object.entries(parsed?.marks && typeof parsed.marks === 'object' ? parsed.marks : {})) {
      const e = cleanEntry(raw);
      if (e) out.set(id, e);
    }
  } catch { /* missing or corrupt: no marks */ }
  return out;
}

// The request body of a save: exactly a status and, optionally, a note. Throws VerificationError('bad-status' | 'bad-note').
export function cleanInput(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (!STATUSES.includes(b.status)) throw new VerificationError('bad-status');
  const note = b.note === undefined || b.note === null ? '' : b.note;
  if (typeof note !== 'string' || note.trim().length > NOTE_MAX || CONTROL.test(note)) throw new VerificationError('bad-note');
  return { status: b.status, note: b.status === 'none' ? '' : note.trim() };
}

const sorted = (marks) => Object.fromEntries([...marks.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

function writeJson(file, marks) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ schema: SCHEMA, marks: sorted(marks) }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// The committed file with this machine's marks folded in: "none" deletes the id, anything else replaces it. Used by
// `npm run verification:publish`; returns what changed so the script can say so.
export function publish({ seedFile, localFile }) {
  const marks = readMarks(seedFile);
  const local = readMarks(localFile);
  let set = 0;
  let cleared = 0;
  for (const [id, e] of local) {
    if (e.status === 'none') { if (marks.delete(id)) cleared += 1; continue; }
    const before = marks.get(id);
    if (!before || before.status !== e.status || before.note !== e.note) set += 1;
    marks.set(id, e);
  }
  writeJson(seedFile, marks);
  return { set, cleared, total: marks.size };
}

// `knownIds()` lists the ids a mark may be set on (the registered demos). `now` is injectable for tests.
export function createVerification({ seedFile, localFile, knownIds = () => [], now = Date.now }) {
  return {
    // Map id -> { status, label, note, updatedAt, source: 'shipped' | 'local' } for every tile that carries a mark.
    marks() {
      const out = new Map();
      for (const [id, e] of readMarks(seedFile)) if (e.status !== 'none') out.set(id, { ...e, label: LABEL[e.status], source: 'shipped' });
      for (const [id, e] of readMarks(localFile)) {
        if (e.status === 'none') out.delete(id);
        else out.set(id, { ...e, label: LABEL[e.status], source: 'local' });
      }
      return out;
    },
    // Save one tile's mark to this machine's file. Returns the mark now in force, or null for "none". Throws VerificationError.
    set(id, body) {
      if (!knownIds().includes(id)) throw new VerificationError('unknown-demo');
      const input = cleanInput(body);
      const local = readMarks(localFile);
      local.set(id, { ...input, updatedAt: new Date(now()).toISOString().slice(0, 10) });
      writeJson(localFile, local);
      return this.marks().get(id) ?? null;
    },
  };
}
