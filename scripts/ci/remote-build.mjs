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
// armada recipe (.armada.json, scripts/armada/) and scripts/ci/build.mjs laid
// over it, so a lane branched before those existed builds the same way.
//
// If <commit> is the worktree's HEAD, the patch is applied with `git apply`,
// which refuses (and changes nothing) when a file it touches has local
// changes. Otherwise it is saved and the command to apply it printed. The
// verdict and patch are kept under ~/.local/state/nimbus/remote-builds/.
//
// Exit: 0, dist is the fixpoint and the typecheck is clean; 1, a patch was
// applied or saved, or the typecheck or the gate failed; 2, not graded.
// armada is reached as scripts/ci/lib/armada.mjs says.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mapOnArmada } from './lib/armada.mjs';

const git = (cwd, args) => {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${(done.stderr || done.error?.message || '').trim()}`);
  return done.stdout.trim();
};

/** The last `lines` lines of `text`. */
const lastLines = (text, lines) => text.split('\n').slice(-lines).join('\n');

const argv = process.argv.slice(2);
const args = argv.filter((arg) => arg === '--no-cache');
const positional = argv.filter((arg) => !arg.startsWith('--'));
if (positional.length > 1 || argv.length !== args.length + positional.length) {
  console.error('usage: bun scripts/ci/remote-build.mjs [<commit>] [--no-cache]');
  process.exit(2);
}
const repo = git(process.cwd(), ['rev-parse', '--show-toplevel']);
const sha = git(repo, ['rev-parse', '--verify', `${positional[0] ?? 'HEAD'}^{commit}`]);
let jobId;
let verdict;
try {
  const mapped = await mapOnArmada({
    repo, sha, files: ['scripts/ci/build.mjs'], items: [1], label: `remote-build ${sha.slice(0, 12)}`,
    command: ['bun', 'scripts/ci/build.mjs', '--out', '{out}', ...args],
  });
  jobId = mapped.jobId;
  const [outcome] = mapped.outcomes;
  if (outcome?.kind !== 'exited') throw new Error(`armada could not run the build (job ${jobId}):\n${outcome?.tail ?? 'no outcome'}`);
  if (mapped.outputs[0] === null) throw new Error(`the build wrote no verdict (job ${jobId}, exit ${outcome.exitCode}):\n${outcome.tail}`);
  verdict = JSON.parse(mapped.outputs[0]);
} catch (error) {
  console.error(`remote-build: NOT GRADED — ${error.message}`);
  process.exit(2);
}
const state = join(homedir(), '.local', 'state', 'nimbus', 'remote-builds');
mkdirSync(state, { recursive: true });
const stem = join(state, `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${sha.slice(0, 12)}`);
writeFileSync(`${stem}.json`, `${JSON.stringify({ commit: sha, job: jobId, ...verdict }, null, 2)}\n`);

for (const row of verdict.rows) {
  console.log(`${row.exitCode === 0 ? 'ok  ' : 'FAIL'} ${row.name} (exit ${row.exitCode}, ${Math.round(row.seconds)} s)`);
  if (row.exitCode !== 0) console.log(`${lastLines(row.output.trimEnd(), 120)}\n`);
}
let status = verdict.rows.every((row) => row.exitCode === 0) && verdict.patch === null ? 0 : 1;
if (verdict.rows.some((row) => row.name === 'checkout')) status = 2;
if (verdict.patch !== null) {
  writeFileSync(`${stem}.patch`, verdict.patch);
  const files = verdict.patch.match(/^diff --git /gm)?.length ?? 0;
  const atHead = git(repo, ['rev-parse', 'HEAD']) === sha;
  const applied = atHead && spawnSync('git', ['apply', `${stem}.patch`], { cwd: repo, stdio: 'inherit' }).status === 0;
  console.log(applied
    ? `remote-build: applied the dist patch (${files} files) to ${repo}. Review it and commit it, then run ci-run on that commit.`
    : `remote-build: the dist patch (${files} files) is ${stem}.patch; ${atHead ? 'it did not apply here' : `${sha.slice(0, 12)} is not this worktree's HEAD`}. `
      + `Apply it on ${sha.slice(0, 12)} with \`git apply ${stem}.patch\`, then commit it.`);
}
console.log(`remote-build: ${status === 0 ? 'dist is the fixpoint of src and the typecheck is clean' : 'see above'}; verdict ${stem}.json (job ${jobId})`);
process.exit(status);
