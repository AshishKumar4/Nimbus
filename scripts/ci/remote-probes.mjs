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
// When the selection has one, this takes the baseline (--baseline, default
// the commit's merge-base with origin/main) as staging sealed it here, or
// builds it beside the candidate when no sealed release of it is here; the
// verdict says which (`baseline`). Then it stands up
// four fresh throwaways (lib/paired-previews.mjs: two of the baseline, two
// of the candidate), runs those probes in a task of their own beside the
// parts, and deletes the throwaways when the run ends. A paired probe red
// there is run again on a fresh set of four, and is red only if red on both.
//
// A red row whose session socket closed 1006 (the run's session ledger) or
// that shows E_NIMBUS_DO_OVERLOADED is attributed from the platform's own
// record (lib/reset-attribution.mjs: Workers Logs and traces, read here with
// the observability token). A row whose only failures are those closes, on
// sessions that show the platform storage reset and nothing else, is rerun
// once, alone, against the same target; the rerun's task grades it, and the
// verdict keeps both. Every other class stays red, with its attribution
// printed. A throwaway (target or paired arm) redeployed under a job makes
// the run not graded. Each job gets tokens minted for it.
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
import { defaultBaseline, pairedPreviews } from './lib/paired-previews.mjs';
import { OBSERVABILITY_TOKEN_FILE, attributeRow, describeAttribution, regradable, showsResetSymptom, telemetry } from './lib/reset-attribution.mjs';
import { openRunDir } from './lib/run-dir.mjs';
import { NIMBUS_STATE } from './lib/state-dir.mjs';
import { writeScreenshots } from './lib/probe-screenshots.mjs';

/** A task's limit on armada, and so the job's: every part runs at once. */
const TASK_TIMEOUT_S = 30 * 60;
/**
 * How long a task may take, from its token's minting, to start its first
 * attempt and still be graded: the sum of the longest of each part measured.
 * - Minting to the job's creation (deployments read, the pack uploaded): 35 s
 *   (train 1021a, the one run timed).
 * - The job's creation to its start, an environment prepared: at most 331.4 s
 *   over armada's records of 1,623 jobs (2026-10-19 to 10-21; preparation
 *   152-319 s). On a ready environment, at most 0.9 s.
 * - A vessel to run it (fleet capacity, boot, checkout): at most 26.4 s, start
 *   to finish less the vessel's busy time, over the 953 one-task jobs; the
 *   slowest boot alone, in any job, 61 s.
 * Not measured: how long many vessels at once wait for fleet capacity in a
 * job that prepared its environment. Each task's verdict now says when it
 * started (startedAt), and each run says how long its tasks waited, so the
 * next derivation measures it. A task that starts past this, or that armada
 * starts again later (its container lost), runs once more with fresh
 * credentials (runTasks).
 */
const PREPARE_S = Math.ceil(35 + 331.4 + 61);
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
const repeats = (flags.repeat ?? '').split(',').filter(Boolean);
// The paired probes the suite selects, and those it repeats, need the arms;
// a hosted demo's checks are named, and none is paired.
const pairedInSuite = hosted ? [] : PAIRED_PROBES.filter((probe) => selects({ only: flags.only, skip }, `${probe}.mjs`));
const paired = hosted ? [] : PAIRED_PROBES.filter((probe) => pairedInSuite.includes(probe)
  || repeats.some((name) => namesProbe(selectionNames(name), `${probe}.mjs`)));
// An --only that names nothing but paired probes needs no parts.
const suite = !flags.only || selectionNames(flags.only).some((name) => !PAIRED_PROBES.some((probe) => namesProbe([name], `${probe}.mjs`)));

// While no armada job runs, a signal ends the run: every upload or install
// still running is ended and waited for, then 'exit', whose listener deletes
// the paired throwaways. During a job, armada's own listener cancels it and
// exits, and that 'exit' deletes them too. A second signal exits at once.
let halting = false;
const exitOnSignal = () => {
  if (halting || !arms) process.exit(130);
  halting = true;
  arms.halt().finally(() => process.exit(130));
};
const signals = (on) => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    if (on) process.on(signal, exitOnSignal);
    else process.off(signal, exitOnSignal);
  }
};
const onArmada = async (job) => {
  signals(false);
  try { return await job(); } finally { signals(true); }
};

let arms = null;
/** This run's own directory (lib/run-dir.mjs), opened when it fetches a release. */
let runDir = null;
/** Where the paired baseline's release came from: { commit, release, digest } when staging sealed it, { commit, built: job } when built now. */
let baselineSource = null;
/** The deployment each throwaway this run grades must serve throughout: its upload's, or the target's when this run did not upload it. */
const expected = {};
let status = 0;
try {
  // Minting and deploying run the target scripts, which parse wrangler configs.
  if (!hosted) assertInstalled(repo, 'remote-probes');
  if (flags.deploy && git(repo, ['rev-parse', 'HEAD']) !== sha) throw new Error(`--deploy deploys this worktree's HEAD, and ${sha.slice(0, 12)} is not it`);
  // The arms this run stands up are this checkout's (_paired.mjs); the probes that measure them run at the commit.
  if (paired.length > 0 && spawnSync('git', ['diff', '--quiet', sha, 'HEAD', '--', 'tests/behavioral/_paired.mjs'], { cwd: repo }).status !== 0) {
    throw new Error(`the paired probes at ${sha.slice(0, 12)} take other arms than this checkout stands up (tests/behavioral/_paired.mjs differs): probe it from a checkout of ${sha.slice(0, 12)}, or --skip ${paired.join(',')}`);
  }
  const baseline = paired.length === 0 ? null
    : flags.baseline ? git(repo, ['rev-parse', '--verify', `${flags.baseline}^{commit}`]) : defaultBaseline(repo, sha);
  // Every release this run uploads, built at once and settled together: the
  // candidate's for --deploy or the paired arms b1 and b2, the baseline's for a1 and a2.
  // They, and the baseline's checkout, are this run's alone: kept in its own directory under RUNS, deleted when it ends.
  const commits = [...new Set([...(flags.deploy || baseline ? [sha] : []), ...(baseline ? [baseline] : [])])];
  if (commits.length > 0) {
    runDir = openRunDir(repo);
    process.on('exit', () => {
      // A Preview its checkout could not take down is finished from that checkout: then the directory stays.
      const left = arms?.teardown() ?? [];
      for (const line of [...left, ...(left.length > 0 ? runDir.keep() : runDir.close())]) console.error(`remote-probes: LEFT BEHIND ${line}`);
    });
  }
  const { fetchRelease, recordedRelease } = await import('./lib/release.mjs');
  // A baseline staging sealed here is uploaded as staging verified it, not
  // built again (lib/release.mjs recordedRelease); any other is built.
  const recorded = baseline && baseline !== sha ? recordedRelease({ sha: baseline, target: 'apps/probe', into: join(runDir.dir, 'releases') }) : null;
  const toBuild = commits.filter((commit) => !(recorded && commit === baseline));
  const built = await Promise.allSettled(toBuild.map((commit) => fetchRelease({ repo, sha: commit, targets: ['apps/probe'], into: join(runDir.dir, 'releases') })));
  const releases = {};
  const jobs = {};
  for (const [i, outcome] of built.entries()) {
    if (outcome.status === 'rejected') throw outcome.reason;
    releases[toBuild[i]] = outcome.value.dir;
    jobs[toBuild[i]] = outcome.value.release.job;
  }
  if (recorded) releases[baseline] = recorded.dir;
  // What the a-arms run, kept in the verdict: the sealed release (its directory and digest), or the job that built it now.
  baselineSource = !baseline ? null : recorded ? { commit: baseline, release: recorded.sealed, digest: recorded.digest }
    : { commit: baseline, built: jobs[baseline] };
  signals(true);
  if (flags.deploy) {
    // Its exports (a token among them) are not wanted: probes get their own, below.
    const up = spawnSync('bun', ['tests/behavioral/_throwaway-target.mjs', 'up', '--name', flags.deploy, '--bundle', releases[sha]], { cwd: repo, stdio: runDir.stdio(['ignore', 'ignore', 'inherit']) });
    if (up.status !== 0) throw new Error(`the upload of the release to ${flags.deploy} failed (exit ${up.status})`);
  }
  // A target this run uploaded must serve that upload (its record's versionId); one it did not, what it serves now.
  if (throwaway !== undefined) {
    const { readState, throwawayStatePath } = await import('../../tests/behavioral/_deploy-target.mjs');
    expected[`target ${throwaway}`] = flags.deploy ? readState(throwawayStatePath(repo, throwaway))?.versionId : (await deployments())[`target ${throwaway}`];
  }
  if (baseline) {
    console.error(`remote-probes: ${paired.join(', ')} graded against ${baseline.slice(0, 12)}${baseline === sha ? ' (the candidate itself)' : ''}, ${baselineSource.release
      ? `the release staging sealed (${baselineSource.release}, digest ${baselineSource.digest})` : `built now (job ${baselineSource.built})`}`);
    arms = pairedPreviews({ repo, runDir });
    await arms.standUp({ baseline, candidate: sha, releases });
    for (const [arm, id] of Object.entries(arms.receipts())) expected[`arm ${arm}`] = id;
  }
  status = await probeRun({ baseline, releases });
} catch (error) {
  console.error(`remote-probes: NOT GRADED — ${error.message}`);
  status = 2;
}
process.exit(status);

/**
 * The deployments this run grades, by id: the throwaway target's and each
 * paired arm's once stood up. Staging's are release.mjs's to bracket; a
 * hosted demo has none.
 */
async function deployments() {
  const ids = {};
  if (throwaway !== undefined) {
    const read = spawnSync('bun', ['tests/behavioral/_throwaway-target.mjs', 'version', '--name', throwaway], { cwd: repo, encoding: 'utf8' });
    if (read.status !== 0) throw new Error(`could not read ${throwaway}'s live deployment:\n${read.stderr}`);
    ids[`target ${throwaway}`] = read.stdout.trim();
  }
  if (arms) for (const [arm, id] of Object.entries(await arms.versions())) ids[`arm ${arm}`] = id;
  return ids;
}

/**
 * Credentials for one armada job: the target's token and each arm's, minted
 * now, and the latest the job's tasks may start and still end within their
 * limit before a token expires (a task that starts later is not graded).
 */
async function credentials() {
  const startBy = Date.now() + TOKEN_TTL_MS - TASK_TIMEOUT_S * 1000;
  if (hosted) return { base: hosted, token: null, arms: null, startBy };
  const minter = throwaway === undefined
    ? ['tests/behavioral/_staging-target.mjs', 'token']
    : ['tests/behavioral/_throwaway-target.mjs', 'token', '--name', throwaway];
  const minted = spawnSync('bun', [...minter, '--json', '--ttl-ms', String(TOKEN_TTL_MS)], { cwd: repo, encoding: 'utf8' });
  if (minted.status !== 0) throw new Error(`could not mint a token for ${throwaway ?? 'staging'}:\n${minted.stderr}`);
  const { base, token } = JSON.parse(minted.stdout);
  return { base, token, arms: arms ? await arms.credentials(TOKEN_TTL_MS) : null, startBy };
}

/**
 * The suite against the target, and its verdict kept; resolves to the run's
 * exit status. `baseline` and `releases` stand up a fresh set of paired
 * Previews to confirm a paired red on.
 */
async function probeRun({ baseline, releases }) {
  const secrets = [];
  const scrub = (text) => secrets.reduce((scrubbed, secret) => scrubbed.replaceAll(secret, '[NIMBUS_PROBE_TOKEN]'), text);
  /** Map `list` on armada with credentials of its own; every token it carries is scrubbed from what this prints and keeps. */
  const mapItems = async (list, label) => {
    const mintedAt = Date.now();
    const { base, token, arms: armTargets, startBy } = await credentials();
    secrets.push(...[token, ...Object.values(armTargets ?? {}).map((arm) => arm.token)].filter(Boolean));
    const env = { ...(token ? { NIMBUS_PROBE_TOKEN: token } : {}), ...(armTargets ? { [PAIRED_ENV]: JSON.stringify(armTargets) } : {}) };
    const before = await deployments();
    console.error(`remote-probes: ${list.length} tasks against ${base}, probes of ${sha.slice(0, 12)}`);
    const mapped = await onArmada(() => mapOnArmada({
      repo, sha, files: ['scripts/ci/probes.mjs', 'scripts/ci/lib/probe-screenshots.mjs', 'tests/behavioral/run-all.mjs', 'tests/behavioral/_selection.mjs', 'tests/behavioral/_ledger.mjs'], setup: 'scripts/ci/recipe/chromium.sh',
      items: list, env, label, timeout: TASK_TIMEOUT_S,
      command: ['bun', 'scripts/ci/probes.mjs', '--out', '{out}', '--base', base, '--only', '{only}', '--skip', '{skip}', '--part', '{part}', '--jobs', '{jobs}',
        ...(token ? ['--start-by', String(startBy)] : ['--anonymous']), ...(flags.screenshots ? ['--screenshots', '1'] : [])],
    }));
    const after = await deployments();
    const moved = Object.keys(expected).filter((name) => before[name] !== expected[name] || after[name] !== expected[name]);
    return { base, mapped, mintedAt, moved: moved.map((name) => `${name} served ${before[name]} before the job and ${after[name]} after, not ${expected[name]}`) };
  };
  /**
   * `list` mapped on armada and read into its tasks. A task armada started
   * again after its token's start-by (its first attempt's container lost)
   * refused to run: it runs once more, in a job of its own with credentials
   * minted for it, so no token outlives one task. Once: a task that starts
   * late again is not graded.
   */
  const runTasks = async (list, label) => {
    const run = await mapItems(list, label);
    const tasks = readTasks(list, run.mapped, scrub, run.mintedAt);
    const problems = [...run.moved];
    const late = tasks.flatMap((task, at) => (task.lateStart ? [{ at, item: list[task.outcome.index] }] : []));
    if (late.length > 0) {
      // The same tasks, by the same names: what a regrade or a confirmation names them by.
      const again = late.map(({ item }) => item);
      try {
        const rerun = await mapItems(again, `${label} late start`);
        problems.push(...rerun.moved);
        for (const task of readTasks(again, rerun.mapped, scrub, rerun.mintedAt)) tasks[late[task.outcome.index].at] = task;
      } catch (error) {
        problems.push(`the late-started tasks could not run again: ${scrub(error.message)}`);
      }
    }
    return { base: run.base, jobId: run.mapped.jobId, tasks, problems };
  };

  // The paired probes run in a task of their own, one at a time; the parts skip them.
  const partSkip = [skip, ...PAIRED_PROBES].filter(Boolean).join(',');
  const items = [
    ...(suite ? Array.from({ length: parts }, (_, i) => ({ task: `part ${i + 1}/${parts}`, part: `${i + 1}/${parts}`, only: flags.only ?? '', skip: partSkip, jobs })) : []),
    ...(pairedInSuite.length > 0 ? [{ task: 'paired perf', part: '1/1', only: pairedInSuite.join(','), skip, jobs: 1 }] : []),
    ...repeats.flatMap((probe) => Array.from({ length: times }, (_, i) => ({ task: `${probe} #${i + 1}`, part: '1/1', only: probe, skip, jobs: 1 }))),
  ];
  let run;
  try {
    run = await runTasks(items, `remote-probes ${sha.slice(0, 12)} ${throwaway ?? hosted ?? 'staging'}`);
  } catch (error) {
    console.error(`remote-probes: NOT GRADED — ${scrub(error.message)}`);
    return 2;
  }
  const { base, jobId, tasks } = run;
  const problems = [...run.problems];

  // Red rows a reset or an overload left, attributed from the platform's record.
  const reader = telemetry({ account: process.env.CLOUDFLARE_ACCOUNT_ID });
  const symptomatic = tasks.flatMap((task) => (task.rows ?? []).filter((row) => row.exitCode !== 0 && row.sessions && showsResetSymptom(row)).map((row) => ({ task, row })));
  if (symptomatic.length > 0 && !reader) console.log(`remote-probes: ${symptomatic.length} red rows show a reset or an overload; without CLOUDFLARE_ACCOUNT_ID and the observability token (${OBSERVABILITY_TOKEN_FILE}) none is attributed`);
  if (symptomatic.length > 0 && reader) {
    for (let attempt = 1; ; attempt++) {
      for (const entry of symptomatic) {
        if (entry.row.attribution?.sessions.every((session) => session.object !== null)) continue;
        try {
          entry.row.attribution = await attributeRow(reader, entry.row, { base, until: Date.now() });
        } catch (error) {
          entry.row.attribution = { sessions: [], error: error.message };
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

  // A row only the platform storage reset turned red is rerun once, alone.
  // The rerun's task grades it, and only once that task has rows.
  const regrade = symptomatic.filter(({ row }) => row.attribution && !row.attribution.error && regradable(row, row.attribution));
  if (regrade.length > 0) {
    const reruns = regrade.map(({ row }, i) => ({ task: `regrade ${row.name.replace(/^tests\/behavioral\//, '').replace(/\.mjs$/, '')} #${i + 1}`, part: '1/1',
      only: row.name.replace(/^tests\/behavioral\//, ''), skip: '', jobs: 1 }));
    try {
      const again = await runTasks(reruns, `remote-probes ${sha.slice(0, 12)} regrade`);
      problems.push(...again.problems);
      const rerun = again.tasks;
      tasks.push(...rerun);
      regrade.forEach(({ row }, i) => {
        if (!rerun[i]?.rows?.some((other) => other.name === row.name)) return;
        row.regraded = { task: reruns[i].task, evidence: describeAttribution(row.attribution) };
        console.log(`REGRADED ${row.name}: only the platform storage reset turned it red; ${reruns[i].task} grades it`);
      });
    } catch (error) {
      problems.push(`the regrade could not run: ${scrub(error.message)}`);
    }
  }

  // A paired probe red on one set of Previews is run again on a fresh set,
  // and is red only if red on both: a set can land slow as a whole, and
  // where it landed is drawn again; a slower candidate is slower on both.
  const pairedRed = tasks.flatMap((task) => (task.rows ?? []).filter((row) => row.exitCode === 1 && !row.regraded
    && PAIRED_PROBES.some((probe) => row.name === `tests/behavioral/${probe}.mjs`)));
  if (arms && pairedRed.length > 0) {
    const probes = [...new Set(pairedRed.map((row) => row.name.replace(/^tests\/behavioral\//, '').replace(/\.mjs$/, '')))];
    const confirm = [{ task: 'paired perf on fresh Previews', part: '1/1', only: probes.join(','), skip: '', jobs: 1 }];
    try {
      await arms.replace({ baseline, candidate: sha, releases });
      for (const [arm, id] of Object.entries(arms.receipts())) expected[`arm ${arm}`] = id;
      const again = await runTasks(confirm, `remote-probes ${sha.slice(0, 12)} paired confirmation`);
      problems.push(...again.problems);
      const [rerun] = again.tasks;
      tasks.push(rerun);
      for (const row of pairedRed) {
        const second = rerun.rows?.find((other) => other.name === row.name);
        if (second?.exitCode === 0) {
          row.regraded = { task: confirm[0].task, evidence: ['red on one set of Previews and green on a fresh set: where they landed, not the code'] };
          console.log(`REGRADED ${row.name}: red on one set of Previews, green on a fresh set`);
        } else if (second?.exitCode === 1) console.log(`CONFIRMED ${row.name}: red on two sets of Previews`);
        else console.log(`UNCONFIRMED ${row.name}: the fresh set ${second ? `did not grade it (exit ${second.exitCode})` : 'has no row of it'}`);
      }
    } catch (error) {
      problems.push(`the paired confirmation could not run: ${scrub(error.message)}`);
    }
  }

  let status = problems.length > 0 ? 2 : 0;
  for (const problem of problems) console.log(`remote-probes: NOT GRADED — ${problem}`);
  for (const task of tasks) {
    if (!task.rows || task.screenshotError) {
      status = 2;
      continue;
    }
    const red = task.rows.filter((row) => row.exitCode !== 0 && !row.regraded);
    if (red.some((row) => row.exitCode === 2)) status = 2;
    else if (red.length > 0 && status === 0) status = 1;
  }

  const state = join(NIMBUS_STATE, 'remote-probes');
  try {
    mkdirSync(state, { recursive: true });
    const report = join(state, `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${sha.slice(0, 12)}-${jobId}.json`);
    writeFileSync(report, `${scrub(JSON.stringify({ commit: sha, target: throwaway ? `throwaway:${throwaway}` : hosted ? `hosted:${hosted}` : 'staging', base, job: jobId,
      ...(paired.length > 0 ? { paired } : {}), ...(baselineSource ? { baseline: baselineSource } : {}), problems, tasks }, null, 2))}\n`);
    console.log(`remote-probes: ${status === 0 ? 'every row green' : status === 1 ? 'red rows above' : 'not every task was graded'}; verdict ${report} (job ${jobId})`);
    return status;
  } catch (error) {
    console.error(`remote-probes: NOT GRADED — the verdict could not be kept: ${scrub(error.message)}`);
    return 2;
  }
}

/** Each item's task as mapped: its rows (null when it was not graded), printed as they are read. */
function readTasks(items, mapped, scrub, mintedAt) {
  const tasks = mapped.outcomes.map((outcome, i) => {
    const item = items[outcome.index];
    let verdict = null;
    try { verdict = JSON.parse(mapped.outputs[i] ?? 'null'); } catch { /* reported below */ }
    // How long it waited to start, from its token's minting (PREPARE_S).
    if (typeof verdict?.startedAt === 'number') outcome.startDelayS = (verdict.startedAt - mintedAt) / 1000;
    if (outcome.kind !== 'exited' || verdict === null) {
      console.log(`NOT GRADED ${item.task}: ${outcome.kind === 'exited' ? `exit ${outcome.exitCode}, no verdict` : 'armada could not run it'}\n${scrub(outcome.tail ?? '')}`);
      return { ...item, outcome, rows: null };
    }
    if (verdict.lateStart === true) {
      console.log(`NOT GRADED ${item.task}: it started after its token's start-by (attempt ${outcome.attempt ?? 1})\n${scrub(outcome.tail ?? '')}`);
      return { ...item, outcome, rows: null, lateStart: true };
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
  const delays = tasks.flatMap((task) => (task.outcome.startDelayS === undefined ? [] : [task.outcome.startDelayS]));
  if (delays.length > 0) console.log(`remote-probes: its tasks started ${Math.min(...delays).toFixed(1)}-${Math.max(...delays).toFixed(1)} s after their tokens were minted (allowed ${PREPARE_S} s)`);
  return tasks;
}
