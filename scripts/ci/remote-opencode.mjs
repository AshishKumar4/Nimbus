#!/usr/bin/env bun
// OpenCode's staged assets of a commit, rebuilt on armada. A container runs
// scripts/ci/rebuild-opencode.mjs: the pinned upstream source built with the
// commit's recipe (packages/worker/scripts/opencode), then staged as a normal
// worker build stages it. The difference from the commit's staged assets and
// src/opencode-artifact.generated.ts comes back as a patch.
//
//   bun scripts/ci/remote-opencode.mjs [<commit>]
//
// Run it in the lane's worktree. <commit> defaults to HEAD; what is built is
// the commit, never the working tree. Exit 0: the build reproduces the
// commit's staged assets byte for byte, and nothing is written. Exit 1: the
// build failed, or the assets differ: the patch is applied to the worktree
// when <commit> is its HEAD and none of the staged paths has local changes,
// else left beside the run's log, whose path is printed. Then commit them, and
// run scripts/ci/remote-build.mjs for the dist fixpoint. Exit 2: not graded.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mapOnArmada } from './lib/armada.mjs';

const repoRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
const git = (args, input) => {
  const done = spawnSync('git', args, { encoding: 'utf8', input, cwd: repoRoot });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${(done.stderr || '').trim()}`);
  return done.stdout.trim();
};
const argv = process.argv.slice(2);
if (argv.length > 1 || argv.some((arg) => arg.startsWith('--'))) {
  console.error('usage: bun scripts/ci/remote-opencode.mjs [<commit>]');
  process.exit(2);
}
const repo = repoRoot;
const sha = git(['rev-parse', `${argv[0] ?? 'HEAD'}^{commit}`]);
const STAGED = ['packages/worker/public/_assets/opencode', 'packages/worker/src/opencode-artifact.generated.ts'];
const MARK = '---NIMBUS-OPENCODE-RESULT---';
const script = String.raw`
{
  set -e
  W=$(mktemp -d)
  if ! bun scripts/ci/rebuild-opencode.mjs --out "$W/result.json" > "$W/build.log" 2>&1; then
    echo BUILD-FAILED; tail -80 "$W/build.log"; exit 1
  fi
  tail -20 "$W/build.log"
  echo ${MARK}
  xz -9 < "$W/result.json" | base64 -w0
  echo
} > {out} 2>&1`;
const r = await mapOnArmada({ repo, sha, files: [], items: [1], label: `opencode assets of ${sha.slice(0, 12)}`, timeout: 3600, command: ['bash', '-c', script] });
const output = r.outputs?.[0] ?? r.outcomes?.[0]?.tail ?? '';
const [log, encoded] = output.split(MARK);
console.log(log.trim());
if (r.outcomes?.[0]?.kind !== 'exited') {
  console.error(`remote-opencode: armada could not run the build (job ${r.jobId}, ${r.outcomes?.[0]?.kind} ${r.outcomes?.[0]?.exitCode}); not graded`);
  process.exit(2);
}
if (encoded === undefined || encoded.trim() === '') {
  console.error(`remote-opencode: the build returned no result (exit ${r.outcomes[0].exitCode})`);
  process.exit(1);
}
const xz = spawnSync('xz', ['-d'], { input: Buffer.from(encoded.trim(), 'base64'), maxBuffer: 1 << 30 });
if (xz.status !== 0) throw new Error(`xz -d failed: ${xz.stderr}`);
const result = JSON.parse(xz.stdout.toString('utf8'));
const saved = join(tmpdir(), `remote-opencode-${sha.slice(0, 12)}.patch`);
// rebuild-opencode.mjs trims its git diff; a patch ends with its last line's newline.
writeFileSync(saved, `${result.patch}\n`);
console.log(`source ${result.sourceCommit}; ${result.assets.length} assets`);
if (result.patch.trim() === '') {
  console.log(`remote-opencode: the build reproduces ${sha.slice(0, 12)}'s staged assets byte for byte`);
  process.exit(0);
}
const head = git(['rev-parse', 'HEAD']);
const dirty = git(['status', '--porcelain', '--', ...STAGED]);
if (head !== sha || dirty !== '') {
  console.log(`remote-opencode: the staged assets differ; the patch is ${saved} (${head !== sha ? 'the commit is not HEAD' : 'the staged paths have local changes'}), so nothing was written. Apply it with git apply --binary at the repository root.`);
  process.exit(1);
}
git(['apply', '--binary', saved]);
console.log(`remote-opencode: applied the rebuilt assets (patch ${saved}). Review and commit them, then run scripts/ci/remote-build.mjs.`);
process.exit(1);
