// A remote build's patch, applied to the lane's worktree only as the build
// left it (remote-build.mjs's dist, remote-opencode.mjs's staged assets).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const git = (cwd, args, options = {}) => {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30, ...options });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${(done.stderr || done.error?.message || '').trim()}`);
  return done.stdout.trim();
};

/**
 * Apply a remote build's patch to the worktree only if the result is exactly
 * the build's: the patch applied to <sha> in a scratch index must give every
 * path the mode and blob the container reported it left (`blobs`, apart
 * from the patch: lib/output-patch.mjs), every file it touches must be as
 * HEAD (= <sha>) has it, and once applied those files must hash the same
 * again. git's whitespace repair is off throughout, so no side is rewritten
 * to agree. Otherwise nothing is applied, and the patch is left for you.
 * `as` names the client and its patch, and what comes after it is applied.
 * Returns what happened.
 */
export function applyPatch(repo, sha, patch, blobs, as) {
  const scratch = mkdtempSync(join(tmpdir(), 'remote-build-apply-'));
  try {
    const indexed = (name) => ({ ...process.env, GIT_INDEX_FILE: join(scratch, name) });
    git(repo, ['read-tree', sha], { env: indexed('built') });
    git(repo, ['apply', '--cached', '--whitespace=nowarn', patch], { env: indexed('built') });
    const tree = git(repo, ['write-tree'], { env: indexed('built') });
    // Without renames, as the build's receipts are: a moved output is its old path and its new one.
    const touched = git(repo, ['diff', '--name-only', '--no-renames', '-z', sha, tree]).split('\0').filter(Boolean);
    const expected = Object.keys(blobs).sort();
    if (JSON.stringify([...touched].sort()) !== JSON.stringify(expected)) {
      throw new Error(`the patch touches ${touched.length} paths, and the build reported ${expected.length}`);
    }
    const mismatch = (ofTree) => {
      const listed = new Map(git(repo, ['ls-tree', '-r', '-z', ofTree, '--', ...touched]).split('\0').filter(Boolean)
        .map((line) => { const [meta, path] = line.split('\t'); const [mode, , blob] = meta.split(' '); return [path, { mode, blob }]; }));
      return touched.filter((path) => JSON.stringify(listed.get(path) ?? null) !== JSON.stringify(blobs[path]));
    };
    const unlike = mismatch(tree);
    if (unlike.length > 0) throw new Error(`the patch does not make what the build left: ${unlike.join(', ')}`);
    const leave = (why) => `${as.client}: the ${as.name} (${touched.length} files) is ${patch}; ${why}, so nothing was applied. Apply it on ${sha.slice(0, 12)} with \`git apply ${patch}\`, then commit it.`;
    if (git(repo, ['rev-parse', 'HEAD']) !== sha) return leave(`${sha.slice(0, 12)} is not this worktree's HEAD`);
    const local = git(repo, ['status', '--porcelain', '--untracked-files=all', '--', ...touched]);
    if (local) return leave(`files it touches have local changes:\n${local}\n`);
    git(repo, ['apply', '--whitespace=nowarn', patch]);
    git(repo, ['read-tree', 'HEAD'], { env: indexed('applied') });
    git(repo, ['add', '--all', '--', ...touched], { env: indexed('applied') });
    const applied = git(repo, ['write-tree'], { env: indexed('applied') });
    const differ = mismatch(applied);
    if (differ.length > 0) throw new Error(`the applied files differ from what the build left: ${differ.join(', ')}`);
    return `${as.client}: applied the ${as.name} (${touched.length} files) to ${repo}, each file the blob the build left. Review it and commit it, then ${as.next}.`;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
