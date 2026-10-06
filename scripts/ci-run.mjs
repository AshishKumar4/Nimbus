#!/usr/bin/env bun
// The unit suite for one commit, on Cloudflare Containers (apps/ci-runner).
//
//   bun scripts/ci-run.mjs [<commit>] [--tier fast|slow|all] [--shards N]
//       [--jobs J] [--only a,b] [--timeout MS] [--label TEXT] [--logs]
//   bun scripts/ci-run.mjs --status <run-id>     wait for a run already started
//   bun scripts/ci-run.mjs --cancel <run-id>
//
// Interrupting it (Ctrl-C, or a CI job being cancelled) cancels the run.
//
// It uploads `git archive <commit>` (skipped when that tree is stored), starts
// a run, prints progress, then the verdict: every failing file with its
// output tail, the slowest files, wall time, CPU and cost. The full report
// (every file's verdict, wall time and CPU) is saved under
// ~/.local/state/nimbus/ci-runs/; --logs saves each shard's log beside it.
//
// Exit status: 0 pass, 1 a test failed, 2 the run could not grade the commit
// (upload, infrastructure, install or runner failure: never a test verdict).
//
// The commit is what is tested, never the working tree: commit first.
// Defaults: <commit> HEAD, --tier all, shards from the timing history so a
// full run takes about 10 minutes, 4 files at a time per shard.
// Auth: NIMBUS_CI_TOKEN, else ~/.config/nimbus/ci-token (written by
// apps/ci-runner/scripts/deploy.mjs). NIMBUS_CI_URL overrides the endpoint.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const URL_BASE = (process.env.NIMBUS_CI_URL || 'https://nimbus-ci-runner.ashishkmr472.workers.dev').replace(/\/$/, '');
const TOKEN_FILE = join(homedir(), '.config/nimbus/ci-token');
const REPORTS = join(homedir(), '.local/state/nimbus/ci-runs');
const POLL_MS = 5_000;

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) usage(`${name} needs a value`);
  argv.splice(i, 2);
  return value;
};
const has = (name) => {
  const i = argv.indexOf(name);
  if (i >= 0) argv.splice(i, 1);
  return i >= 0;
};

// Anything that throws past here is this script failing, not the commit's
// tests (a full disk while saving the report, a malformed answer): exit 2.
process.on('uncaughtException', (error) => infra(`ci-run itself failed: ${error?.stack ?? error}`));
process.on('unhandledRejection', (error) => infra(`ci-run itself failed: ${error?.stack ?? error}`));

function usage(message) {
  console.error(`ci-run: ${message}\nusage: bun scripts/ci-run.mjs [<commit>] [--tier fast|slow|all] [--shards N] [--jobs J] [--only a,b] [--timeout MS] [--label TEXT] [--logs]\n       bun scripts/ci-run.mjs --status <run-id> | --cancel <run-id>`);
  process.exit(2);
}

/** An infrastructure failure: the commit was not graded. */
function infra(message) {
  console.error(`ci-run: ERROR (not a test verdict): ${message}`);
  process.exit(2);
}

const token = process.env.NIMBUS_CI_TOKEN?.trim() || (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').trim() : '');
if (!token) infra(`no CI token: set NIMBUS_CI_TOKEN or create ${TOKEN_FILE} (apps/ci-runner/scripts/deploy.mjs writes it)`);

/** One request, retried once on a network error or a 5xx. */
async function api(method, path, { body, headers = {}, ok = [200, 201] } = {}) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetch(`${URL_BASE}${path}`, {
        method, body, headers: { authorization: `Bearer ${token}`, 'user-agent': 'nimbus-ci-run/1', ...headers },
      });
    } catch (error) {
      if (attempt < 2) { await new Promise((r) => setTimeout(r, 3_000)); continue; }
      infra(`${method} ${path}: ${error.message}`);
    }
    if (ok.includes(response.status)) return response;
    if (response.status >= 500 && attempt < 2) { await new Promise((r) => setTimeout(r, 3_000)); continue; }
    infra(`${method} ${path}: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
  }
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const seconds = (ms) => (ms === null || ms === undefined ? '?' : ms >= 60_000 ? `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s` : `${(ms / 1000).toFixed(1)}s`);

async function upload(commit, tree) {
  if ((await api('HEAD', `/sources/${tree}`, { ok: [200, 404] })).status === 200) {
    console.log(`ci-run: tree ${tree.slice(0, 12)} already uploaded`);
    return 0;
  }
  const t0 = Date.now();
  const archive = await new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', 'git archive --format=tar "$1" | gzip -6', 'sh', commit], { stdio: ['ignore', 'pipe', 'inherit'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`git archive exited ${code}`))));
  }).catch((error) => infra(error.message));
  await api('PUT', `/sources/${tree}`, { body: archive, headers: { 'content-type': 'application/gzip', 'content-length': String(archive.length) } });
  console.log(`ci-run: uploaded ${(archive.length / 1e6).toFixed(1)} MB in ${seconds(Date.now() - t0)}`);
  return Date.now() - t0;
}

function progressLine(status, t0) {
  const counts = {};
  let pass = 0;
  let fail = 0;
  let total = 0;
  for (const s of status.shards) {
    counts[s.state] = (counts[s.state] ?? 0) + 1;
    pass += s.progress?.pass ?? 0;
    fail += s.progress?.fail ?? 0;
    total += s.progress?.total ?? 0;
  }
  const shards = Object.entries(counts).map(([state, n]) => `${n} ${state}`).join(', ');
  return `ci-run: [${seconds(Date.now() - t0)}] shards ${shards} · files ${pass + fail}/${total || '?'}${fail ? ` · ${fail} FAIL` : ''}`;
}

async function wait(runId, t0) {
  let last = '';
  let lastPrinted = 0;
  for (;;) {
    const status = await (await api('GET', `/runs/${runId}`)).json();
    if (status.state === 'done') return status;
    const line = progressLine(status, t0);
    const shape = line.replace(/^ci-run: \[[^\]]+\] /, '');
    if (shape !== last || Date.now() - lastPrinted > 60_000) {
      console.log(line);
      last = shape;
      lastPrinted = Date.now();
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function tail(text, lines) {
  return (text ?? '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() && !/^Bun v\d+\.\d+\.\d+ \([^)]+\)$/.test(l)).slice(-lines);
}

async function verdict(status, uploadMs) {
  const { spec, summary, problems } = status;
  mkdirSync(REPORTS, { recursive: true });
  const reportPath = join(REPORTS, `${status.runId}.json`);
  const report = await (await api('GET', `/runs/${status.runId}/report`)).text();
  writeFileSync(reportPath, report);
  // Each failing file's whole output, beside the report.
  const outputs = {};
  for (const f of JSON.parse(report).files ?? []) {
    if (f.ok || (f.stdout === undefined && f.stderr === undefined)) continue;
    mkdirSync(join(REPORTS, status.runId), { recursive: true });
    outputs[f.name] = join(REPORTS, status.runId, `${f.name}.out`);
    writeFileSync(outputs[f.name], `${f.reason ?? ''}\n── stdout\n${f.stdout ?? ''}\n── stderr\n${f.stderr ?? ''}\n`);
  }
  if (has('--logs')) {
    for (const shard of status.shards) {
      const response = await api('GET', `/runs/${status.runId}/logs/${shard.index + 1}?attempt=${shard.attempt + 1}`, { ok: [200, 404] });
      if (response.status === 200) writeFileSync(join(REPORTS, `${status.runId}-shard-${shard.index + 1}.log`), await response.text());
    }
  }
  console.log('');
  for (const f of summary?.failed ?? []) {
    console.log(`FAIL ${f.name} (${seconds(f.wallMs)}${f.tier === 'fast' ? '' : `, ${f.tier}`})`);
    if (f.reason) console.log(`    ${f.reason}`);
    if (outputs[f.name]) console.log(`    whole output: ${outputs[f.name]}`);
    for (const line of tail(f.stdoutTail, 6)) console.log(`    stdout: ${line.slice(-500)}`);
    for (const line of tail(f.stderrTail, 6)) console.log(`    stderr: ${line.slice(-500)}`);
  }
  for (const problem of problems) console.log(`ERROR ${problem}`);
  // The fast tier's rule (AGENTS.md § The unit suite): no workerd, under
  // 30 s wall and 30 s CPU, under 1 GiB. A fast file this run saw break it
  // is named, so its marker lands in the commit that made it slow.
  const misfiled = (JSON.parse(report).files ?? []).filter((f) => f.ok && f.tier === 'fast'
    && ((f.commands ?? []).includes('workerd') || f.wallMs >= 30_000 || (f.cpuMs ?? 0) >= 30_000 || (f.memoryPeakBytes ?? 0) >= 2 ** 30));
  if (misfiled.length > 0) {
    console.log('\nfast-tier files that measured slow here (add `// @tier slow — <reason>`):');
    for (const f of misfiled) console.log(`  ${f.name}: ${(f.commands ?? []).includes('workerd') ? 'drives workerd, ' : ''}${seconds(f.wallMs)} wall, ${seconds(f.cpuMs)} CPU, ${((f.memoryPeakBytes ?? 0) / 2 ** 30).toFixed(1)} GiB`);
  }
  if (summary?.slowest?.length) {
    console.log('\nslowest:');
    for (const f of summary.slowest.slice(0, 10)) console.log(`  ${seconds(f.wallMs).padStart(7)}  cpu ${seconds(f.cpuMs).padStart(7)}  ${f.tier.padEnd(9)} ${f.name}`);
  }
  const cost = summary?.costUsd ? `$${summary.costUsd.total.toFixed(3)} (cpu $${summary.costUsd.cpu.toFixed(3)}, memory $${summary.costUsd.memory.toFixed(3)}, disk $${summary.costUsd.disk.toFixed(3)})` : '?';
  console.log('');
  if (summary) {
    console.log(`ci-run: ${spec.commit.slice(0, 12)} tier ${spec.tier}: ${summary.pass} pass / ${summary.fail} fail of ${summary.files} files on ${spec.shards} shards × ${spec.jobs} jobs`);
    console.log(`ci-run: wall ${seconds(summary.wallMs + uploadMs)} (upload ${seconds(uploadMs)}, run ${seconds(summary.wallMs)}, shard setup median ${seconds(summary.setupMsMedian)}) · test CPU ${(summary.testCpuSeconds / 60).toFixed(1)} min · VM busy ${(summary.vmBusySeconds / 60).toFixed(1)} min, steal ${(summary.vmStealSeconds / 60).toFixed(1)} min · cost ~${cost}`);
  }
  if (summary?.runnerOverlay) console.log('ci-run: note: this commit predates sharded runs; it ran under the CI image\'s tests/unit/run-all.mjs and scripts/lib runner');
  console.log(`ci-run: report ${reportPath}`);
  const word = { pass: 'PASS', fail: 'FAIL', error: 'ERROR (not a test verdict)' }[status.verdict] ?? status.verdict;
  console.log(`ci-run: ${word} ${status.runId}`);
  process.exit(status.verdict === 'pass' ? 0 : status.verdict === 'fail' ? 1 : 2);
}

const statusOf = flag('--status');
const cancelOf = flag('--cancel');
if (cancelOf) {
  await api('POST', `/runs/${cancelOf}/cancel`);
  console.log(`ci-run: cancelled ${cancelOf}`);
  process.exit(0);
}
if (statusOf) {
  const t0 = Date.now();
  await verdict(await wait(statusOf, t0), 0);
}

const tier = flag('--tier') ?? 'all';
if (!['fast', 'slow', 'all'].includes(tier)) usage(`--tier must be fast, slow or all`);
const shards = flag('--shards');
const jobs = flag('--jobs');
const only = flag('--only');
const timeoutMs = flag('--timeout');
const label = flag('--label') ?? '';
const positional = argv.filter((a) => !a.startsWith('--'));
if (argv.some((a) => a.startsWith('--') && a !== '--logs')) usage(`unknown flag ${argv.find((a) => a.startsWith('--') && a !== '--logs')}`);
if (positional.length > 1) usage(`one commit, got ${positional.join(' ')}`);
const ref = positional[0] ?? 'HEAD';
let commit;
let tree;
try {
  commit = git('rev-parse', '--verify', `${ref}^{commit}`);
  tree = git('rev-parse', '--verify', `${commit}^{tree}`);
} catch { usage(`not a commit: ${ref}`); }
if (ref === 'HEAD' && git('status', '--porcelain', '--untracked-files=no') !== '') {
  console.log('ci-run: note: the working tree has uncommitted changes; they are not tested');
}

const t0 = Date.now();
console.log(`ci-run: ${commit.slice(0, 12)} (${git('log', '-1', '--format=%s', commit).slice(0, 72)})`);
const uploadMs = await upload(commit, tree);
// The commit's unit files, as run-all discovers them: the runner sizes the
// run from their measured times.
const files = git('ls-tree', '--name-only', `${commit}:tests/unit`).split('\n')
  .filter((name) => name.endsWith('.mjs') && !name.startsWith('_') && name !== 'run-all.mjs');
const started = await (await api('POST', '/runs', {
  body: JSON.stringify({
    commit, tree, tier, label, files,
    ...(shards ? { shards: Number(shards) } : {}),
    ...(jobs ? { jobs: Number(jobs) } : {}),
    ...(timeoutMs ? { timeoutMs: Number(timeoutMs) } : {}),
    ...(only ? { only: only.split(',').filter(Boolean) } : {}),
  }),
  headers: { 'content-type': 'application/json' },
})).json();
console.log(`ci-run: run ${started.runId}: tier ${started.tier}, ${started.shards} shards × ${started.jobs} jobs`);
// Interrupted (Ctrl-C, or GitHub cancelling the job): the run is cancelled
// too, rather than left billing for a verdict nobody waits for.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    console.error(`ci-run: ${signal}: cancelling ${started.runId}`);
    await fetch(`${URL_BASE}/runs/${started.runId}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'user-agent': 'nimbus-ci-run/1' }, signal: AbortSignal.timeout(10_000) }).catch(() => {});
    infra(`interrupted by ${signal}; run ${started.runId} cancelled`);
  });
}
console.log(`ci-run: follow it from anywhere with: bun scripts/ci-run.mjs --status ${started.runId}`);
await verdict(await wait(started.runId, t0), uploadMs);
