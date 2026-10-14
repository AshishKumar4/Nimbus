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
// tree the build made (lib/apply-patch.mjs). Otherwise it is saved and the command to
// apply it printed. The verdict and patch are kept under
// ~/.local/state/nimbus/remote-builds/, named by time, commit and job.
//
// Exit: 0, dist is the fixpoint and the typecheck is clean; 1, a patch was
// applied or saved, or the typecheck or the gate failed; 2, not graded.
// armada is reached as scripts/ci/lib/armada.mjs says.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyPatch } from './lib/apply-patch.mjs';
import { mapOnArmada } from './lib/armada.mjs';
import { NIMBUS_STATE } from './lib/state-dir.mjs';

const git = (cwd, args, options = {}) => {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30, ...options });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${(done.stderr || done.error?.message || '').trim()}`);
  return done.stdout.trim();
};

/** The last `lines` lines of `text`. */
const lastLines = (text, lines) => text.split('\n').slice(-lines).join('\n');

/** How remote-build names its patch, and what comes after it is applied. */
export const DIST_PATCH = { client: 'remote-build', name: 'dist patch', next: 'run scripts/ci/remote-unit.mjs on that commit' };

/** This checkout's build script laid over the commit, with all it imports: the verdict is the one this client reads. */
export const DIST_OVERLAY = ['scripts/ci/build.mjs', 'scripts/ci/lib/output-patch.mjs', 'scripts/ci/lib/step.mjs'];

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
      repo, sha, files: DIST_OVERLAY, items: [1], label: `remote-build ${sha.slice(0, 12)}`,
      command: ['bun', 'scripts/ci/build.mjs', '--out', '{out}', ...args],
    });
    const [outcome] = mapped.outcomes;
    if (outcome?.kind !== 'exited') throw new Error(`armada could not run the build (job ${mapped.jobId}):\n${outcome?.tail ?? 'no outcome'}`);
    if (mapped.outputs[0] === null) throw new Error(`the build wrote no verdict (job ${mapped.jobId}, exit ${outcome.exitCode}):\n${outcome.tail}`);
    const verdict = JSON.parse(mapped.outputs[0]);
    // The verdict is for the commit this run made, and nothing else.
    if (verdict.head !== mapped.commit) throw new Error(`the verdict is for ${verdict.head}, not ${mapped.commit} (job ${mapped.jobId})`);
    if (typeof verdict.blobs !== 'object' || verdict.blobs === null) throw new Error(`the verdict names no blobs to check a patch against (job ${mapped.jobId})`);
    built = { jobId: mapped.jobId, verdict, exitCode: outcome.exitCode };
  } catch (error) {
    notGraded(error);
  }
  const { jobId, verdict, exitCode } = built;

  try {
    const state = join(NIMBUS_STATE, 'remote-builds');
    mkdirSync(state, { recursive: true });
    const stem = join(state, `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${sha.slice(0, 12)}-${jobId}`);
    writeFileSync(`${stem}.json`, `${JSON.stringify({ commit: sha, job: jobId, ...verdict }, null, 2)}\n`);

    for (const row of verdict.rows) {
      console.log(`${row.exitCode === 0 ? 'ok  ' : 'FAIL'} ${row.name} (exit ${row.exitCode}, ${Math.round(row.seconds)} s)`);
      if (row.exitCode !== 0) console.log(`${lastLines(row.output.trimEnd(), 120)}\n`);
    }
    let status = verdict.rows.every((row) => row.exitCode === 0) && verdict.patch === null ? 0 : 1;
    // build.mjs's own status: 2 is not graded (no clean checkout, no patch to trust).
    if (exitCode === 2) status = 2;
    if (verdict.patch !== null) {
      writeFileSync(`${stem}.patch`, verdict.patch);
      console.log(applyPatch(repo, sha, `${stem}.patch`, verdict.blobs, DIST_PATCH));
    }
    console.log(`remote-build: ${status === 0 ? 'dist is the fixpoint of src and the typecheck is clean' : 'see above'}; verdict ${stem}.json (job ${jobId})`);
    process.exit(status);
  } catch (error) {
    notGraded(error);
  }
}
