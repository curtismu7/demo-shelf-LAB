// One-click deploy: make sure the demo's repo is on this machine (clone from the registry-validated
// `repo` URL into the demo root, or fast-forward it), then start it. The URL comes from the registry,
// never from the request; the folder is always <demoRoot>/<repo name> and nothing else.
import path from 'node:path';

export const DEPLOY_TIMEOUT_MS = 600_000; // a first clone plus an image build

// The only repo shape the registry accepts is https://github.com/<org>/<name>; the deploy folder is the
// name part. Returns null for anything the registry would have refused (defense in depth).
export function deployFolderOf(repo) {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9._-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(repo || '');
  if (!m) return null;
  const bad = (x) => x === '.' || x === '..';
  return !bad(m[1]) && !bad(m[2]) && !m[2].endsWith('.git') ? m[2] : null;
}

// 'cloned' | 'fast-forwarded' | 'up-to-date' | 'pulled'. Git output is redacted upstream (redact()); the
// folder is derived from the validated repo URL, the remote URL is fixed, and no refspec or path is accepted.
export async function ensureRepo(demo, demoRoot, { exec, timeoutMs = DEPLOY_TIMEOUT_MS } = {}) {
  const folder = deployFolderOf(demo.repo);
  if (!folder || !demoRoot) return { ok: false, error: 'no-repo' };
  const dir = path.join(demoRoot, folder);
  const url = `${demo.repo}.git`;
  let st;
  try { st = await exec('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { timeoutMs: 15_000 }); }
  catch { st = null; }
  if (st && st.stdout.trim() !== 'true') return { ok: false, error: 'deploy-dir-not-a-repo', dir };
  if (st && st.stdout.trim() === 'true') {
    try {
      const fw = await exec('git', ['-C', dir, 'pull', '--ff-only'], { timeoutMs });
      return { ok: true, dir, how: /Already up to date/i.test(`${fw.stdout}${fw.stderr}`) ? 'up-to-date' : 'fast-forwarded' };
    } catch (e) {
      return { ok: false, error: 'git-pull-failed', output: `${e.stdout || ''}\n${e.stderr || ''}` };
    }
  }
  if (st) return { ok: false, error: 'deploy-dir-not-a-repo', dir };
  try {
    await exec('git', ['clone', url, dir], { timeoutMs });
    return { ok: true, dir, how: 'cloned' };
  } catch (e) {
    // A half-made folder must not wedge every later deploy: remove it only if git created it this call.
    return { ok: false, error: 'git-clone-failed', output: `${e.stdout || ''}\n${e.stderr || ''}`, dir };
  }
}
