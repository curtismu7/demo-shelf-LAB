// `npm run verification:publish`: fold this machine's verification marks (.data/verification.local.json, written by the
// Verification page) into the committed data/verification.json, so a PR can ship them to everyone. A mark set to "None"
// removes that tile's committed mark. The local file is left alone; it keeps overriding until the PR is merged and the
// shelf is rebuilt, and it says the same thing afterwards.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publish } from '../server/src/verification.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.SHELF_DATA_DIR || path.join(root, '.data'));
const r = publish({ seedFile: path.join(root, 'data', 'verification.json'), localFile: path.join(dataDir, 'verification.local.json') });
console.log(`data/verification.json: ${r.set} set or changed, ${r.cleared} cleared, ${r.total} marks in all.`);
console.log(r.set || r.cleared ? 'Review it with git diff data/verification.json, then commit and open a PR.' : 'Nothing to publish.');
