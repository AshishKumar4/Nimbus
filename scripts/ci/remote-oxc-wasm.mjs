#!/usr/bin/env bun
// Nimbus's Oxc transform wasm of a commit, built on armada: a container runs
// packages/worker/scripts/oxc-wasm/build.mjs (the toolchain its
// rust-toolchain.toml pins, cargo --locked, the pinned binaryen), then
// scripts/bundle-oxc-wasm.mjs over the build, and what that stages comes
// back: the wasm, its provenance and src/oxc-wasm-artifact.generated.ts.
//
//   bun scripts/ci/remote-oxc-wasm.mjs [<commit>]
//
// Run it in the lane's worktree. <commit> defaults to HEAD; what is built is
// the commit, never the working tree. Exit 0: the build reproduces the
// commit's staged files byte for byte, and nothing is written. Exit 1: the
// build failed, or the staged files differ: they are written into the
// worktree when <commit> is its HEAD and none of them has a change of its
// own, else left in the saved archive, whose path is printed. Then commit
// them, and run scripts/ci/remote-build.mjs for the dist fixpoint. Exit 2:
// not graded.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mapOnArmada } from './lib/armada.mjs';
import { compareArtifacts, extract, FILES_MARK, keepArchive, keptAs, splitArchive, writeRefusal } from './lib/remote-artifacts.mjs';

const git = (args) => {
  const done = spawnSync('git', args, { encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${(done.stderr || '').trim()}`);
  return done.stdout.trim();
};
const argv = process.argv.slice(2);
if (argv.length > 1 || argv.some((arg) => arg.startsWith('--'))) {
  console.error('usage: bun scripts/ci/remote-oxc-wasm.mjs [<commit>]');
  process.exit(2);
}
const repo = git(['rev-parse', '--show-toplevel']);
const sha = git(['rev-parse', `${argv[0] ?? 'HEAD'}^{commit}`]);
const CRATE = 'packages/worker/scripts/oxc-wasm';
const toolchain = git(['show', `${sha}:${CRATE}/rust-toolchain.toml`]).match(/^channel = "(.+)"$/m)?.[1];
if (!toolchain) {
  console.error(`remote-oxc-wasm: ${CRATE}/rust-toolchain.toml names no channel at ${sha.slice(0, 12)}`);
  process.exit(2);
}

// As root, before the commit is checked out (armada's setup): rustup, system
// wide, with the toolchain the crate pins.
const setup = {
  name: `rust-${toolchain}-wasm32-unknown-unknown.sh`,
  text: [
    '# The Oxc wasm build\'s addition to setup.sh (scripts/ci/remote-oxc-wasm.mjs):',
    `# rustup at /opt/rustup and /opt/cargo, with rust ${toolchain} and the wasm32-unknown-unknown target.`,
    'export RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo',
    'curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain none',
    `/opt/cargo/bin/rustup toolchain install ${toolchain} --profile minimal --target wasm32-unknown-unknown`,
    'chmod -R a+rX /opt/rustup /opt/cargo',
    '',
  ].join('\n'),
};
const ASSETS = 'packages/worker/public/_assets/oxc';
const GENERATED = 'packages/worker/src/oxc-wasm-artifact.generated.ts';
const script = String.raw`
{
  set -e
  export RUSTUP_HOME=/opt/rustup CARGO_HOME="$HOME/.cargo" PATH="/opt/cargo/bin:$PATH" NIMBUS_CARGO_JOBS=4
  W=$(mktemp -d)
  start=$(date +%s)
  if ! bun ${CRATE}/build.mjs --work "$W/work" --out "$W/out" > "$W/build.log" 2>&1; then
    echo BUILD-FAILED after $(( $(date +%s) - start )) s; tail -80 "$W/build.log"; exit 1
  fi
  echo "built in $(( $(date +%s) - start )) s"
  if ! (cd packages/worker && NIMBUS_OXC_WASM_ARTIFACTS="$W/out" node scripts/bundle-oxc-wasm.mjs) > "$W/stage.log" 2>&1; then
    echo STAGE-REFUSED; cat "$W/stage.log"; exit 1
  fi
  cat "$W/stage.log"
  echo ${FILES_MARK}
  tar cf - ${GENERATED} ${ASSETS} | xz -9 | base64 -w0
  echo
} > {out} 2>&1`;
const r = await mapOnArmada({ repo, sha, files: [], setup, items: [1], label: `oxc-wasm of ${sha.slice(0, 12)}`, timeout: 3600, command: ['bash', '-c', script] });
const { log, archive } = splitArchive(r.outputs?.[0] ?? r.outcomes?.[0]?.tail ?? '');
console.log(log.trim());
if (r.outcomes?.[0]?.kind !== 'exited') {
  console.error(`remote-oxc-wasm: armada could not run the build (job ${r.jobId}, ${r.outcomes?.[0]?.kind} ${r.outcomes?.[0]?.exitCode}); not graded`);
  process.exit(2);
}
if (r.outcomes[0].exitCode !== 0 || archive === null) {
  console.error(`remote-oxc-wasm: the build failed on armada (job ${r.jobId}, exit ${r.outcomes[0].exitCode})`);
  process.exit(1);
}
const saved = `${keptAs('remote-oxc-wasm', sha.slice(0, 12))}.tar.xz`;
const staged = keepArchive(saved, archive).filter((member) => !member.endsWith('/'));
const { differing } = compareArtifacts(repo, sha, saved, staged, [ASSETS]);
if (differing.length === 0) {
  console.log(`remote-oxc-wasm: the Oxc wasm rebuilds ${sha.slice(0, 12)}'s staged files byte for byte (job ${r.jobId}; archive ${saved})`);
  process.exit(0);
}
for (const path of differing) console.log(`different ${path}`);
const refusal = writeRefusal(repo, sha, [ASSETS, GENERATED]);
if (refusal !== null) {
  console.log(`remote-oxc-wasm: ${differing.length} staged files differ; not written (${refusal}): they are in ${saved} (job ${r.jobId})`);
  process.exit(1);
}
if (existsSync(join(repo, ASSETS))) rmSync(join(repo, ASSETS), { recursive: true, force: true });
extract(repo, saved, staged);
console.log(`remote-oxc-wasm: wrote ${ASSETS} and ${GENERATED} (job ${r.jobId}; archive ${saved}). Commit them, then run scripts/ci/remote-build.mjs.`);
process.exit(1);
