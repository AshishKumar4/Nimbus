#!/usr/bin/env bun
// One napi-wasm binding of a commit, built on armada: a container runs
// packages/worker/scripts/napi-wasm/build.mjs --spec <name>@<version> (the
// tag archive by digest, the toolchain its rust-toolchain.toml pins, cargo
// --locked), then scripts/bundle-napi-wasm.mjs over it and the commit's
// other staged builds, and what that stages comes back: the binding's
// <name>.wasm and provenance.json, and src/napi-wasm-artifacts.generated.ts
// pinning its digest (the lockfile the build pruned from upstream's, when
// it did, stays in the saved archive). Supporting a new version of a
// binding is a spec line (scripts/napi-wasm/specs.mjs) and this run.
//
//   bun scripts/ci/remote-napi-binding.mjs <name>@<version> [<commit>]
//
// The build environment is armada's recipe plus rustup with the spec's
// toolchain and the wasm32-wasip1 target, written for the job: its key is
// that text, so each toolchain is an environment of its own, prepared once.
//
// Run it in the lane's worktree. <commit> defaults to HEAD; what is built is
// the commit, never the working tree. The files are written into the
// worktree only when <commit> is its HEAD and no staged artifact being
// replaced has a change of its own, staged
// or not (checked when the run returns, so an edit made during it counts);
// either way the archive is saved and its path printed. Then commit them,
// and run scripts/ci/remote-build.mjs for the dist fixpoint.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mapOnArmada } from './lib/armada.mjs';
import { extract, FILES_MARK, keepArchive, keptAs, splitArchive, writeRefusal } from './lib/remote-artifacts.mjs';

const git = (args) => {
  const done = spawnSync('git', args, { encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${(done.stderr || '').trim()}`);
  return done.stdout.trim();
};
const argv = process.argv.slice(2);
if (argv.length < 1 || argv.length > 2 || argv.some((arg) => arg.startsWith('--')) || !/^[\w-]+@\d[\w.+-]*$/.test(argv[0])) {
  console.error('usage: bun scripts/ci/remote-napi-binding.mjs <name>@<version> [<commit>]');
  process.exit(2);
}
const key = argv[0];
const [name, version] = key.split('@');
const repo = git(['rev-parse', '--show-toplevel']);
const sha = git(['rev-parse', `${argv[1] ?? 'HEAD'}^{commit}`]);
const { SPECS } = await import(join(repo, 'packages/worker/scripts/napi-wasm/specs.mjs'));
const spec = SPECS[key];
if (!spec) {
  console.error(`no spec ${key} in packages/worker/scripts/napi-wasm/specs.mjs (specs: ${Object.keys(SPECS).join(', ')})`);
  process.exit(2);
}

// As root, before the commit is checked out (armada's setup): rustup, system
// wide, with the one toolchain the spec pins.
const setup = {
  name: `rust-${spec.toolchain}.sh`,
  text: [
    '# The napi-wasm binding build\'s addition to setup.sh (scripts/ci/remote-napi-binding.mjs):',
    `# rustup at /opt/rustup and /opt/cargo, with rust ${spec.toolchain} and its wasm32-wasip1 target.`,
    'export RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo',
    'curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain none',
    `/opt/cargo/bin/rustup toolchain install ${spec.toolchain} --profile minimal --target wasm32-wasip1`,
    'chmod -R a+rX /opt/rustup /opt/cargo',
    '',
  ].join('\n'),
};
const dir = `packages/worker/public/_assets/napi-wasm/${name}/${version}`;
const script = String.raw`
{
  set -e
  export RUSTUP_HOME=/opt/rustup CARGO_HOME="$HOME/.cargo" PATH="/opt/cargo/bin:$PATH" NIMBUS_CARGO_JOBS=4
  W=$(mktemp -d)
  start=$(date +%s)
  if ! bun packages/worker/scripts/napi-wasm/build.mjs --work "$W/work" --out "$W/out" --spec ${key} > "$W/build.log" 2>&1; then
    echo BUILD-FAILED after $(( $(date +%s) - start )) s; tail -80 "$W/build.log"; exit 1
  fi
  echo "built in $(( $(date +%s) - start )) s"
  # Every other staged build as the commit has it, beside the new one: the
  # whole tree bundle-napi-wasm.mjs stages and pins.
  for d in packages/worker/public/_assets/napi-wasm/*/*/; do
    rel=$(printf '%s' "$d" | sed 's#^packages/worker/public/_assets/napi-wasm/##')
    case "$rel" in loader/*) continue ;; esac
    [ -d "$W/out/$rel" ] || { mkdir -p "$W/out/$rel"; cp "$d"* "$W/out/$rel"; }
  done
  (cd packages/worker && NIMBUS_NAPI_WASM_ARTIFACTS="$W/out" bun scripts/bundle-napi-wasm.mjs)
  echo ---PROVENANCE---
  cat "$W/out/${name}/${version}/provenance.json"
  echo ${FILES_MARK}
  tar cf - packages/worker/src/napi-wasm-artifacts.generated.ts packages/worker/public/_assets/napi-wasm/loader ${dir} -C "$W/out" ${name}/${version} | xz -9 | base64 -w0
  echo
} > {out} 2>&1`;
const r = await mapOnArmada({ repo, sha, files: [], setup, items: [1], label: `napi-wasm ${key} of ${sha.slice(0, 12)}`, timeout: 3600, command: ['bash', '-c', script] });
const { log: rest, archive } = splitArchive(r.outputs?.[0] ?? r.outcomes?.[0]?.tail ?? '');
const [log, provenance = ''] = rest.split('---PROVENANCE---');
console.log(log.trim());
if (r.outcomes?.[0]?.exitCode !== 0 || archive === null) {
  console.error(`remote-napi-binding: the build failed on armada (job ${r.jobId}, exit ${r.outcomes?.[0]?.exitCode})`);
  process.exit(1);
}
console.log(provenance.trim());
const saved = `${keptAs('remote-napi-binding', `${key}-${sha.slice(0, 12)}`)}.tar.xz`;
// What bundle-napi-wasm staged; the build's own out tree (its pruned
// lockfile) stays in the archive, out of the Worker's static assets.
const members = keepArchive(saved, archive).filter((member) => member.startsWith('packages/'));
const loader = 'packages/worker/public/_assets/napi-wasm/loader';
const refusal = writeRefusal(repo, sha, [dir, loader, 'packages/worker/src/napi-wasm-artifacts.generated.ts']);
if (refusal !== null) {
  console.log(`remote-napi-binding: saved ${saved} (job ${r.jobId}); not written: ${refusal}`);
  process.exit(0);
}
if (existsSync(join(repo, loader))) rmSync(join(repo, loader), { recursive: true, force: true });
extract(repo, saved, members);
console.log(`remote-napi-binding: wrote ${dir} (job ${r.jobId}; archive ${saved}). Commit it, then run scripts/ci/remote-build.mjs.`);
