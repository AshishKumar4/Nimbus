#!/usr/bin/env bun
// The build of a commit on armada instead of this machine. A container runs
// scripts/ci/build.mjs (the dist fixpoint, then the typecheck); the result
// lands here: typecheck errors are printed, and the dist patch is applied to
// the worktree for you to commit.
//
//   bun scripts/ci/remote-build.mjs [<commit>] [--no-cache]
//
// Run it in the lane's worktree. <commit> defaults to HEAD; what is built is
// the commit, never the working tree, so commit first. The container gets a
// throwaway commit object on no branch: <commit>'s tree with this checkout's
// armada recipe (.armada.json, scripts/ci/recipe/) and scripts/ci/build.mjs laid
// over it, so a lane branched before those existed builds the same way.
//
// The patch is applied only when <commit> is the worktree's HEAD and every
// file it touches is as HEAD has it, and the result is checked against the
// tree the build made (applyPatch). Otherwise it is saved and the command to
// apply it printed. The verdict and patch are kept under
// ~/.local/state/nimbus/remote-builds/, named by time, commit and job.
//
// Exit: 0, dist is the fixpoint and the typecheck is clean; 1, a patch was
// applied or saved, or the typecheck or the gate failed; 2, not graded.
// armada is reached as scripts/ci/lib/armada.mjs says.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapOnArmada } from './lib/armada.mjs';

const git = (cwd, args, options = {}) => {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30, ...options });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${(done.stderr || done.error?.message || '').trim()}`);
  return done.stdout.trim();
};

/** The last `lines` lines of `text`. */
const lastLines = (text, lines) => text.split('\n').slice(-lines).join('\n');

/**
 * Apply the build's patch to the worktree only if the result is exactly the
 * build's: the patch applied to <sha> in a scratch index must give every
 * path the mode and blob the container reported it left (`blobs`, apart
 * from the patch), every file it touches must be as HEAD (= <sha>) has it,
 * and once applied those files must hash the same again. git's whitespace
 * repair is off throughout, so no side is rewritten to agree. Otherwise
 * nothing is applied, and the patch is left for you. Returns what happened.
 */
export function applyPatch(repo, sha, patch, blobs) {
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
    const leave = (why) => `remote-build: the dist patch (${touched.length} files) is ${patch}; ${why}, so nothing was applied. Apply it on ${sha.slice(0, 12)} with \`git apply ${patch}\`, then commit it.`;
    if (git(repo, ['rev-parse', 'HEAD']) !== sha) return leave(`${sha.slice(0, 12)} is not this worktree's HEAD`);
    const local = git(repo, ['status', '--porcelain', '--untracked-files=all', '--', ...touched]);
    if (local) return leave(`files it touches have local changes:\n${local}\n`);
    git(repo, ['apply', '--whitespace=nowarn', patch]);
    git(repo, ['read-tree', 'HEAD'], { env: indexed('applied') });
    git(repo, ['add', '--all', '--', ...touched], { env: indexed('applied') });
    const applied = git(repo, ['write-tree'], { env: indexed('applied') });
    const differ = mismatch(applied);
    if (differ.length > 0) throw new Error(`the applied files differ from what the build left: ${differ.join(', ')}`);
    return `remote-build: applied the dist patch (${touched.length} files) to ${repo}, each file the blob the build left. Review it and commit it, then run scripts/ci/remote-unit.mjs on that commit.`;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const args = argv.filter((arg) => arg === '--no-cache');
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  if (positional.length > 1 || argv.length !== args.length + positional.length) {
    console.error('usage: bun scripts/ci/remote-build.mjs [<commit>] [--no-cache]');
    process.exit(2);
  }

  /** Not graded: whatever went wrong before a verdict was in hand. */
  const notGraded = (error) => {
    console.error(`remote-build: NOT GRADED — ${error.message}`);
    process.exit(2);
  };

  let repo;
  let sha;
  let built;
  try {
    repo = git(process.cwd(), ['rev-parse', '--show-toplevel']);
    sha = git(repo, ['rev-parse', '--verify', `${positional[0] ?? 'HEAD'}^{commit}`]);
    const mapped = await mapOnArmada({
      repo, sha, files: ['scripts/ci/build.mjs'], items: [1], label: `remote-build ${sha.slice(0, 12)}`,
      command: ['bun', 'scripts/ci/build.mjs', '--out', '{out}', ...args],
    });
    const [outcome] = mapped.outcomes;
    if (outcome?.kind !== 'exited') throw new Error(`armada could not run the build (job ${mapped.jobId}):\n${outcome?.tail ?? 'no outcome'}`);
    if (mapped.outputs[0] === null) throw new Error(`the build wrote no verdict (job ${mapped.jobId}, exit ${outcome.exitCode}):\n${outcome.tail}`);
    const verdict = JSON.parse(mapped.outputs[0]);
    // The verdict is for the commit this run made, and nothing else.
    if (verdict.head !== mapped.commit) throw new Error(`the verdict is for ${verdict.head}, not ${mapped.commit} (job ${mapped.jobId})`);
    if (typeof verdict.blobs !== 'object' || verdict.blobs === null) throw new Error(`the verdict names no blobs to check a patch against (job ${mapped.jobId})`);
    built = { jobId: mapped.jobId, verdict };
  } catch (error) {
    notGraded(error);
  }
  const { jobId, verdict } = built;

  try {
    const state = join(homedir(), '.local', 'state', 'nimbus', 'remote-builds');
    mkdirSync(state, { recursive: true });
    const stem = join(state, `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${sha.slice(0, 12)}-${jobId}`);
    writeFileSync(`${stem}.json`, `${JSON.stringify({ commit: sha, job: jobId, ...verdict }, null, 2)}\n`);

    for (const row of verdict.rows) {
      console.log(`${row.exitCode === 0 ? 'ok  ' : 'FAIL'} ${row.name} (exit ${row.exitCode}, ${Math.round(row.seconds)} s)`);
      if (row.exitCode !== 0) console.log(`${lastLines(row.output.trimEnd(), 120)}\n`);
    }
    let status = verdict.rows.every((row) => row.exitCode === 0) && verdict.patch === null ? 0 : 1;
    if (verdict.rows.some((row) => row.name === 'checkout')) status = 2;
    if (verdict.patch !== null) {
      writeFileSync(`${stem}.patch`, verdict.patch);
      console.log(applyPatch(repo, sha, `${stem}.patch`, verdict.blobs));
    }
    console.log(`remote-build: ${status === 0 ? 'dist is the fixpoint of src and the typecheck is clean' : 'see above'}; verdict ${stem}.json (job ${jobId})`);
    process.exit(status);
  } catch (error) {
    notGraded(error);
  }
}
