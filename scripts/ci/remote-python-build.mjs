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
// the commit, never the working tree. Artifacts that differ from the
// commit's are written into the worktree as lib/remote-artifacts.mjs allows
// (else the archive is left for you). The verdict (build, verify, each
// artifact's digests, what was written) and the archive are kept under
// ~/.local/state/nimbus/remote-python-build/, named by time, commit and job.
//
// Exit: 0, built and verified, every artifact the commit's byte for byte;
// 1, the build or verify failed, or an artifact differs (written or left,
// for review); 2, not graded.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapOnArmada } from './lib/armada.mjs';
import { extract, FILES_MARK, keepArchive, keptAs, splitArchive, writeRefusal } from './lib/remote-artifacts.mjs';
import { PYTHON_OUTPUTS } from '../../packages/worker/wasm/python/inputs.mjs';

const DIR = 'packages/worker/wasm/python';
/** What the recipe leaves next to build-python.sh (its "Outputs"). */
const ARTIFACTS = PYTHON_OUTPUTS.map((file) => `${DIR}/${file}`);
const RETURNED = [...ARTIFACTS, `${DIR}/provenance.json`];

const git = (args, options = {}) => {
  const done = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${(done.stderr || '').toString().trim()}`);
  return done.stdout;
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

const argv = process.argv.slice(2);
if (argv.length > 1 || argv.some((arg) => arg.startsWith('--'))) {
  console.error('usage: bun scripts/ci/remote-python-build.mjs [<commit>]');
  process.exit(2);
}

/** Not graded: whatever went wrong before a verdict was in hand. */
const notGraded = (why) => {
  console.error(`remote-python-build: NOT GRADED — ${why}`);
  process.exit(2);
};

// {out}'s first line is the task's verdict; then the log of what failed, or
// verify's verdicts; then, built and verified, the artifacts.
const script = String.raw`
{
  W=$(mktemp -d)
  start=$(date +%s)
  if ${DIR}/build-in-bwrap.sh "$W" > "$W/build.log" 2>&1; then build=ok; else build=failed; fi
  seconds=$(( $(date +%s) - start ))
  verify=skipped
  if [ $build = ok ]; then
    if ${DIR}/build-python.sh verify > "$W/verify.log" 2>&1; then verify=ok; else verify=failed; fi
  fi
  printf '{"build":"%s","seconds":%d,"verify":"%s"}\n' $build $seconds $verify
  if [ $build != ok ]; then tail -80 "$W/build.log"
  elif [ $verify != ok ]; then tail -80 "$W/verify.log"
  else
    grep -E 'import namespaces|inittab|all cases passed' "$W/verify.log"
    echo ${FILES_MARK}
    tar cf - ${RETURNED.join(' ')} | xz -6 | base64 -w0
    echo
  fi
} > {out} 2>&1`;

let repo;
let sha;
let run;
try {
  repo = git(['rev-parse', '--show-toplevel']).trim();
  sha = git(['rev-parse', '--verify', `${argv[0] ?? 'HEAD'}^{commit}`]).trim();
  run = await mapOnArmada({ repo, sha, files: [], items: [1], label: `cpython-wasi of ${sha.slice(0, 12)}`, timeout: 3600, command: ['bash', '-c', script] });
} catch (error) {
  notGraded(error.message);
}
const [outcome] = run.outcomes;
if (outcome?.kind !== 'exited') notGraded(`armada could not run the build (job ${run.jobId}, ${outcome?.kind} ${outcome?.exitCode}):\n${outcome?.tail ?? 'no outcome'}`);
if (run.outputs[0] === null) notGraded(`the build wrote nothing (job ${run.jobId})`);
const { log, archive } = splitArchive(run.outputs[0]);
const [first, ...rest] = log.split('\n');
let task;
try {
  task = JSON.parse(first);
} catch {
  notGraded(`the build wrote no verdict (job ${run.jobId}):\n${log.slice(-4000)}`);
}
console.log(rest.join('\n').trim());

const stem = keptAs('remote-python-build', `${sha.slice(0, 12)}-${run.jobId}`);
const verdict = { commit: sha, job: run.jobId, ...task, artifacts: null, archive: null, written: [], refusal: null };
const finish = (status, line) => {
  writeFileSync(`${stem}.json`, `${JSON.stringify(verdict, null, 2)}\n`);
  console.log(`remote-python-build: ${line}; verdict ${stem}.json (job ${run.jobId})`);
  process.exit(status);
};
if (task.build !== 'ok') finish(1, `the build failed after ${task.seconds} s`);
if (task.verify !== 'ok') finish(1, `built in ${task.seconds} s, and verify failed`);
if (archive === null) notGraded(`built and verified, but no artifacts came back (job ${run.jobId})`);

verdict.archive = `${stem}.tar.xz`;
const unpacked = mkdtempSync(join(tmpdir(), 'remote-python-build-'));
try {
  keepArchive(verdict.archive, archive);
  extract(unpacked, verdict.archive, RETURNED);
  verdict.artifacts = Object.fromEntries(RETURNED.map((path) => {
    const shown = spawnSync('git', ['-C', repo, 'show', `${sha}:${path}`], { maxBuffer: 256 * 1024 * 1024 });
    return [path, { built: digest(readFileSync(join(unpacked, path))), committed: shown.status === 0 ? digest(shown.stdout) : null }];
  }));
} catch (error) {
  notGraded(`the artifacts that came back cannot be read (job ${run.jobId}): ${error.message}`);
} finally {
  rmSync(unpacked, { recursive: true, force: true });
}
const differing = RETURNED.filter((path) => verdict.artifacts[path].built !== verdict.artifacts[path].committed);
for (const path of RETURNED) {
  const { built, committed } = verdict.artifacts[path];
  console.log(`${built === committed ? 'same     ' : 'different'} ${path} ${built}${built === committed ? '' : ` (the commit's: ${committed ?? 'none'})`}`);
}
if (differing.length === 0) finish(0, `built in ${task.seconds} s and verified; the recipe reproduces ${sha.slice(0, 12)}'s artifacts byte for byte`);
verdict.refusal = writeRefusal(repo, sha, differing);
if (verdict.refusal !== null) finish(1, `${differing.length} artifacts differ; not written (${verdict.refusal}): they are in ${verdict.archive}`);
extract(repo, verdict.archive, differing);
verdict.written = differing;
const payloadChanged = ARTIFACTS.some(path => differing.includes(path));
finish(1, `wrote ${differing.join(', ')}: review and commit ${payloadChanged ? "them with the runtime's new version (runtime-specs.mjs)" : 'the provenance; the runtime bytes are unchanged'}`);
