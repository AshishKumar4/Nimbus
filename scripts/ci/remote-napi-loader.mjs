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
// the commit, never the working tree. The files are written into the worktree
// only when <commit> is its HEAD and none of them has local changes;
// otherwise the archive is saved and its path printed. Then commit them, and
// run scripts/ci/remote-build.mjs for the dist fixpoint.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mapOnArmada } from './lib/armada.mjs';

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
  # The committed bindings beside the new loader, as a full --out tree.
  for d in packages/worker/public/_assets/napi-wasm/*/; do
    name=$(basename "$d"); [ "$name" = loader ] && continue
    mkdir -p "$W/out/$name"; cp "$d"/*/* "$W/out/$name/"
  done
  (cd packages/worker && NIMBUS_NAPI_WASM_ARTIFACTS="$W/out" bun scripts/bundle-napi-wasm.mjs)
  echo ---PROVENANCE---
  cat "$W/out/napi-wasm/provenance.json"
  echo ---FILES---
  tar cf - ${STAGED.join(' ')} | xz -9 | base64 -w0
  echo
} > {out} 2>&1`;
const r = await mapOnArmada({ repo, sha, files: [], items: [1], label: `napi-wasm loader of ${sha.slice(0, 12)}`, timeout: 1800, command: ['bash', '-c', script] });
const text = r.outputs?.[0] ?? r.outcomes?.[0]?.tail ?? '';
const [log, rest = ''] = text.split('---PROVENANCE---');
const [provenance, files = ''] = rest.split('---FILES---');
console.log(log.trim());
if (!files.trim()) {
  console.error(`remote-napi-loader: the build returned no files (outcome ${r.outcomes?.[0]?.kind} ${r.outcomes?.[0]?.exitCode})`);
  process.exit(1);
}
console.log(provenance.trim());
const dir = join(homedir(), '.local', 'state', 'nimbus', 'remote-napi-loader');
mkdirSync(dir, { recursive: true });
const archive = join(dir, `${new Date().toISOString().replace(/[:.]/g, '')}-${sha.slice(0, 12)}.tar.xz`);
writeFileSync(archive, Buffer.from(files.trim(), 'base64'));
const local = git(['status', '--porcelain', '--untracked-files=all', '--', ...STAGED]);
if (git(['rev-parse', 'HEAD']) !== sha || local) {
  console.log(`remote-napi-loader: the staged files are in ${archive}; ${local ? 'files they replace have local changes' : `${sha.slice(0, 12)} is not HEAD`}, so nothing was written. Extract it at the repository root.`);
  process.exit(1);
}
const loaderDir = join(repo, STAGED[0]);
if (existsSync(loaderDir)) rmSync(loaderDir, { recursive: true, force: true });
const untar = spawnSync('tar', ['xJf', archive, '-C', repo], { encoding: 'utf8' });
if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);
console.log(`remote-napi-loader: wrote the staged loader and napi-wasm-artifacts.generated.ts (archive ${archive}). Review and commit them, then run scripts/ci/remote-build.mjs.`);
