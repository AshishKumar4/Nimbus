#!/usr/bin/env bun
// The behavioral suite against a deployed target, from containers on armada
// instead of this machine: each part runs scripts/ci/probes.mjs in a
// container of its own, with Chromium for the browser probes.
//
//   bun scripts/ci/remote-probes.mjs --target staging|throwaway:<name> [<commit>]
//       [--only a,b] [--skip c,d] [--parts N] [--jobs J] [--repeat a,b --times T] [--baseline <commit>]
//   bun scripts/ci/remote-probes.mjs --deploy <name> [<commit>] [--only a,b] [--skip c,d] [--parts N] [--jobs J] [--baseline <commit>]
//   bun scripts/ci/remote-probes.mjs --target hosted:<https origin> [<commit>] --only a,b
//       [--screenshots <local-dir>]
//
// --target hosted:<origin> runs the named hosted-demo checks against a
// deployed demo (staging's, or production's at promotion) as a visitor
// reaches it: no token, no probe-target skips.
//
// Run it in the lane's worktree. The probes are <commit>'s (default HEAD),
// so commit first. The token is minted here, by the target's own `token
// --json` (tests/behavioral/_staging-target.mjs or _throwaway-target.mjs),
// and lives only as long as the job may: armada keeps a job's environment,
// so only a credential for this target and run goes there, expiring with
// it, and no output carries it (probes.mjs scrubs).
//
// --deploy first deploys <commit> (HEAD, clean where a deploy reads it) to
// the throwaway <name>, then probes it as --target throwaway:<name> does.
// The dist gate and wrangler's bundle run on CI (scripts/ci/lib/release.mjs);
// this machine only uploads the bundle, as built, with its own wrangler
// login (_throwaway-target.mjs up --bundle), and checks the deployment by
// its id. No Cloudflare credential leaves this machine. Tear the throwaway
// down from here, which builds nothing:
// `bun tests/behavioral/_throwaway-target.mjs down --name <name>`.
//
// --parts N splits the selection N ways, each run --jobs J at a time
// (default 4 × 4: the 16 probes at once the suite has always run, so the
// target sees the same load). --only/--skip select as run-all does; against
// either target (both are apps/probe) the skips default to
// PROBE_TARGET_SKIPS. --repeat runs each named probe --times more times
// (default 5), each alone and beside the suite, as the release matrix does
// with write-heavy probes whose failure is intermittent.
// --screenshots saves the existing capture hooks' PNGs under <dir>/<job>/<task>.
//
// The paired perf probes (tests/behavioral/_paired.mjs PAIRED_PROBES) are
// graded against a baseline measured in the same run, not a fixed bound.
// When the selection has one, this builds the baseline (--baseline, default
// the commit's merge-base with origin/main) beside the candidate, stands up
// three fresh throwaways (lib/paired-previews.mjs: two of the baseline, one
// of the candidate), runs those probes in a task of their own beside the
// parts, and deletes the throwaways when the run ends.
//
// A red row whose output shows a 1006 close or E_NIMBUS_DO_OVERLOADED is
// attributed from the platform's own record (lib/reset-attribution.mjs:
// Workers Logs and traces, read here with the observability token). A row
// whose sessions show only the platform storage reset is rerun once, alone,
// against the same target; the rerun grades it, and the verdict keeps both.
// Every other class stays red, with its attribution printed. A throwaway
// target redeployed under the run makes the run not graded.
//
// It prints one line per task and every red row with its output tail, and
// keeps the whole verdict under ~/.local/state/nimbus/remote-probes/.
// Exit: 0, every row green; 1, a red row; 2, a task not graded.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAIRED_ENV, PAIRED_PROBES } from '../../tests/behavioral/_paired.mjs';
import { PROBE_TARGET_SKIPS } from '../../tests/behavioral/_probe-target-skips.mjs';
import { namesProbe, selectionNames, selects } from '../../tests/behavioral/_selection.mjs';
import { mapOnArmada } from './lib/armada.mjs';
import { assertInstalled } from './lib/installed.mjs';
import { defaultBaseline, standUpPaired } from './lib/paired-previews.mjs';
import { OBSERVABILITY_TOKEN_FILE, attributeRow, describeAttribution, showsResetSymptom, telemetry } from './lib/reset-attribution.mjs';
import { NIMBUS_STATE } from './lib/state-dir.mjs';
import { writeScreenshots } from './lib/probe-screenshots.mjs';

/** A task's limit on armada, and so the job's: every part runs at once. */
const TASK_TIMEOUT_S = 30 * 60;
/** How long a task may wait to start (a new environment preparing, a queue): past it, not graded. */
const PREPARE_S = 15 * 60;
const TOKEN_TTL_MS = (PREPARE_S + TASK_TIMEOUT_S) * 1000;
/** Workers Logs can trail a reset by minutes: how often, and how many times, a session no log names yet is looked up again. */
const ATTRIBUTION_WAIT_MS = 45_000;
const ATTRIBUTION_TRIES = 4;

const argv = process.argv.slice(2);
const VALUED = ['--target', '--deploy', '--only', '--skip', '--parts', '--jobs', '--repeat', '--times', '--screenshots', '--baseline'];
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (VALUED.includes(argv[i]) && argv[i + 1] !== undefined) flags[argv[i].slice(2)] = argv[++i];
  else if (!argv[i].startsWith('--')) positional.push(argv[i]);
  else usage(`unexpected ${argv[i]}`);
}
const target = /^(staging|throwaway:(.+)|hosted:(https:\/\/[^/]+))$/.exec(flags.target ?? '');
if (!target === !flags.deploy || positional.length > 1) usage('one of --target staging, throwaway:<name> or hosted:<https origin>, and --deploy <name>, is required');
const hosted = target?.[3];
if (hosted && !flags.only) usage('--target hosted:<origin> runs the hosted-demo checks it is given (--only)');
const count = (name, fallback) => {
  const value = flags[name] === undefined ? fallback : Number(flags[name]);
  if (!Number.isInteger(value) || value < 1) usage(`--${name} must be a positive integer`);
  return value;
};
const parts = count('parts', 4);
const jobs = count('jobs', 4);
const times = count('times', 5);
function usage(why) {
  console.error(`${why}\nusage: bun scripts/ci/remote-probes.mjs (--target staging|throwaway:<name> | --deploy <name>) [<commit>] [--only a,b] [--skip c,d] [--parts N] [--jobs J] [--repeat a,b --times T] [--baseline <commit>] [--screenshots <local-dir>]`);
  process.exit(2);
}

const git = (cwd, args) => {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${(done.stderr || done.error?.message || '').trim()}`);
  return done.stdout.trim();
};
let repo;
let sha;
try {
  repo = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  sha = git(repo, ['rev-parse', '--verify', `${positional[0] ?? 'HEAD'}^{commit}`]);
} catch (error) {
  console.error(`remote-probes: NOT GRADED — ${error.message}`);
  process.exit(2);
}

// A hosted demo is probed as its visitors use it, anonymously: no token, and
// no probe-target skips.
const skip = flags.skip ?? (hosted ? '' : PROBE_TARGET_SKIPS.join(','));
const throwaway = flags.deploy ?? target[2];
// A hosted demo has no paired targets; its checks are named, and none is paired.
const paired = hosted ? [] : PAIRED_PROBES.filter((probe) => selects({ only: flags.only, skip }, `${probe}.mjs`));
// An --only that names nothing but paired probes needs no parts.
const suite = !flags.only || selectionNames(flags.only).some((name) => !paired.some((probe) => namesProbe([name], `${probe}.mjs`)));

let baseline = null;
let pairedRun = null;
let status = 0;
try {
  // Minting and deploying run the target scripts, which parse wrangler configs.
  if (!hosted) assertInstalled(repo, 'remote-probes');
  if (flags.deploy && git(repo, ['rev-parse', 'HEAD']) !== sha) throw new Error(`--deploy deploys this worktree's HEAD, and ${sha.slice(0, 12)} is not it`);
  if (paired.length > 0) baseline = flags.baseline ? git(repo, ['rev-parse', '--verify', `${flags.baseline}^{commit}`]) : defaultBaseline(repo, sha);
  // Every release this run uploads, built at once: the candidate's for --deploy
  // or the paired arm b, the baseline's for arms a1 and a2.
  const commits = [...new Set([...(flags.deploy || baseline ? [sha] : []), ...(baseline ? [baseline] : [])])];
  const { fetchRelease } = await import('./lib/release.mjs');
  const releases = Object.fromEntries(await Promise.all(commits.map(async (commit) => [commit, (await fetchRelease({ repo, sha: commit, targets: ['apps/probe'] })).dir])));
  if (flags.deploy) {
    // Its exports (a token among them) are not wanted: probes get their own, below.
    const up = spawnSync('bun', ['tests/behavioral/_throwaway-target.mjs', 'up', '--name', flags.deploy, '--bundle', releases[sha]], { cwd: repo, stdio: ['ignore', 'ignore', 'inherit'] });
    if (up.status !== 0) throw new Error(`the upload of the release to ${flags.deploy} failed (exit ${up.status}); the release is in ${releases[sha]}`);
  }
  if (baseline) {
    console.error(`remote-probes: ${paired.join(', ')} graded against ${baseline.slice(0, 12)}${baseline === sha ? ' (the candidate itself)' : ''}`);
    pairedRun = await standUpPaired({ repo, baseline, candidate: sha, releases, ttlMs: TOKEN_TTL_MS });
  }
} catch (error) {
  console.error(`remote-probes: NOT GRADED — ${error.message}`);
  status = 2;
}
if (status === 0) status = await probeRun();
const left = pairedRun ? await pairedRun.teardown() : [];
for (const line of left) console.error(`remote-probes: LEFT BEHIND ${line}`);
process.exit(status);

/** The live deployment of the throwaway this run probes, by its id; null for staging and hosted targets. */
function deployment() {
  if (throwaway === undefined) return null;
  const read = spawnSync('bun', ['tests/behavioral/_throwaway-target.mjs', 'version', '--name', throwaway], { cwd: repo, encoding: 'utf8' });
  if (read.status !== 0) throw new Error(`could not read ${throwaway}'s live deployment:\n${read.stderr}`);
  return read.stdout.trim();
}

/** The suite against the target, and its verdict kept; resolves to the run's exit status. */
async function probeRun() {
  const minter = throwaway === undefined
    ? ['tests/behavioral/_staging-target.mjs', 'token']
    : ['tests/behavioral/_throwaway-target.mjs', 'token', '--name', throwaway];
  // The latest a task may start and still end within its limit before the token
  // expires; one that starts later (a slow queue, a long preparation) is not graded.
  const startBy = Date.now() + TOKEN_TTL_MS - TASK_TIMEOUT_S * 1000;
  const minted = hosted ? null : spawnSync('bun', [...minter, '--json', '--ttl-ms', String(TOKEN_TTL_MS)], { cwd: repo, encoding: 'utf8' });
  if (minted && minted.status !== 0) {
    console.error(`remote-probes: NOT GRADED — could not mint a token for ${throwaway ?? 'staging'}:\n${minted.stderr}`);
    return 2;
  }
  const { base, token } = minted ? JSON.parse(minted.stdout) : { base: hosted, token: null };
  const arms = pairedRun?.targets ?? null;
  const secrets = [token, ...Object.values(arms ?? {}).map((arm) => arm.token)].filter(Boolean);
  const scrub = (text) => secrets.reduce((scrubbed, secret) => scrubbed.replaceAll(secret, '[NIMBUS_PROBE_TOKEN]'), text);
  // The paired probes run in a task of their own, one at a time; the parts skip them.
  const partSkip = [skip, ...paired].filter(Boolean).join(',');
  const items = [
    ...(suite ? Array.from({ length: parts }, (_, i) => ({ task: `part ${i + 1}/${parts}`, part: `${i + 1}/${parts}`, only: flags.only ?? '', skip: partSkip, jobs })) : []),
    ...(paired.length > 0 ? [{ task: 'paired perf', part: '1/1', only: paired.join(','), skip, jobs: 1 }] : []),
    ...(flags.repeat ?? '').split(',').filter(Boolean).flatMap((probe) => Array.from({ length: times }, (_, i) => ({
      task: `${probe} #${i + 1}`, part: '1/1', only: probe, skip, jobs: 1,
    }))),
  ];
  console.error(`remote-probes: ${items.length} tasks against ${base}, probes of ${sha.slice(0, 12)}`);
  const env = { ...(token ? { NIMBUS_PROBE_TOKEN: token } : {}), ...(arms ? { [PAIRED_ENV]: JSON.stringify(arms) } : {}) };
  const mapItems = (list, label) => mapOnArmada({
    repo, sha, files: ['scripts/ci/probes.mjs', 'scripts/ci/lib/probe-screenshots.mjs', 'tests/behavioral/run-all.mjs', 'tests/behavioral/_selection.mjs'], setup: 'scripts/ci/recipe/chromium.sh',
    items: list, env, label, timeout: TASK_TIMEOUT_S,
    command: ['bun', 'scripts/ci/probes.mjs', '--out', '{out}', '--base', base, '--only', '{only}', '--skip', '{skip}', '--part', '{part}', '--jobs', '{jobs}',
      ...(token ? ['--start-by', String(startBy)] : ['--anonymous']), ...(flags.screenshots ? ['--screenshots', '1'] : [])],
  });

  let before;
  let mapped;
  try {
    before = deployment();
    mapped = await mapItems(items, `remote-probes ${sha.slice(0, 12)} ${throwaway ?? hosted ?? 'staging'}`);
  } catch (error) {
    console.error(`remote-probes: NOT GRADED — ${scrub(error.message)}`);
    return 2;
  }

  let status = 0;
  const tasks = readTasks(items, mapped, scrub);

  // Red rows a reset or an overload left, attributed from the platform's record.
  const reader = telemetry({ account: process.env.CLOUDFLARE_ACCOUNT_ID });
  const symptomatic = tasks.flatMap((task) => (task.rows ?? []).filter((row) => row.exitCode !== 0 && showsResetSymptom(row.output)).map((row) => ({ task, row })));
  if (symptomatic.length > 0 && !reader) console.log(`remote-probes: ${symptomatic.length} red rows show a reset or an overload; without CLOUDFLARE_ACCOUNT_ID and the observability token (${OBSERVABILITY_TOKEN_FILE}) none is attributed`);
  if (symptomatic.length > 0 && reader) {
    for (let attempt = 1; ; attempt++) {
      for (const entry of symptomatic) {
        if (entry.row.attribution?.sessions.every((session) => session.object !== null)) continue;
        try {
          entry.row.attribution = await attributeRow(reader, { output: entry.row.output, base, until: Date.now() });
        } catch (error) {
          entry.row.attribution = { sessions: [], regrade: false, error: error.message };
        }
      }
      const unnamed = symptomatic.some(({ row }) => row.attribution.sessions.some((session) => session.object === null));
      if (!unnamed || attempt === ATTRIBUTION_TRIES) break;
      await new Promise((resolve) => setTimeout(resolve, ATTRIBUTION_WAIT_MS));
    }
    for (const { task, row } of symptomatic) {
      console.log(`ATTRIBUTED ${row.name} (${task.task}):${row.attribution.error ? ` unavailable: ${row.attribution.error}` : ''}\n${describeAttribution(row.attribution).map((line) => `    ${line}`).join('\n')}`);
    }
  }

  // A row only the platform storage reset turned red is rerun once, alone; its rerun grades it.
  const regrade = symptomatic.filter(({ row }) => row.attribution?.regrade);
  if (regrade.length > 0) {
    const reruns = regrade.map(({ task, row }, i) => {
      const probe = row.name.replace(/^tests\/behavioral\//, '').replace(/\.mjs$/, '');
      row.regraded = { task: `regrade ${probe} #${i + 1}`, evidence: describeAttribution(row.attribution) };
      return { task: row.regraded.task, part: '1/1', only: probe, skip: '', jobs: 1, of: task.task };
    });
    try {
      const again = await mapItems(reruns.map(({ of, ...item }) => item), `remote-probes ${sha.slice(0, 12)} regrade`);
      tasks.push(...readTasks(reruns, again, scrub));
    } catch (error) {
      console.error(`remote-probes: NOT GRADED — the regrade could not run: ${scrub(error.message)}`);
      status = 2;
    }
    for (const { row } of regrade) console.log(`REGRADED ${row.name}: its sessions show only the platform storage reset; ${row.regraded.task} grades it`);
  }

  for (const task of tasks) {
    if (!task.rows || task.screenshotError) {
      status = 2;
      continue;
    }
    const red = task.rows.filter((row) => row.exitCode !== 0 && !row.regraded);
    if (red.some((row) => row.exitCode === 2)) status = 2;
    else if (red.length > 0 && status === 0) status = 1;
  }

  try {
    const after = deployment();
    if (after !== before) {
      console.log(`remote-probes: NOT GRADED — ${throwaway} was redeployed under the run: ${before} before, ${after} after`);
      status = 2;
    }
  } catch (error) {
    console.error(`remote-probes: NOT GRADED — ${error.message}`);
    status = 2;
  }

  const state = join(NIMBUS_STATE, 'remote-probes');
  try {
    mkdirSync(state, { recursive: true });
    const report = join(state, `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${sha.slice(0, 12)}-${mapped.jobId}.json`);
    writeFileSync(report, `${scrub(JSON.stringify({ commit: sha, target: throwaway ? `throwaway:${throwaway}` : hosted ? `hosted:${hosted}` : 'staging', base, job: mapped.jobId,
      ...(baseline ? { baseline } : {}), tasks }, null, 2))}\n`);
    console.log(`remote-probes: ${status === 0 ? 'every row green' : status === 1 ? 'red rows above' : 'not every task was graded'}; verdict ${report} (job ${mapped.jobId})`);
    return status;
  } catch (error) {
    console.error(`remote-probes: NOT GRADED — the verdict could not be kept: ${scrub(error.message)}`);
    return 2;
  }
}

/** Each item's task as mapped: its rows (null when it was not graded), printed as they are read. */
function readTasks(items, mapped, scrub) {
  return mapped.outcomes.map((outcome, i) => {
    const item = items[outcome.index];
    let verdict = null;
    try { verdict = JSON.parse(mapped.outputs[i] ?? 'null'); } catch { /* reported below */ }
    if (outcome.kind !== 'exited' || verdict === null) {
      console.log(`NOT GRADED ${item.task}: ${outcome.kind === 'exited' ? `exit ${outcome.exitCode}, no verdict` : 'armada could not run it'}\n${scrub(outcome.tail ?? '')}`);
      return { ...item, outcome, rows: null };
    }
    const red = verdict.rows.filter((row) => row.exitCode !== 0);
    console.log(`${red.length === 0 ? 'ok  ' : 'FAIL'} ${item.task}: ${verdict.rows.length - red.length} of ${verdict.rows.length} rows green in ${Math.round(outcome.seconds)} s`);
    for (const row of red) console.log(`  FAIL ${row.name} (exit ${row.exitCode}, ${Math.round(row.seconds)} s)\n${row.output.trimEnd().split('\n').slice(-25).map((line) => `    ${line}`).join('\n')}`);
    let screenshots = [];
    if (flags.screenshots) {
      try {
        screenshots = writeScreenshots(join(flags.screenshots, mapped.jobId, String(outcome.index + 1)), verdict.screenshots ?? []);
        for (const path of screenshots) console.log(`screenshot: ${path}`);
      } catch (error) {
        console.error(`NOT GRADED ${item.task} screenshots: ${error.message}`);
        return { ...item, outcome, rows: verdict.rows, screenshotError: error.message };
      }
    }
    return { ...item, outcome, rows: verdict.rows, ...(flags.screenshots ? { screenshots } : {}) };
  });
}
