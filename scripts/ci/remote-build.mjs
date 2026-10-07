#!/usr/bin/env bun
// The build of a commit on armada instead of this machine. A container runs
// scripts/ci/build.mjs (the dist fixpoint, then the typecheck); the result
// lands here: typecheck errors are printed, and the dist patch is applied to
// the worktree for you to commit.
//
//   bun scripts/ci/remote-build.mjs [<commit>] [--no-cache]
//
// Run it in the lane's worktree. <commit> defaults to HEAD; what is built is
// the commit, never the working tree, so commit first. The container gets a
// throwaway commit object on no branch: <commit>'s tree with this checkout's
// armada recipe (.armada.json, scripts/armada/) and scripts/ci/build.mjs laid
// over it, so a lane branched before those existed builds the same way.
//
// If <commit> is the worktree's HEAD, the patch is applied with `git apply`,
// which refuses (and changes nothing) when a file it touches has local
// changes. Otherwise it is saved and the command to apply it printed. The
// verdict and patch are kept under ~/.local/state/nimbus/remote-builds/.
//
// Exit: 0, dist is the fixpoint and the typecheck is clean; 1, a patch was
// applied or saved, or the typecheck or the gate failed; 2, not graded.
// armada is the CLI and SDK in ARMADA_DIR (default /mnt/local/armada), on the
// connection in ~/.config/armada/connection.json (or ARMADA_URL and
// ARMADA_TOKEN).
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** What the container needs that the commit may lack, from this checkout. */
export const OVERLAY = ['.armada.json', 'scripts/armada/setup.sh', 'scripts/armada/install.sh', 'scripts/ci/build.mjs'];

const git = (cwd, args, options = {}) => {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30, ...options });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${(done.stderr || done.error?.message || '').trim()}`);
  return done.stdout.trim();
};

/**
 * A commit object, on no branch, whose tree is `sha`'s with each `files`
 * path replaced by the bytes and executable bit it has under `from`. Its
 * parent is `sha`, and its identity and dates are fixed by `sha`, so the
 * same inputs give the same commit.
 */
export function overlayCommit(repo, sha, files = OVERLAY, from = SELF_ROOT) {
  const scratch = mkdtempSync(join(tmpdir(), 'remote-build-index-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
    git(repo, ['read-tree', sha], { env });
    for (const path of files) {
      const blob = git(repo, ['hash-object', '-w', '--stdin'], { input: readFileSync(join(from, path)) });
      const mode = statSync(join(from, path)).mode & 0o100 ? '100755' : '100644';
      git(repo, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`], { env });
    }
    const tree = git(repo, ['write-tree'], { env });
    const date = git(repo, ['show', '-s', '--format=%cI', sha]);
    return git(repo, ['commit-tree', tree, '-p', sha, '-m', `remote build of ${sha}`], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Nimbus remote build', GIT_AUTHOR_EMAIL: 'remote-build@nimbus.invalid', GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: 'Nimbus remote build', GIT_COMMITTER_EMAIL: 'remote-build@nimbus.invalid', GIT_COMMITTER_DATE: date,
      },
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Run build.mjs on armada for `commit`; resolves to its verdict, or throws saying why it was not graded. */
async function buildOnArmada(repo, commit, args) {
  const armadaDir = process.env.ARMADA_DIR || '/mnt/local/armada';
  const { connect } = await import(join(armadaDir, 'src', 'sdk.ts'));
  const armada = connect();
  const cli = spawn('bun', [join(armadaDir, 'src', 'cli.ts'), 'map', `--commit=${commit}`, '--times=1', '--output', '--json',
    `--label=remote-build ${commit.slice(0, 12)}`, '--', 'bun', 'scripts/ci/build.mjs', '--out', '{out}', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  let jobId = null;
  let stdout = '';
  let stderr = '';
  let phase = '';
  const watcher = setInterval(() => {
    if (jobId === null) return;
    armada.job(jobId).status().then((status) => {
      if (status.phase === phase) return;
      phase = status.phase;
      console.error(`remote-build: ${phase === 'preparing' ? `preparing environment ${status.key.slice(0, 12)} (minutes, once per lockfile)` : phase}`);
    }, () => {});
  }, 5_000);
  const cancel = () => {
    if (jobId !== null) armada.job(jobId).cancel().finally(() => process.exit(130));
    else process.exit(130);
    cli.kill('SIGTERM');
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  cli.stdout.on('data', (chunk) => { stdout += chunk; });
  cli.stderr.on('data', (chunk) => {
    stderr += chunk;
    jobId ??= /^job (\S+)$/m.exec(stderr)?.[1] ?? null;
  });
  const code = await new Promise((resolve) => cli.on('close', resolve));
  clearInterval(watcher);
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
  const outcome = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).at(-1);
  if (jobId === null || outcome === undefined) throw new Error(`armada map exited ${code} without an outcome:\n${stderr.slice(-3000)}`);
  if (outcome.kind === 'failed') throw new Error(`armada could not run the build (job ${jobId}):\n${outcome.tail}`);
  const text = await armada.job(jobId).output(0);
  if (text === null) throw new Error(`the build wrote no verdict (job ${jobId}, exit ${outcome.exitCode}):\n${outcome.tail}`);
  return { jobId, verdict: JSON.parse(text) };
}

/** The last `lines` lines of `text`. */
const lastLines = (text, lines) => text.split('\n').slice(-lines).join('\n');

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const args = argv.filter((arg) => arg === '--no-cache');
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  if (positional.length > 1 || argv.length !== args.length + positional.length) {
    console.error('usage: bun scripts/ci/remote-build.mjs [<commit>] [--no-cache]');
    process.exit(2);
  }
  const repo = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  const sha = git(repo, ['rev-parse', '--verify', `${positional[0] ?? 'HEAD'}^{commit}`]);
  let built;
  try {
    const throwaway = overlayCommit(repo, sha);
    console.error(`remote-build: ${sha.slice(0, 12)} as ${throwaway.slice(0, 12)} (its tree plus ${OVERLAY.join(', ')})`);
    built = await buildOnArmada(repo, throwaway, args);
  } catch (error) {
    console.error(`remote-build: NOT GRADED — ${error.message}`);
    process.exit(2);
  }
  const { jobId, verdict } = built;
  const state = join(homedir(), '.local', 'state', 'nimbus', 'remote-builds');
  mkdirSync(state, { recursive: true });
  const stem = join(state, `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${sha.slice(0, 12)}`);
  writeFileSync(`${stem}.json`, `${JSON.stringify({ commit: sha, job: jobId, ...verdict }, null, 2)}\n`);

  for (const row of verdict.rows) {
    console.log(`${row.exitCode === 0 ? 'ok  ' : 'FAIL'} ${row.name} (exit ${row.exitCode}, ${Math.round(row.seconds)} s)`);
    if (row.exitCode !== 0) console.log(`${lastLines(row.output.trimEnd(), 120)}\n`);
  }
  let status = verdict.rows.every((row) => row.exitCode === 0) && verdict.patch === null ? 0 : 1;
  if (verdict.rows.some((row) => row.name === 'checkout')) status = 2;
  if (verdict.patch !== null) {
    writeFileSync(`${stem}.patch`, verdict.patch);
    const files = verdict.patch.match(/^diff --git /gm)?.length ?? 0;
    const atHead = git(repo, ['rev-parse', 'HEAD']) === sha;
    const applied = atHead && spawnSync('git', ['apply', `${stem}.patch`], { cwd: repo, stdio: 'inherit' }).status === 0;
    console.log(applied
      ? `remote-build: applied the dist patch (${files} files) to ${repo}. Review it and commit it, then run ci-run on that commit.`
      : `remote-build: the dist patch (${files} files) is ${stem}.patch; ${atHead ? 'it did not apply here' : `${sha.slice(0, 12)} is not this worktree's HEAD`}. `
        + `Apply it on ${sha.slice(0, 12)} with \`git apply ${stem}.patch\`, then commit it.`);
  }
  console.log(`remote-build: ${status === 0 ? 'dist is the fixpoint of src and the typecheck is clean' : 'see above'}; verdict ${stem}.json (job ${jobId})`);
  process.exit(status);
}
