#!/usr/bin/env bun
// One napi-wasm binding of a commit, built on armada: a container runs
// packages/worker/scripts/napi-wasm/build.mjs --spec <name>@<version> (the
// tag archive by digest, the toolchain its rust-toolchain.toml pins, cargo
// --locked) and the binding's directory comes back: <name>.wasm,
// provenance.json, and the lockfile when the build pruned it from
// upstream's. Supporting a new version of a binding is a spec line
// (scripts/napi-wasm/specs.mjs) and this run.
//
//   bun scripts/ci/remote-napi-binding.mjs <name>@<version> [<commit>]
//
// The build environment is armada's recipe plus rustup with the spec's
// toolchain and the wasm32-wasip1 target, written for the job: its key is
// that text, so each toolchain is an environment of its own, prepared once.
//
// Run it in the lane's worktree. <commit> defaults to HEAD; what is built is
// the commit, never the working tree. The binding is written under
// packages/worker/public/_assets/napi-wasm/<name>/<version>/ only when
// <commit> is the worktree's HEAD and that directory does not exist yet;
// either way the archive is saved and its path printed. Then commit it, and
// run scripts/ci/remote-build.mjs, whose bundle step stages it
// (scripts/bundle-napi-wasm.mjs) and pins its digest.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mapOnArmada } from './lib/armada.mjs';

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
  echo ---PROVENANCE---
  cat "$W/out/${name}/${version}/provenance.json"
  echo ---FILES---
  tar cf - -C "$W/out" ${name}/${version} | xz -9 | base64 -w0
  echo
} > {out} 2>&1`;
const r = await mapOnArmada({ repo, sha, files: [], setup, items: [1], label: `napi-wasm ${key} of ${sha.slice(0, 12)}`, timeout: 3600, command: ['bash', '-c', script] });
const text = r.outputs?.[0] ?? r.outcomes?.[0]?.tail ?? '';
const [log, rest = ''] = text.split('---PROVENANCE---');
const [provenance, files = ''] = rest.split('---FILES---');
console.log(log.trim());
if (r.outcomes?.[0]?.exitCode !== 0 || !files.trim()) {
  console.error(`remote-napi-binding: the build failed on armada (job ${r.jobId}, exit ${r.outcomes?.[0]?.exitCode})`);
  process.exit(1);
}
console.log(provenance.trim());
const archive = Buffer.from(files.trim(), 'base64');
const saveDir = join(homedir(), '.local/state/nimbus/remote-napi-binding');
mkdirSync(saveDir, { recursive: true });
const saved = join(saveDir, `${new Date().toISOString().replace(/[-:.]/g, '')}-${key}-${sha.slice(0, 12)}.tar.xz`);
writeFileSync(saved, archive);
const head = git(['rev-parse', 'HEAD']);
if (head !== sha || existsSync(join(repo, dir))) {
  console.log(`remote-napi-binding: saved ${saved} (job ${r.jobId}); not written: ${head !== sha ? `${sha.slice(0, 12)} is not this worktree's HEAD` : `${dir} exists`}`);
  process.exit(0);
}
// The binding and its provenance are staged; a pruned lockfile stays in the
// archive (provenance pins its digest), out of the Worker's static assets.
mkdirSync(join(repo, dir), { recursive: true });
const members = [`${name}/${version}/${name}.wasm`, `${name}/${version}/provenance.json`];
const unpacked = spawnSync('tar', ['xJf', saved, '-C', join(repo, 'packages/worker/public/_assets/napi-wasm'), ...members], { encoding: 'utf8' });
if (unpacked.status !== 0) throw new Error(`tar failed: ${unpacked.stderr}`);
console.log(`remote-napi-binding: wrote ${dir} (job ${r.jobId}; archive ${saved}). Commit it, then run scripts/ci/remote-build.mjs.`);
