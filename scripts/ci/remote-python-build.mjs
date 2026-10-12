#!/usr/bin/env bun
// CPython for WASI (packages/worker/wasm/python) of a commit, built on armada
// by its one recipe: build-in-bwrap.sh, which runs build-python.sh with the
// tree at /src/python, wasi-sdk 25.0 (pinned by digest) at /wasi-sdk and a
// cleared environment, so the bytes are the same wherever it runs. armada's
// image has bubblewrap, and its containers unprivileged user namespaces.
// Then build-python.sh verify drives the new artifacts through the Nimbus
// WASI host. What comes back: each artifact and its digest, beside the
// commit's own.
//
//   bun scripts/ci/remote-python-build.mjs [<commit>]
//
// Run it in the lane's worktree. <commit> defaults to HEAD; what is built is
// the commit, never the working tree. The artifacts are written into the
// worktree only when <commit> is its HEAD and none of them has a change of
// its own, staged or not (checked when the run returns); either way the
// archive is saved and its path printed. A run whose artifacts equal the
// commit's writes nothing: that is the recipe reproducing them.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NIMBUS_STATE } from './lib/state-dir.mjs';
import { mapOnArmada } from './lib/armada.mjs';

const DIR = 'packages/worker/wasm/python';
/** What the recipe leaves next to build-python.sh (its "Outputs"). */
const ARTIFACTS = ['python.wasm', 'python-sci.wasm', 'python313.zip', 'sci-packages.zip'];

const git = (args) => {
  const done = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${(done.stderr || '').trim()}`);
  return done.stdout.trim();
};
const argv = process.argv.slice(2);
if (argv.length > 1 || argv.some((arg) => arg.startsWith('--'))) {
  console.error('usage: bun scripts/ci/remote-python-build.mjs [<commit>]');
  process.exit(2);
}
const repo = git(['rev-parse', '--show-toplevel']);
const sha = git(['rev-parse', `${argv[0] ?? 'HEAD'}^{commit}`]);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const committed = (file) => {
  const done = spawnSync('git', ['-C', repo, 'show', `${sha}:${DIR}/${file}`], { maxBuffer: 256 * 1024 * 1024 });
  return done.status === 0 ? digest(done.stdout) : null;
};

const script = String.raw`
{
  set -e
  W=$(mktemp -d)
  start=$(date +%s)
  if ! ${DIR}/build-in-bwrap.sh "$W" > "$W/build.log" 2>&1; then
    echo BUILD-FAILED after $(( $(date +%s) - start )) s; tail -80 "$W/build.log"; exit 1
  fi
  echo "built in $(( $(date +%s) - start )) s"
  if ! ${DIR}/build-python.sh verify > "$W/verify.log" 2>&1; then
    echo VERIFY-FAILED; tail -80 "$W/verify.log"; exit 1
  fi
  grep -E 'import namespaces|inittab|all cases passed' "$W/verify.log" || true
  echo ---FILES---
  tar cf - -C ${DIR} ${ARTIFACTS.join(' ')} | xz -6 | base64 -w0
  echo
} > {out} 2>&1`;
const r = await mapOnArmada({ repo, sha, files: [], items: [1], label: `cpython-wasi of ${sha.slice(0, 12)}`, timeout: 3600, command: ['bash', '-c', script] });
const text = r.outputs?.[0] ?? r.outcomes?.[0]?.tail ?? '';
const [log, files = ''] = text.split('---FILES---');
console.log(log.trim());
if (r.outcomes?.[0]?.exitCode !== 0 || !files.trim()) {
  console.error(`remote-python-build: the build failed on armada (job ${r.jobId}, exit ${r.outcomes?.[0]?.exitCode})`);
  process.exit(1);
}
const saveDir = join(NIMBUS_STATE, 'remote-python-build');
mkdirSync(saveDir, { recursive: true });
const saved = join(saveDir, `${new Date().toISOString().replace(/[-:.]/g, '')}-${sha.slice(0, 12)}.tar.xz`);
writeFileSync(saved, Buffer.from(files.trim(), 'base64'));
const unpacked = mkdtempSync(join(tmpdir(), 'remote-python-build-'));
process.once('exit', () => rmSync(unpacked, { recursive: true, force: true }));
const untar = spawnSync('tar', ['xJf', saved, '-C', unpacked], { encoding: 'utf8' });
if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);
const built = Object.fromEntries(ARTIFACTS.map((file) => [file, digest(readFileSync(join(unpacked, file)))]));
for (const file of ARTIFACTS) {
  const was = committed(file);
  console.log(`${built[file] === was ? 'same     ' : 'different'} ${file} ${built[file]}${built[file] === was ? '' : ` (the commit's: ${was ?? 'none'})`}`);
}
const differing = ARTIFACTS.filter((file) => built[file] !== committed(file));
if (differing.length === 0) {
  console.log(`remote-python-build: the recipe reproduces ${sha.slice(0, 12)}'s artifacts byte for byte (job ${r.jobId}; archive ${saved})`);
  process.exit(0);
}
const head = git(['-C', repo, 'rev-parse', 'HEAD']);
const changed = differing.filter((file) => git(['-C', repo, 'status', '--porcelain', '--', `${DIR}/${file}`]) !== '');
const refusal = head !== sha ? `${sha.slice(0, 12)} is not this worktree's HEAD`
  : changed.length > 0 ? `these have changes of their own: ${changed.join(', ')}`
    : null;
if (refusal !== null) {
  console.log(`remote-python-build: saved ${saved} (job ${r.jobId}); not written: ${refusal}`);
  process.exit(0);
}
for (const file of differing) writeFileSync(join(repo, DIR, file), readFileSync(join(unpacked, file)));
console.log(`remote-python-build: wrote ${differing.join(', ')} (job ${r.jobId}; archive ${saved}). Commit them with the runtime's new version (runtime-specs.mjs).`);
