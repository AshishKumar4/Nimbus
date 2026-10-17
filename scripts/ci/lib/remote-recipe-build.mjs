// A runtime built on armada by its one recipe (remote-python-build,
// remote-bash-build): the recipe runs in the commit's tree, then its verify
// drives the new artifacts through Nimbus; what comes back is each artifact
// and its digest, beside the commit's own. Artifacts that differ from the
// commit's are written into the worktree as remote-artifacts.mjs allows (else
// the archive is left for review). The verdict (build, verify, each
// artifact's digests, what was written) and the archive are kept under
// ~/.local/state/nimbus/<tool>/, named by time, commit and job.
//
// Exit: 0, built and verified, every artifact the commit's byte for byte;
// 1, the build or verify failed, or an artifact differs (written or left,
// for review); 2, not graded.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapOnArmada } from './armada.mjs';
import { compareArtifacts, extract, FILES_MARK, keepArchive, keptAs, splitArchive, writeRefusal } from './remote-artifacts.mjs';

/**
 * @typedef {object} Recipe
 * @property {string} tool The script's name, its state directory's.
 * @property {string} runtime What is built, as a job's label names it.
 * @property {string} dir The recipe's directory, repository-relative.
 * @property {string[]} outputs The artifacts the recipe leaves in `dir`; its provenance.json comes back with them.
 * @property {string} build Shell: builds into the work directory "$W".
 * @property {string} verify Shell: drives the built artifacts, in the commit's tree.
 * @property {string} summary An ERE of verify's lines to show when it passes.
 */

const git = (args) => {
  const done = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${(done.stderr || '').toString().trim()}`);
  return done.stdout;
};

/** Builds `recipe` for the commit `argv` names (HEAD by default), and exits with the verdict. */
export async function remoteRecipeBuild(recipe, argv) {
  const { tool } = recipe;
  if (argv.length > 1 || argv.some((arg) => arg.startsWith('--'))) {
    console.error(`usage: bun scripts/ci/${tool}.mjs [<commit>]`);
    process.exit(2);
  }
  /** Not graded: whatever went wrong before a verdict was in hand. */
  const notGraded = (why) => {
    console.error(`${tool}: NOT GRADED — ${why}`);
    process.exit(2);
  };
  const artifacts = recipe.outputs.map((file) => `${recipe.dir}/${file}`);
  const returned = [...artifacts, `${recipe.dir}/provenance.json`];

  // {out}'s first line is the task's verdict; then the log of what failed, or
  // verify's summary; then, built and verified, the artifacts.
  const script = String.raw`
{
  W=$(mktemp -d)
  start=$(date +%s)
  if ${recipe.build} > "$W/build.log" 2>&1; then build=ok; else build=failed; fi
  seconds=$(( $(date +%s) - start ))
  verify=skipped
  if [ $build = ok ]; then
    if ${recipe.verify} > "$W/verify.log" 2>&1; then verify=ok; else verify=failed; fi
  fi
  printf '{"build":"%s","seconds":%d,"verify":"%s"}\n' $build $seconds $verify
  # The first errors, which a parallel or tolerant make leaves far above the tail.
  if [ $build != ok ]; then grep -n -m 12 -B 3 -A 2 -E 'error:|Error [0-9]' "$W/build.log"; echo ...; tail -40 "$W/build.log"
  elif [ $verify != ok ]; then tail -80 "$W/verify.log"
  else
    grep -E '${recipe.summary}' "$W/verify.log"
    echo ${FILES_MARK}
    tar cf - ${returned.join(' ')} | xz -6 | base64 -w0
    echo
  fi
} > {out} 2>&1`;

  let repo;
  let sha;
  let run;
  try {
    repo = git(['rev-parse', '--show-toplevel']).trim();
    sha = git(['rev-parse', '--verify', `${argv[0] ?? 'HEAD'}^{commit}`]).trim();
    run = await mapOnArmada({ repo, sha, files: [], items: [1], label: `${recipe.runtime} of ${sha.slice(0, 12)}`, timeout: 3600, command: ['bash', '-c', script] });
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
    ({ artifacts: verdict.artifacts, differing } = compareArtifacts(repo, sha, verdict.archive, returned));
  } catch (error) {
    notGraded(`the artifacts that came back cannot be read (job ${run.jobId}): ${error.message}`);
  }
  for (const path of returned) {
    const { built, committed } = verdict.artifacts[path];
    console.log(`${built === committed ? 'same     ' : 'different'} ${path} ${built}${built === committed ? '' : ` (the commit's: ${committed ?? 'none'})`}`);
  }
  if (differing.length === 0) finish(0, `built in ${task.seconds} s and verified; the recipe reproduces ${sha.slice(0, 12)}'s artifacts byte for byte`);
  verdict.refusal = writeRefusal(repo, sha, differing);
  if (verdict.refusal !== null) finish(1, `${differing.length} artifacts differ; not written (${verdict.refusal}): they are in ${verdict.archive}`);
  extract(repo, verdict.archive, differing);
  verdict.written = differing;
  const payloadChanged = artifacts.some(path => differing.includes(path));
  finish(1, `wrote ${differing.join(', ')}: review and commit ${payloadChanged ? "them with the runtime's new version (runtime-specs.mjs)" : 'the provenance; the runtime bytes are unchanged'}`);
}
