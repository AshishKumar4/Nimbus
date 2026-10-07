#!/usr/bin/env bun
// The behavioral suite, or a part of it, as one CI task against a deployed
// target. Any runner that hands it a checkout with `bun install
// --frozen-lockfile` done (and Chromium, for the browser probes) runs it the
// same way; scripts/ci/remote-probes.mjs runs it on armada.
//
//   NIMBUS_PROBE_TOKEN=<jwt> bun scripts/ci/probes.mjs --out <file> --base <url>
//       [--only a,b] [--skip c,d] [--part K/N] [--jobs J]
//
// The token is the target's, minted for this run with a lifetime bounded by
// it: it is read from the environment, never argv, and every output this
// writes has it replaced by [NIMBUS_PROBE_TOKEN]. --only and --skip are run-all's NIMBUS_PROBE_ONLY and
// NIMBUS_PROBE_SKIP (an empty value selects nothing out); --part is run-all's.
// Probes run CI-strict (--no-retry).
//
// <file> is JSON: { base, part, rows }. rows: one per probe, { name (its path
// under tests/behavioral), exitCode, seconds, output }, then
// { name: 'session-ledger' }, red when a minted session never got its DELETE.
// Exit: 0, every row green; 1, otherwise; 2, not graded (no token, the
// target unreachable, or the runner produced no verdict).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const FLAGS = ['--out', '--base', '--only', '--skip', '--part', '--jobs'];
const flags = {};
for (let i = 0; i < argv.length; i += 2) {
  if (!FLAGS.includes(argv[i]) || argv[i + 1] === undefined) usage(`unexpected ${JSON.stringify(argv[i])}`);
  flags[argv[i].slice(2)] = argv[i + 1];
}
if (!flags.out || !flags.base) usage('--out and --base are required');
function usage(why) {
  console.error(`${why}\nusage: NIMBUS_PROBE_TOKEN=<jwt> bun scripts/ci/probes.mjs --out <file> --base <url> [--only a,b] [--skip c,d] [--part K/N] [--jobs J]`);
  process.exit(2);
}

const token = process.env.NIMBUS_PROBE_TOKEN ?? '';
const scrub = (text) => (token ? text.replaceAll(token, '[NIMBUS_PROBE_TOKEN]') : text);
const rows = [];
const notGraded = (why) => {
  writeFileSync(flags.out, `${JSON.stringify({ base: flags.base ?? null, part: flags.part ?? null, rows: [...rows, { name: 'probes', exitCode: 2, seconds: 0, output: scrub(why) }] })}\n`);
  console.error(`probes: NOT GRADED — ${scrub(why)}`);
  process.exit(2);
};

/** Run a command here, its output passed through scrubbed; resolves to its exit code and output. */
function run(command, args, env) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    child.stdout.on('data', (chunk) => { stdout += chunk; process.stdout.write(scrub(chunk.toString())); });
    child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(scrub(chunk.toString())); });
    child.on('error', (error) => { stderr += `\n${command} could not start: ${error.message}`; });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

if (!token) notGraded('NIMBUS_PROBE_TOKEN is not set: mint one for the target and this run');
try {
  await fetch(flags.base, { signal: AbortSignal.timeout(30_000) });
} catch (error) {
  notGraded(`${flags.base} is unreachable: ${error.message}`);
}

const scratch = mkdtempSync(join(tmpdir(), 'ci-probes-'));
try {
  const report = join(scratch, 'report.json');
  const args = ['tests/behavioral/run-all.mjs', '--no-retry', '--ledger', join(scratch, 'ledger.jsonl'), '--json', report];
  if (flags.part) args.push('--part', flags.part);
  if (flags.jobs) args.push('--jobs', flags.jobs);
  const { code } = await run('bun', args, { ...process.env, BASE: flags.base, NIMBUS_PROBE_ONLY: flags.only ?? '', NIMBUS_PROBE_SKIP: flags.skip ?? '' });
  let verdict;
  try {
    verdict = JSON.parse(readFileSync(report, 'utf8'));
  } catch (error) {
    notGraded(`run-all exited ${code} without a verdict: ${error.message}`);
  }
  rows.push(...verdict.probes.map((probe) => ({
    name: `tests/behavioral/${probe.probe}`, exitCode: probe.code ?? 1, seconds: probe.elapsed, output: scrub(probe.output ?? ''),
  })));
  const { minted, deleted, leaks } = verdict.sessions;
  rows.push({
    name: 'session-ledger', exitCode: leaks.length === 0 ? 0 : 1, seconds: 0,
    output: `${minted} minted, ${deleted} deleted${leaks.map((leak) => `\nleaked: ${leak.probe}: ${leak.sid} (last DELETE: ${leak.last})`).join('')}`,
  });
  writeFileSync(flags.out, `${JSON.stringify({ base: flags.base, part: verdict.part, rows })}\n`);
  process.exitCode = rows.every((row) => row.exitCode === 0) ? 0 : 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
