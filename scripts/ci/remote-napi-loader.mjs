#!/usr/bin/env bun
// The napi-wasm loader of a commit, rebuilt on armada. A container runs
// packages/worker/scripts/napi-wasm/build.mjs --spec none (the loader and the
// wasi trampoline: emnapi fetched by lockfile integrity, its seams applied,
// bundled with the commit's loader and filesystem codec; no Rust toolchain),
// then stages it with the commit's committed bindings
// (scripts/bundle-napi-wasm.mjs). The staged loader and
// src/napi-wasm-artifacts.generated.ts come back, and the build's provenance
// is printed.
//
//   bun scripts/ci/remote-napi-loader.mjs [<commit>]
//
// Run it in the lane's worktree. <commit> defaults to HEAD; what is built is
// the commit, never the working tree. Exit 0: the build reproduces the
// commit's staged files byte for byte, and nothing is written. Exit 1: the
// build failed, or the staged files differ: they are written into the
// worktree when <commit> is its HEAD and none of them has local changes,
// else left in the saved archive, whose path is printed. Then commit them,
// and run scripts/ci/remote-build.mjs for the dist fixpoint. A stale binding
// is not this run's: the staging names the remote-napi-binding.mjs run that
// rebuilds it with the loader. Exit 2: not graded.
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
  console.error('usage: bun scripts/ci/remote-napi-loader.mjs [<commit>]');
  process.exit(2);
}
const repo = git(['rev-parse', '--show-toplevel']);
const sha = git(['rev-parse', `${argv[0] ?? 'HEAD'}^{commit}`]);
const STAGED = ['packages/worker/public/_assets/napi-wasm/loader', 'packages/worker/src/napi-wasm-artifacts.generated.ts'];
const script = String.raw`
{
  set -e
  W=$(mktemp -d)
  if ! bun packages/worker/scripts/napi-wasm/build.mjs --work "$W/work" --out "$W/out" --spec none > "$W/build.log" 2>&1; then
    echo BUILD-FAILED; tail -40 "$W/build.log"; exit 1
  fi
  # The committed bindings beside the new loader, as a full --out tree:
  # each build in its own <name>/<version>/, as build.mjs writes it.
  for d in packages/worker/public/_assets/napi-wasm/*/*/; do
    rel=$(printf '%s' "$d" | sed 's#^packages/worker/public/_assets/napi-wasm/##')
    case "$rel" in loader/*) continue ;; esac
    mkdir -p "$W/out/$rel"; cp "$d"* "$W/out/$rel"
  done
  (cd packages/worker && NIMBUS_NAPI_WASM_ARTIFACTS="$W/out" bun scripts/bundle-napi-wasm.mjs)
  echo ---PROVENANCE---
  cat "$W/out/napi-wasm/provenance.json"
  echo ${FILES_MARK}
  tar cf - ${STAGED.join(' ')} | xz -9 | base64 -w0
  echo
} > {out} 2>&1`;
const r = await mapOnArmada({ repo, sha, files: [], items: [1], label: `napi-wasm loader of ${sha.slice(0, 12)}`, timeout: 1800, command: ['bash', '-c', script] });
const { log: rest, archive } = splitArchive(r.outputs?.[0] ?? r.outcomes?.[0]?.tail ?? '');
const [log, provenance = ''] = rest.split('---PROVENANCE---');
console.log(log.trim());
if (r.outcomes?.[0]?.kind !== 'exited') {
  console.error(`remote-napi-loader: armada could not run the build (job ${r.jobId}, ${r.outcomes?.[0]?.kind} ${r.outcomes?.[0]?.exitCode}); not graded`);
  process.exit(2);
}
if (archive === null) {
  console.error(`remote-napi-loader: the build returned no files (exit ${r.outcomes[0].exitCode})`);
  process.exit(1);
}
console.log(provenance.trim());
const saved = `${keptAs('remote-napi-loader', sha.slice(0, 12))}.tar.xz`;
const members = keepArchive(saved, archive);
const { differing } = compareArtifacts(repo, sha, saved, members, [STAGED[0]]);
if (differing.length === 0) {
  console.log(`remote-napi-loader: the loader rebuilds ${sha.slice(0, 12)}'s staged files byte for byte (archive ${saved})`);
  process.exit(0);
}
for (const path of differing) console.log(`different ${path}`);
// STAGED is repository-relative, whatever directory this runs from.
const refusal = writeRefusal(repo, sha, STAGED);
if (refusal !== null) {
  console.log(`remote-napi-loader: the staged files are in ${saved}; ${refusal}, so nothing was written. Extract it at the repository root.`);
  process.exit(1);
}
const loaderDir = join(repo, STAGED[0]);
if (existsSync(loaderDir)) rmSync(loaderDir, { recursive: true, force: true });
extract(repo, saved, members);
console.log(`remote-napi-loader: wrote the staged loader and napi-wasm-artifacts.generated.ts (archive ${saved}). Review and commit them, then run scripts/ci/remote-build.mjs.`);
process.exit(1);
