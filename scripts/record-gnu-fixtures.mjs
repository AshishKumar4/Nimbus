#!/usr/bin/env bun
// Record tests/fixtures/gnu/<tool>.json from the reference tools on this host.
//
// A fixture is its own spec: `inputs` (files, base64) and `cases` (each an
// argument list, where `%T` stands for the tool so a case can pipe into it,
// and optionally `after`, the files whose bytes are recorded once it ran).
// This script runs every case with the reference tool in a fresh directory
// holding the inputs, LANG=en_US.UTF-8 and no standard input, and writes back
// what it printed (latin1, one character per byte), its exit status and the
// `after` files. tests/unit/gnu-tools-match.mjs replays them through the
// workspace shell.
//
// Run these through the host's bounded test launcher:
//   bun scripts/record-gnu-fixtures.mjs            every fixture
//   bun scripts/record-gnu-fixtures.mjs sort tr    the named tools
//   bun scripts/record-gnu-fixtures.mjs --update   also where the reference's version changed
//
// The reference runs under the tool's own name (a link in a private bin
// directory first on PATH), so its messages name it as ours do; a case can
// then fold stderr in with 2>&1. A fixture records the reference's version:
// a host with another version refuses to re-record it unless --update, and
// the locale must really be UTF-8 (`locale charmap`), or nothing is recorded.
// Each child has 30 seconds and 8 MiB of combined output. Infrastructure
// failures abort recording; normal nonzero exits remain reference results.
//
// The reference is GNU coreutils/grep/sed/diffutils (util-linux for rev); the host
// may install coreutils as gnu<tool> beside another implementation.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { runBoundedProcess } from './lib/bounded-process.mjs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const FIXTURES = new URL('../tests/fixtures/gnu/', import.meta.url).pathname;
const REFERENCE = {
  grep: /\(GNU grep\)/,
  sed: /\(GNU sed\)/,
  rev: /util-linux/,
  awk: /GNU Awk/,
  diff: /GNU diffutils/,
};

async function oracle(command, args, options, label) {
  const run = await runBoundedProcess(command, args, {
    timeoutMs: options.timeoutMs ?? 30_000,
    maxOutputBytes: options.maxOutputBytes ?? 8 * 1024 * 1024,
    encoding: null, name: label,
    cwd: options.cwd, env: options.env ?? process.env,
  });
  if (run.outputTruncated || run.signal || run.code === null || run.code === undefined || run.reason) {
    throw new Error(`${label}: ${run.outputTruncated ? 'output limit exceeded' : run.reason || run.signal || 'no exit status'}`);
  }
  return run;
}

async function reference(tool, options) {
  const want = REFERENCE[tool] ?? /GNU coreutils/;
  for (const candidate of [`/usr/bin/gnu${tool}`, `/usr/bin/${tool}`, `/bin/${tool}`]) {
    if (!existsSync(candidate)) continue;
    const version = await oracle(candidate, ['--version'], options, `${tool} --version`);
    if (version.code !== 0) throw new Error(`${tool} --version: exit ${version.code}`);
    const stdout = version.stdout.toString('utf8');
    const first = (stdout || version.stderr.toString('utf8')).split('\n')[0];
    if (want.test(first) || want.test(stdout)) return { path: candidate, version: first.trim() };
  }
  throw new Error(`no reference ${tool} on this host (wanted ${want})`);
}

const ENV = (dir, bin) => ({ PATH: `${bin}:${process.env.PATH}`, HOME: dir, LANG: 'en_US.UTF-8', TZ: 'UTC' });

export async function assertUtf8Locale(options = {}) {
  const charmap = await oracle('locale', ['charmap'], { ...options, env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8' } }, 'locale charmap');
  if (charmap.code !== 0) throw new Error(`locale charmap: exit ${charmap.code}`);
  if (charmap.stdout.toString('utf8').trim() !== 'UTF-8') {
    throw new Error(`LANG=en_US.UTF-8 gives charmap ${JSON.stringify(charmap.stdout.toString('utf8').trim())}: generate the en_US.UTF-8 locale first`);
  }
}

export async function recordFixture(file, options = {}) {
  const fixture = JSON.parse(readFileSync(file, 'utf8'));
  const ref = await reference(fixture.tool, options);
  const was = (fixture.recorded ?? '').split(',')[0];
  if (was !== '' && was !== ref.version && !options.update) {
    throw new Error(`${file} was recorded with ${JSON.stringify(was)}; this host has ${JSON.stringify(ref.version)} (re-record with --update)`);
  }
  const root = options.tempRoot ?? tmpdir();
  const bin = mkdtempSync(join(root, 'gnu-bin-'));
  let replacement;
  try {
    symlinkSync(ref.path, join(bin, fixture.tool));
    for (const [index, c] of fixture.cases.entries()) {
      const dir = mkdtempSync(join(root, `gnu-${fixture.tool}-`));
      try {
        for (const [name, base64] of Object.entries(fixture.inputs)) {
          if (name.includes('/')) mkdirSync(join(dir, name.slice(0, name.lastIndexOf('/'))), { recursive: true });
          writeFileSync(join(dir, name), Buffer.from(base64, 'base64'));
        }
        const line = c.args.includes('%T') ? c.args.replaceAll('%T', fixture.tool) : `${fixture.tool} ${c.args}`;
        const run = await oracle('sh', ['-c', line], {
          ...options, cwd: dir, env: ENV(dir, bin),
        }, `${basename(file)} case ${index + 1}`);
        c.stdout = run.stdout.toString('latin1');
        c.exit = run.code;
        if (c.after) {
          for (const name of Object.keys(c.after)) {
            c.after[name] = existsSync(join(dir, name)) ? readFileSync(join(dir, name)).toString('latin1') : null;
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    fixture.recorded = `${ref.version}, LANG=en_US.UTF-8; stdout as latin1 (one char per byte)`;
    replacement = mkdtempSync(join(dirname(file), '.gnu-record-'));
    const staged = join(replacement, 'fixture.json');
    writeFileSync(staged, JSON.stringify(fixture, null, 1) + '\n');
    renameSync(staged, file);
    return { tool: fixture.tool, cases: fixture.cases.length, version: ref.version };
  } finally {
    rmSync(bin, { recursive: true, force: true });
    if (replacement) rmSync(replacement, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const update = process.argv.includes('--update');
  const wanted = new Set(process.argv.slice(2).filter((a) => a !== '--update'));
  await assertUtf8Locale();
  for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort()) {
    if (wanted.size > 0 && !wanted.has(file.replace(/\.json$/, ''))) continue;
    const r = await recordFixture(join(FIXTURES, file), { update });
    console.log(`${r.tool}: ${r.cases} cases (${r.version})`);
  }
}
