#!/usr/bin/env bun
// The behavioral suite, or a part of it, as one CI task against a deployed
// target. Any runner that hands it a checkout with `bun install
// --frozen-lockfile` done (and Chromium, for the browser probes) runs it the
// same way; scripts/ci/remote-probes.mjs runs it on armada.
//
//   NIMBUS_PROBE_TOKEN=<jwt> bun scripts/ci/probes.mjs --out <file> --base <url>
//       [--only a,b] [--skip c,d] [--part K/N] [--jobs J]
//   CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<id> bun scripts/ci/probes.mjs
//       --out <file> --deploy <name> [--only a,b] [--skip c,d] [--jobs J]
//
// --base runs against a target already deployed, with its token, minted for
// this run, from the environment. --deploy first deploys this checkout to
// the throwaway <name> (tests/behavioral/_throwaway-target.mjs up, with a new
// signing secret: the gate, then wrangler's bundle, both here), then runs
// against it with the token that deploy minted, which never leaves this
// process. Credentials come from the environment, never argv, and every
// output this writes has them replaced by their names. --only and --skip are run-all's NIMBUS_PROBE_ONLY and
// NIMBUS_PROBE_SKIP (an empty value selects nothing out); --part is run-all's.
// Probes run CI-strict (--no-retry).
//
// <file> is JSON: { base, part, rows }. rows: with --deploy, first
// { name: 'deploy' }; one per probe, { name (its path under
// tests/behavioral), exitCode, seconds, output }; then
// { name: 'session-ledger' }, red when a minted session never got its DELETE.
// Exit: 0, every row green; 1, otherwise; 2, not graded (no credentials, the
// target unreachable, or the runner produced no verdict).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const FLAGS = ['--out', '--base', '--deploy', '--only', '--skip', '--part', '--jobs'];
const flags = {};
for (let i = 0; i < argv.length; i += 2) {
  if (!FLAGS.includes(argv[i]) || argv[i + 1] === undefined) usage(`unexpected ${JSON.stringify(argv[i])}`);
  flags[argv[i].slice(2)] = argv[i + 1];
}
if (!flags.out || !flags.base === !flags.deploy) usage('--out, and one of --base and --deploy, are required');
function usage(why) {
  console.error(`${why}\nusage: bun scripts/ci/probes.mjs --out <file> (--base <url> | --deploy <name>) [--only a,b] [--skip c,d] [--part K/N] [--jobs J]`);
  process.exit(2);
}

const secrets = { NIMBUS_PROBE_TOKEN: process.env.NIMBUS_PROBE_TOKEN ?? '', CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN ?? '' };
const scrub = (text) => Object.entries(secrets).reduce((out, [name, value]) => (value ? out.replaceAll(value, `[${name}]`) : out), text);
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

if (flags.deploy) {
  if (!secrets.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) notGraded('--deploy needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID');
  const began = Date.now();
  const up = await run('bun', ['tests/behavioral/_throwaway-target.mjs', 'up', '--name', flags.deploy, '--rotate-secrets'], process.env);
  const exported = (name) => new RegExp(`^export ${name}=(.+)$`, 'm').exec(up.stdout)?.[1];
  flags.base = exported('BASE');
  secrets.NIMBUS_PROBE_TOKEN = exported('NIMBUS_PROBE_TOKEN') ?? '';
  rows.push({ name: 'deploy', exitCode: up.code === 0 && flags.base && secrets.NIMBUS_PROBE_TOKEN ? 0 : up.code || 1, seconds: (Date.now() - began) / 1000, output: scrub(up.stderr.slice(-64 * 1024)) });
  if (rows[0].exitCode !== 0) {
    writeFileSync(flags.out, `${JSON.stringify({ base: flags.base ?? null, part: null, rows })}\n`);
    process.exit(1);
  }
}
if (!secrets.NIMBUS_PROBE_TOKEN) notGraded('NIMBUS_PROBE_TOKEN is not set: mint one for the target and this run');
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
  // The suite gets the probe token alone: no Cloudflare credential reaches a probe.
  const env = { ...process.env, BASE: flags.base, NIMBUS_PROBE_TOKEN: secrets.NIMBUS_PROBE_TOKEN, NIMBUS_PROBE_ONLY: flags.only ?? '', NIMBUS_PROBE_SKIP: flags.skip ?? '' };
  delete env.CLOUDFLARE_API_TOKEN;
  const { code } = await run('bun', args, env);
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
