#!/usr/bin/env bun
// A plain WASI command's image (wasi-cli-runner@1: jq, make) and the files
// its spec ships beside it, built on armada by its one recipe,
// packages/worker/wasm/<name>/build-<name>.sh, with the pinned wasi-sdk 27.0
// and the upstream source its spec pins (runtime-specs.mjs `source`), then
// checked by the recipe's verify (its import surface). The shared artifact protocol writes only
// into a clean HEAD's unchanged artifact paths.
//
//   bun scripts/ci/remote-wasi-cli-build.mjs <name> [<commit>]
//
// Exit: 0, built and verified, byte-identical; 1, build/verify failed or
// differing artifacts written or saved; 2, not graded.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mapOnArmada } from './lib/armada.mjs';
import { compareArtifacts, extract, FILES_MARK, keepArchive, keptAs, splitArchive, writeRefusal } from './lib/remote-artifacts.mjs';

const SDK_URL = 'https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-27/wasi-sdk-27.0-x86_64-linux.tar.gz';
const SDK_SHA256 = 'b7d4d944c88503e4f21d84af07ac293e3440b1b6210bfd7fe78e0afd92c23bc2';

const git = (args) => {
  const done = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${(done.stderr || '').toString().trim()}`);
  return done.stdout;
};

/** What each recipe leaves beside itself: the files its spec ships (runtime-specs.mjs `files`). */
const OUTPUTS = {
  jq: ['jq.wasm', 'COPYING', 'COPYING.oniguruma'],
  make: ['make.wasm', 'COPYING'],
};

const argv = process.argv.slice(2);
const [name, commit] = argv;
if (name === undefined || !Object.hasOwn(OUTPUTS, name) || argv.length > 2 || argv.some((arg) => arg.startsWith('--'))) {
  console.error(`usage: bun scripts/ci/remote-wasi-cli-build.mjs <${Object.keys(OUTPUTS).join('|')}> [<commit>]`);
  process.exit(2);
}
const DIR = `packages/worker/wasm/${name}`;
const ARTIFACTS = OUTPUTS[name].map((file) => `${DIR}/${file}`);
const tool = `remote-${name}-build`;
const notGraded = (why) => {
  console.error(`${tool}: NOT GRADED — ${why}`);
  process.exit(2);
};

const script = String.raw`
{
  W=$(mktemp -d)
  start=$(date +%s)
  if bash -euo pipefail -c '
    W=$1
    curl -fsSL ${SDK_URL} -o "$W/wasi-sdk.tgz"
    echo "${SDK_SHA256}  $W/wasi-sdk.tgz" | sha256sum -c --quiet
    tar xzf "$W/wasi-sdk.tgz" -C "$W"
    WASI_SDK="$W/wasi-sdk-27.0-x86_64-linux" BUILD="$W/build" ${DIR}/build-${name}.sh
  ' ${name}-build "$W" > "$W/build.log" 2>&1; then build=ok; else build=failed; fi
  seconds=$(( $(date +%s) - start ))
  verify=skipped
  if [ $build = ok ]; then
    if ${DIR}/build-${name}.sh verify > "$W/verify.log" 2>&1; then verify=ok; else verify=failed; fi
  fi
  printf '{"build":"%s","seconds":%d,"verify":"%s"}\n' $build $seconds $verify
  if [ $build != ok ]; then tail -80 "$W/build.log"
  elif [ $verify != ok ]; then tail -80 "$W/verify.log"
  else
    cat "$W/verify.log"
    echo ${FILES_MARK}
    tar cf - ${ARTIFACTS.join(' ')} | xz -6 | base64 -w0
    echo
  fi
} > {out} 2>&1`;

let repo;
let sha;
let run;
try {
  repo = git(['rev-parse', '--show-toplevel']).trim();
  sha = git(['rev-parse', '--verify', `${commit ?? 'HEAD'}^{commit}`]).trim();
  run = await mapOnArmada({ repo, sha, files: [], items: [1], label: `${name}-wasi of ${sha.slice(0, 12)}`, timeout: 3600, command: ['bash', '-c', script] });
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

const stem = keptAs(tool, `${sha.slice(0, 12)}-${run.jobId}`);
const verdict = { commit: sha, job: run.jobId, ...task, artifacts: null, archive: null, written: [], refusal: null };
const finish = (status, line) => {
  writeFileSync(`${stem}.json`, `${JSON.stringify(verdict, null, 2)}\n`);
  console.log(`${tool}: ${line}; verdict ${stem}.json (job ${run.jobId})`);
  process.exit(status);
};
if (task.build !== 'ok') finish(1, `the build failed after ${task.seconds} s`);
if (task.verify !== 'ok') finish(1, `built in ${task.seconds} s, and verify failed`);
if (archive === null) notGraded(`built and verified, but no artifacts came back (job ${run.jobId})`);

verdict.archive = `${stem}.tar.xz`;
let differing;
try {
  keepArchive(verdict.archive, archive);
  ({ artifacts: verdict.artifacts, differing } = compareArtifacts(repo, sha, verdict.archive, ARTIFACTS));
} catch (error) {
  notGraded(`the artifacts that came back cannot be read (job ${run.jobId}): ${error.message}`);
}
for (const path of ARTIFACTS) {
  const { built, committed } = verdict.artifacts[path];
  console.log(`${built === committed ? 'same     ' : 'different'} ${path} ${built}${built === committed ? '' : ` (the commit's: ${committed ?? 'none'})`}`);
}
if (differing.length === 0) finish(0, `built in ${task.seconds} s and verified; the recipe reproduces ${sha.slice(0, 12)} byte for byte`);
verdict.refusal = writeRefusal(repo, sha, differing);
if (verdict.refusal !== null) finish(1, `${differing.length} artifacts differ; not written (${verdict.refusal}): they are in ${verdict.archive}`);
extract(repo, verdict.archive, differing);
verdict.written = differing;
finish(1, `wrote ${differing.join(', ')}: review and commit the rebuilt artifacts with the runtime's pinned digests (runtime-specs.mjs)`);
