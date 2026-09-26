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
//   bun scripts/record-gnu-fixtures.mjs            every fixture
//   bun scripts/record-gnu-fixtures.mjs sort tr    the named tools
//
// The reference is GNU coreutils/grep/sed (util-linux for rev); the host
// may install coreutils as gnu<tool> beside another implementation.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURES = new URL('../tests/fixtures/gnu/', import.meta.url).pathname;
const REFERENCE = {
  grep: /\(GNU grep\)/,
  sed: /\(GNU sed\)/,
  rev: /util-linux/,
  awk: /GNU Awk/,
};

function reference(tool) {
  const want = REFERENCE[tool] ?? /GNU coreutils/;
  for (const candidate of [`/usr/bin/gnu${tool}`, `/usr/bin/${tool}`, `/bin/${tool}`]) {
    if (!existsSync(candidate)) continue;
    const version = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    const first = (version.stdout || version.stderr || '').split('\n')[0];
    if (want.test(first) || want.test(version.stdout ?? '')) return { path: candidate, version: first.trim() };
  }
  throw new Error(`no reference ${tool} on this host (wanted ${want})`);
}

function record(file) {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'));
  const ref = reference(fixture.tool);
  for (const c of fixture.cases) {
    const dir = mkdtempSync(join(tmpdir(), `gnu-${fixture.tool}-`));
    try {
      for (const [name, base64] of Object.entries(fixture.inputs)) {
        if (name.includes('/')) mkdirSync(join(dir, name.slice(0, name.lastIndexOf('/'))), { recursive: true });
        writeFileSync(join(dir, name), Buffer.from(base64, 'base64'));
      }
      const line = c.args.includes('%T') ? c.args.replaceAll('%T', ref.path) : `${ref.path} ${c.args}`;
      const run = spawnSync('sh', ['-c', line], {
        cwd: dir, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, HOME: dir, LANG: 'en_US.UTF-8', TZ: 'UTC' },
      });
      c.stdout = run.stdout.toString('latin1');
      c.exit = run.status;
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
  writeFileSync(join(FIXTURES, file), JSON.stringify(fixture, null, 1) + '\n');
  return { tool: fixture.tool, cases: fixture.cases.length, version: ref.version };
}

const wanted = new Set(process.argv.slice(2));
for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort()) {
  if (wanted.size > 0 && !wanted.has(file.replace(/\.json$/, ''))) continue;
  const r = record(file);
  console.log(`${r.tool}: ${r.cases} cases (${r.version})`);
}
