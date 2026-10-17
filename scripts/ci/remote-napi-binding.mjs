#!/usr/bin/env bun
// napi-wasm bindings of a commit, built on armada: a container runs
// packages/worker/scripts/napi-wasm/build.mjs --spec <name>@<version>,...
// (each tag archive by digest, the toolchains their rust-toolchain.toml pin,
// cargo --locked, and the loader), then scripts/bundle-napi-wasm.mjs over
// them and the commit's other staged builds, and what that stages comes
// back: each binding's <name>.wasm and provenance.json, the loader, and
// src/napi-wasm-artifacts.generated.ts pinning their digests (the lockfile a
// build pruned from upstream's, when it did, stays in the saved archive).
// Supporting a new version of a binding is a spec line
// (scripts/napi-wasm/specs.mjs) and this run.
//
//   bun scripts/ci/remote-napi-binding.mjs <name>@<version>... [<commit>]
//
// An input several bindings share (a wrapper crate, build.mjs, link-wasm.sh)
// stales them all: name them together, as bundle-napi-wasm.mjs's refusal
// does. Each binding's build checks its own inputs before and after it, so
// one the whole-tree stage cannot take (another binding is stale) still comes
// back in the saved archive, and the run names the bindings to add.
//
// The build environment is armada's recipe plus rustup with the specs'
// toolchains and the wasm32-wasip1 target, written for the job: its key is
// that text, so each set of toolchains is an environment of its own, prepared once.
//
// Run it in the lane's worktree. <commit> defaults to HEAD; what is built is
// the commit, never the working tree. Exit 0: the build reproduces the
// commit's staged files byte for byte, and nothing is written. Exit 1: the
// build failed, or the staged files differ: they are written into the
// worktree when <commit> is its HEAD and none of them has a change of its
// own (checked when the run returns, so an edit made during it counts), else
// left in the saved archive, whose path is printed. Then commit them, and run
// scripts/ci/remote-build.mjs for the dist fixpoint. Exit 2: not graded.
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
const KEY = /^[\w-]+@\d[\w.+-]*$/;
const keys = argv.filter((arg) => KEY.test(arg));
const rest = argv.filter((arg) => !KEY.test(arg));
if (keys.length === 0 || rest.length > 1 || argv.some((arg) => arg.startsWith('--')) || new Set(keys).size !== keys.length) {
  console.error('usage: bun scripts/ci/remote-napi-binding.mjs <name>@<version>... [<commit>]');
  process.exit(2);
}
const repo = git(['rev-parse', '--show-toplevel']);
const sha = git(['rev-parse', `${rest[0] ?? 'HEAD'}^{commit}`]);
const { SPECS } = await import(join(repo, 'packages/worker/scripts/napi-wasm/specs.mjs'));
const unknown = keys.filter((key) => !SPECS[key]);
if (unknown.length) {
  console.error(`no spec ${unknown.join(', ')} in packages/worker/scripts/napi-wasm/specs.mjs (specs: ${Object.keys(SPECS).join(', ')})`);
  process.exit(2);
}
const toolchains = [...new Set(keys.map((key) => SPECS[key].toolchain))].sort();

// As root, before the commit is checked out (armada's setup): rustup, system
// wide, with the toolchains the specs pin.
const setup = {
  name: `rust-${toolchains.join('-')}.sh`,
  text: [
    '# The napi-wasm binding build\'s addition to setup.sh (scripts/ci/remote-napi-binding.mjs):',
    `# rustup at /opt/rustup and /opt/cargo, with rust ${toolchains.join(', ')} and the wasm32-wasip1 target.`,
    'export RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo',
    'curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain none',
    ...toolchains.map((toolchain) => `/opt/cargo/bin/rustup toolchain install ${toolchain} --profile minimal --target wasm32-wasip1`),
    'chmod -R a+rX /opt/rustup /opt/cargo',
    '',
  ].join('\n'),
};
const ASSETS = 'packages/worker/public/_assets/napi-wasm';
const LOADER = `${ASSETS}/loader`;
const GENERATED = 'packages/worker/src/napi-wasm-artifacts.generated.ts';
const dirs = keys.map((key) => `${ASSETS}/${key.replace('@', '/')}`);
const outs = keys.map((key) => key.replace('@', '/'));
const script = String.raw`
{
  set -e
  export RUSTUP_HOME=/opt/rustup CARGO_HOME="$HOME/.cargo" PATH="/opt/cargo/bin:$PATH" NIMBUS_CARGO_JOBS=4
  W=$(mktemp -d)
  start=$(date +%s)
  # Each binding's build checks its own inputs before and after it.
  if ! bun packages/worker/scripts/napi-wasm/build.mjs --work "$W/work" --out "$W/out" --spec ${keys.join(',')} > "$W/build.log" 2>&1; then
    echo BUILD-FAILED after $(( $(date +%s) - start )) s; tail -80 "$W/build.log"; exit 1
  fi
  echo "built in $(( $(date +%s) - start )) s"
  # Every other staged build as the commit has it, beside the new ones: the
  # whole tree bundle-napi-wasm.mjs stages and pins.
  for d in ${ASSETS}/*/*/; do
    rel=$(printf '%s' "$d" | sed 's#^${ASSETS}/##')
    case "$rel" in loader/*) continue ;; esac
    [ -d "$W/out/$rel" ] || { mkdir -p "$W/out/$rel"; cp "$d"* "$W/out/$rel"; }
  done
  for key in ${outs.join(' ')}; do echo "---PROVENANCE $key---"; cat "$W/out/$key/provenance.json"; done
  if (cd packages/worker && NIMBUS_NAPI_WASM_ARTIFACTS="$W/out" bun scripts/bundle-napi-wasm.mjs) > "$W/stage.log" 2>&1; then
    cat "$W/stage.log"
    echo ${FILES_MARK}
    tar cf - ${GENERATED} ${LOADER} ${dirs.join(' ')} -C "$W/out" ${outs.join(' ')} | xz -9 | base64 -w0
  else
    echo STAGE-REFUSED; cat "$W/stage.log"
    echo ${FILES_MARK}
    tar cf - -C "$W/out" ${outs.join(' ')} | xz -9 | base64 -w0
  fi
  echo
} > {out} 2>&1`;
const r = await mapOnArmada({ repo, sha, files: [], setup, items: [1], label: `napi-wasm ${keys.join(' ')} of ${sha.slice(0, 12)}`, timeout: 3600, command: ['bash', '-c', script] });
const { log, archive } = splitArchive(r.outputs?.[0] ?? r.outcomes?.[0]?.tail ?? '');
console.log(log.trim());
if (r.outcomes?.[0]?.kind !== 'exited') {
  console.error(`remote-napi-binding: armada could not run the build (job ${r.jobId}, ${r.outcomes?.[0]?.kind} ${r.outcomes?.[0]?.exitCode}); not graded`);
  process.exit(2);
}
if (r.outcomes[0].exitCode !== 0 || archive === null) {
  console.error(`remote-napi-binding: the build failed on armada (job ${r.jobId}, exit ${r.outcomes[0].exitCode})`);
  process.exit(1);
}
const saved = `${keptAs('remote-napi-binding', `${keys.join('+')}-${sha.slice(0, 12)}`)}.tar.xz`;
const members = keepArchive(saved, archive);
if (/^STAGE-REFUSED$/m.test(log)) {
  // Each build checked its own inputs; the whole tree still holds a stale one.
  console.error(`remote-napi-binding: built ${keys.join(', ')} (each from this commit's inputs, in ${saved}), but the staging refused the whole tree: regenerate the bindings it names together with these (job ${r.jobId})`);
  process.exit(1);
}
// What bundle-napi-wasm staged; the builds' own out trees (their pruned
// lockfiles) stay in the archive, out of the Worker's static assets.
const staged = members.filter((member) => member.startsWith('packages/'));
const { differing } = compareArtifacts(repo, sha, saved, staged, [LOADER, ...dirs]);
if (differing.length === 0) {
  console.log(`remote-napi-binding: ${keys.join(', ')} and the loader rebuild ${sha.slice(0, 12)}'s staged files byte for byte (job ${r.jobId}; archive ${saved})`);
  process.exit(0);
}
for (const path of differing) console.log(`different ${path}`);
const refusal = writeRefusal(repo, sha, [...dirs, LOADER, GENERATED]);
if (refusal !== null) {
  console.log(`remote-napi-binding: ${differing.length} staged files differ; not written (${refusal}): they are in ${saved} (job ${r.jobId})`);
  process.exit(1);
}
for (const dir of [LOADER, ...dirs]) if (existsSync(join(repo, dir))) rmSync(join(repo, dir), { recursive: true, force: true });
extract(repo, saved, staged);
console.log(`remote-napi-binding: wrote ${dirs.join(', ')} and the loader (job ${r.jobId}; archive ${saved}). Commit them, then run scripts/ci/remote-build.mjs.`);
process.exit(1);
