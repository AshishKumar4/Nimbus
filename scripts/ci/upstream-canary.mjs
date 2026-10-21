#!/usr/bin/env bun
// The daily upstream canary: what a new project gets from npm today, on a
// deployed demo. An upstream release can break it with no change on our
// side. On 2026-10-21 vite 8.3.5 needed rolldown 1.2.14, which had no
// staged build, and astro 7.4.2 raised its Node floor past Nimbus's; both
// were found by chance. .github/workflows/upstream-canary.yml runs this
// every day on GitHub's runner, which holds no Cloudflare credential:
//   - the binding demand (lib/binding-demand.mjs missingBindings), which
//     reads only the npm registry;
//   - the probes in lib/upstream.mjs UPSTREAM_PROBES against --base, as an
//     anonymous visitor (the driver's demo-session fallback, no token), all
//     at once. Each mints one session, and production allows 6 a minute
//     from one address (ANON_RATE_LIMITER, apps/hosted-demo/wrangler.jsonc).
//     The probes tests/behavioral/_deferred.mjs excludes do not run, and the
//     rest are graded as the release matrix grades them (lib/matrix.mjs).
// Every run keeps a record (--out): what each probe's install takes,
// resolved from the registry (lib/upstream.mjs resolveInstalls), and the
// demand's chains. A red run names each package whose versions differ from
// the record of the last green run (--last-green). When none of them
// changed, look on our side first.
//
//   bun scripts/ci/upstream-canary.mjs --base <origin> --out <file> [--last-green <file>]
//
// The workflow's log and artifacts are public: every line this prints or
// keeps passes through redactCredentials.
// Exit: 0, green; 1, red; 2, not graded (the registry or the target unread).
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFERRED } from '../../tests/behavioral/_deferred.mjs';
import { redactCredentials } from '../../tests/behavioral/_session-transport.mjs';
import { missingBindings, npmPackument, readOnce } from './lib/binding-demand.mjs';
import { describeReleaseException, gradeMatrix, probeOf } from './lib/matrix.mjs';
import { UPSTREAM_PROBES, resolveInstalls, upstreamChanges } from './lib/upstream.mjs';

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i += 2) {
  if (!['--base', '--out', '--last-green'].includes(argv[i]) || !argv[i + 1]) usage(`unexpected ${JSON.stringify(argv[i])}`);
  flags[argv[i].slice(2)] = argv[i + 1];
}
if (!flags.base || !flags.out) usage('--base and --out are required');
function usage(why) {
  console.error(`${why}\nusage: bun scripts/ci/upstream-canary.mjs --base <origin> --out <file> [--last-green <file>]`);
  process.exit(2);
}

/** The report: printed, and kept for the run's summary page. */
const report = [];
const say = (line) => {
  const text = redactCredentials(line);
  report.push(text);
  console.log(text);
};
const problems = [];

const exceptions = DEFERRED.filter((entry) => entry.probe in UPSTREAM_PROBES);
const probes = Object.keys(UPSTREAM_PROBES).filter((probe) => !exceptions.some((entry) => entry.excluded === true && entry.probe === probe));
const packument = readOnce(npmPackument);

let demand = null;
try {
  demand = await missingBindings({ packument });
} catch (error) {
  problems.push(`the binding demand could not be judged: ${error.message}`);
}
let installs = null;
try {
  installs = await resolveInstalls(Object.fromEntries(probes.map((probe) => [probe, UPSTREAM_PROBES[probe]])), { packument });
} catch (error) {
  problems.push(`the probes' installs could not be resolved: ${error.message}`);
}

const scratch = mkdtempSync(join(tmpdir(), 'upstream-canary-'));
let rows = null;
try {
  const verdict = join(scratch, 'probes.json');
  await relay('bun', ['scripts/ci/probes.mjs', '--anonymous', '--out', verdict, '--base', flags.base, '--only', probes.join(','), '--skip', '', '--part', '1/1', '--jobs', String(probes.length)]);
  // No verdict leaves rows null, which gradeMatrix grades as not graded.
  try {
    rows = JSON.parse(readFileSync(verdict, 'utf8')).rows;
  } catch (error) {
    console.error(`upstream canary: no probe verdict: ${error.message}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
// Graded with the deferrals of these probes alone: another probe's would be red here for not running.
const graded = gradeMatrix([rows && { tasks: [{ task: 'upstream probes', rows }] }], exceptions);

for (const entry of graded.applied) say(describeReleaseException(entry));
// A deferral that applied covers every red row of its probe.
const covered = new Set(graded.applied.filter((entry) => entry.excluded !== true).map((entry) => entry.probe));
const failed = (rows ?? []).filter((row) => row.exitCode !== 0 && !covered.has(probeOf(row.name)));
for (const row of failed) {
  say(`FAIL ${row.name} (exit ${row.exitCode}, ${Math.round(row.seconds)} s)`);
  for (const line of row.output.trimEnd().split('\n').slice(-25)) say(`    ${line}`);
}
for (const missing of demand?.missing ?? []) say(`FAIL binding demand: no staged build of ${missing.key}, which ${missing.via.join(' > ')} installs`);
if (demand?.missing.length > 0) say(`    build them: bun scripts/ci/remote-napi-binding.mjs ${demand.missing.map((missing) => missing.key).join(' ')}`);
for (const problem of [...problems, ...graded.problems]) say(`NOT GREEN: ${problem}`);

const DEMAND = 'binding demand';
const record = {
  at: new Date().toISOString(),
  run: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
  commit: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
  base: flags.base,
  installs: { ...installs, ...(demand ? { [DEMAND]: chainInstall(demand.demanded.map((demanded) => demanded.via)) } : {}) },
  probes: (rows ?? []).map(({ name, exitCode, seconds }) => ({ name, exitCode, seconds })),
  missing: (demand?.missing ?? []).map(({ key, via }) => ({ key, via })),
  problems: [...problems, ...graded.problems],
};
const status = problems.length > 0 || graded.exitCode === 2 ? 2 : graded.exitCode === 1 || demand.missing.length > 0 ? 1 : 0;

// What changed upstream since the last green run, for each red install.
if (status !== 0) {
  const red = [...failed.map((row) => probeOf(row.name)), ...(demand?.missing.length > 0 ? [DEMAND] : [])].filter((name) => name in record.installs);
  const last = flags['last-green'] && existsSync(flags['last-green']) ? JSON.parse(readFileSync(flags['last-green'], 'utf8')) : null;
  if (!last) say(`upstream: no record of a green run${flags['last-green'] ? ` at ${flags['last-green']}` : ''}, so nothing to compare with`);
  else {
    say(`upstream: since the last green run, ${last.at}${last.run ? ` (${last.run})` : ''}:`);
    const changes = upstreamChanges(last.installs, record.installs);
    for (const name of red) {
      const changed = changes[name];
      say(changed === null ? `  ${name}: the last green run has no record of its install`
        : changed.length === 0 ? `  ${name}: no package its record follows changed upstream; look on our side first`
          : `  ${name}: ${changed.map((change) => `${change.name} ${change.before.join(', ') || '(none)'} → ${change.after.join(', ') || '(none)'}`).join('; ')}`);
    }
  }
}
say(`upstream canary: ${status === 0 ? 'green' : status === 1 ? 'red' : 'not graded'}: ${probes.length} probes against ${flags.base}${demand ? `, ${demand.demanded.length} staged bindings in demand` : ''}`);

mkdirSync(dirname(flags.out), { recursive: true });
writeFileSync(flags.out, `${redactCredentials(JSON.stringify(record, null, 2))}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${report.join('\n')}\n\`\`\`\n`);
process.exit(status);

/** `{ name: [version, …] }` of the packages on `chains`, each link `name@version`. */
function chainInstall(chains) {
  const install = {};
  for (const link of chains.flat()) {
    const at = link.lastIndexOf('@');
    const [name, version] = [link.slice(0, at), link.slice(at + 1)];
    install[name] = [...new Set([...(install[name] ?? []), version])].sort();
  }
  return install;
}

/** Run `command`, its output printed line by line through redactCredentials; resolves to its exit code. */
function relay(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const pass = (stream, write) => {
      let held = '';
      stream.setEncoding('utf8');
      stream.on('data', (text) => {
        const lines = (held + text).split('\n');
        held = lines.pop();
        for (const line of lines) write(`${redactCredentials(line)}\n`);
      });
      stream.on('end', () => write(redactCredentials(held)));
    };
    pass(child.stdout, (text) => process.stdout.write(text));
    pass(child.stderr, (text) => process.stderr.write(text));
    child.on('error', (error) => process.stderr.write(`${command} could not start: ${error.message}\n`));
    child.on('close', (code) => resolve(code ?? 1));
  });
}
