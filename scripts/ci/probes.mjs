#!/usr/bin/env bun
// The behavioral suite, or a part of it, as one CI task against a deployed
// target. Any runner that hands it a checkout with `bun install
// --frozen-lockfile` done (and Chromium, for the browser probes) runs it the
// same way; scripts/ci/remote-probes.mjs runs it on armada.
//
//   NIMBUS_PROBE_TOKEN=<jwt> bun scripts/ci/probes.mjs --out <file> --base <url>
//       [--only a,b] [--skip c,d] [--part K/N] [--jobs J] [--start-by <epoch ms>]
//
// --start-by is the latest a task may start and still finish within its
// limit before the token expires; a task that starts later is not graded,
// never red with the target's 401s.
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
const FLAGS = ['--out', '--base', '--only', '--skip', '--part', '--jobs', '--start-by'];
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

/**
 * A stream's text, scrubbed as it passes: the token can be split across two
 * reads, so the last token-length-minus-one characters wait for the next
 * read (or the end) before they go out.
 */
function scrubbing(write) {
  let held = '';
  const keep = Math.max(0, token.length - 1);
  return {
    push(text) {
      const whole = scrub(held + text);
      held = whole.slice(whole.length - Math.min(keep, whole.length));
      write(whole.slice(0, whole.length - held.length));
    },
    end() {
      write(scrub(held));
      held = '';
    },
  };
}

/** Run a command here, its output passed through scrubbed; resolves to its exit code. */
function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    const out = scrubbing((text) => process.stdout.write(text));
    const err = scrubbing((text) => process.stderr.write(text));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text) => out.push(text));
    child.stderr.on('data', (text) => err.push(text));
    child.on('error', (error) => err.push(`\n${command} could not start: ${error.message}\n`));
    child.on('close', (code) => {
      out.end();
      err.end();
      resolve({ code: code ?? 1 });
    });
  });
}

if (flags['start-by'] !== undefined && Date.now() > Number(flags['start-by'])) {
  notGraded(`this task started at ${new Date().toISOString()}, after ${new Date(Number(flags['start-by'])).toISOString()}: the token could expire before its limit`);
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
