#!/usr/bin/env bun
// OpenCode's staged assets of a commit, rebuilt on armada. A container runs
// scripts/ci/rebuild-opencode.mjs: the pinned upstream source built with the
// commit's recipe (packages/worker/scripts/opencode), then staged as a normal
// worker build stages it. The difference from the commit's staged assets and
// src/opencode-artifact.generated.ts comes back as a patch with its blobs,
// and is applied as remote-build applies dist's (lib/apply-patch.mjs).
//
//   bun scripts/ci/remote-opencode.mjs [<commit>]
//
// Run it in the lane's worktree. <commit> defaults to HEAD; what is built is
// the commit, never the working tree. The patch and the build's log are kept
// under ~/.local/state/nimbus/remote-opencode/, named by time, commit and job.
//
// Exit: 0, the build reproduces the commit's staged assets byte for byte;
// 1, the build failed, or the assets differ and the patch was applied (then
// commit them and run scripts/ci/remote-build.mjs) or left for you; 2, not
// graded.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyPatch } from './lib/apply-patch.mjs';
import { mapOnArmada } from './lib/armada.mjs';
import { NIMBUS_STATE } from './lib/state-dir.mjs';

/**
 * This checkout's producer laid over the commit, with all it imports from
 * scripts/ci, as remote-build lays build.mjs: the result is the shape this
 * client reads.
 */
export const OPENCODE_OVERLAY = ['scripts/ci/rebuild-opencode.mjs', 'scripts/ci/lib/output-patch.mjs'];

if (import.meta.main) {
  const git = (cwd, args) => {
    const done = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${(done.stderr || '').trim()}`);
    return done.stdout.trim();
  };
  const argv = process.argv.slice(2);
  if (argv.length > 1 || argv.some((arg) => arg.startsWith('--'))) {
    console.error('usage: bun scripts/ci/remote-opencode.mjs [<commit>]');
    process.exit(2);
  }
  /** Not graded: whatever went wrong before a result was in hand. */
  const notGraded = (why) => {
    console.error(`remote-opencode: NOT GRADED — ${why}`);
    process.exit(2);
  };

  const repo = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  const sha = git(repo, ['rev-parse', '--verify', `${argv[0] ?? 'HEAD'}^{commit}`]);
  // The result is large (the staged parser alone is megabytes): xz and base64 after the log.
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
  const mapped = await mapOnArmada({ repo, sha, files: OPENCODE_OVERLAY, items: [1], label: `opencode assets of ${sha.slice(0, 12)}`, timeout: 3600, command: ['bash', '-c', script] });
  const [outcome] = mapped.outcomes;
  const [log, encoded] = (mapped.outputs?.[0] ?? outcome?.tail ?? '').split(MARK);
  console.log(log.trim());
  if (outcome?.kind !== 'exited') notGraded(`armada could not run the build (job ${mapped.jobId}, ${outcome?.kind ?? 'no outcome'})`);
  if (encoded === undefined || encoded.trim() === '') {
    console.error(`remote-opencode: the build returned no result (job ${mapped.jobId}, exit ${outcome.exitCode})`);
    process.exit(1);
  }
  const xz = spawnSync('xz', ['-d'], { input: Buffer.from(encoded.trim(), 'base64'), maxBuffer: 1 << 30 });
  if (xz.status !== 0) notGraded(`xz -d failed: ${xz.stderr}`);
  const result = JSON.parse(xz.stdout.toString('utf8'));
  // The result is for the commit this run made, and nothing else.
  if (result.head !== mapped.commit) notGraded(`the result is for ${result.head}, not ${mapped.commit} (job ${mapped.jobId})`);
  if (typeof result.blobs !== 'object' || result.blobs === null) notGraded(`the result names no blobs to check a patch against (job ${mapped.jobId})`);
  console.log(`source ${result.sourceCommit}; ${result.assets.length} assets`);

  const state = join(NIMBUS_STATE, 'remote-opencode');
  mkdirSync(state, { recursive: true });
  const stem = join(state, `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${sha.slice(0, 12)}-${mapped.jobId}`);
  writeFileSync(`${stem}.log`, log);
  if (result.patch === null) {
    console.log(`remote-opencode: the build reproduces ${sha.slice(0, 12)}'s staged assets byte for byte (job ${mapped.jobId})`);
    process.exit(0);
  }
  writeFileSync(`${stem}.patch`, result.patch);
  console.log(applyPatch(repo, sha, `${stem}.patch`, result.blobs, { client: 'remote-opencode', name: 'opencode assets patch', next: 'run scripts/ci/remote-build.mjs on that commit for the dist fixpoint' }));
  process.exit(1);
}
