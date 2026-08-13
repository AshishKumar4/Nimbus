#!/usr/bin/env bun
// Someone who ran `npm install` gets bash and python. Nothing else.
//
// `core-wasm-runtime-bun.mjs` proves the runtimes execute, but it reaches into
// `packages/worker/wasm/` off a repo checkout and hand-builds the manifest —
// which nobody who installed `@nimbus-sh/core` from npm can do, because the
// wasm is not in that package and the only other copy sits behind an R2
// binding. The runtimes ship as npm packages to close that gap, and this
// proves it closed the only way it can be proven: from a directory that is not
// this repo, out of tarballs, with no path pointing back here.
//
// `npm pack` rather than the workspace, deliberately. A workspace link resolves
// through symlinks and the `workspace`/`bun` export conditions, so it would
// exercise src and a file layout npm never sees. A tarball is what a consumer
// gets, and node picks the `import` condition out of it — dist, the bytes we
// would actually publish.
//
// Needs the network, because installing from npm is the thing under test.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const WORKER = join(REPO, 'packages', 'worker');

/** What we publish, and the manifest each package must turn out to carry. */
const RUNTIMES = [
  { runtime: 'bash', version: '5.2.37' },
  { runtime: 'cpython', version: '3.13.14' },
];

/**
 * The whole of what an embedder writes: a SQLite, a facet host, and the two
 * runtime packages by name. No wasm, no manifest, no digest, no path.
 */
const EMBEDDER = `import { DatabaseSync } from 'node:sqlite';
import { NimbusWorkspace, localFacetHost } from '@nimbus-sh/core';
import bash from '@nimbus-sh/runtime-bash';
import cpython from '@nimbus-sh/runtime-cpython';

// The SqlDatabase port: one method, and a real transaction behind it.
const db = new DatabaseSync(':memory:');
const sql = { exec: (query, ...bindings) => db.prepare(query).all(...bindings) };
const transactions = {
  storage: {
    transactionSync(callback) {
      db.exec('BEGIN');
      try {
        const result = callback();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  },
};

const workspace = await NimbusWorkspace.create({
  sql,
  transactions,
  generation: 1,
  cwd: '/home/user',
  facets: localFacetHost(),
  runtimes: [bash, cpython],
});

const must = async (command) => {
  const result = await workspace.exec(command);
  if (result.exitCode !== 0) {
    throw new Error(command + ' exited ' + result.exitCode + ': ' + result.stderr);
  }
  return result.stdout.trim();
};

const kernel = { uid: 0, gid: 0, groups: [0], umask: 0o022 };
const installed = workspace.vfs.as(kernel).readdir('home/user/.nimbus/runtimes');
console.log('installed: ' + installed.map((entry) => entry.name).sort().join(', '));

console.log('bash: ' + await must('bash -c "echo hi"'));
console.log('bash: ' + await must("bash -c 'echo $BASH_VERSION'"));
// fork, pipe and exec: the pipeline's right half is a BusyBox child process.
console.log('bash: ' + await must("bash -c 'printf \\"x y z\\" | tr \\" \\" -'"));

// Python programs quote with ', so the shell argument can quote with " and
// nothing here needs escaping.
const py = (program) => 'python -c "' + program + '"';
const version = "import sys; print(str(sys.version_info[0]) + '.' + str(sys.version_info[1]))";
const stdlib = "import json, sqlite3; c = sqlite3.connect(':memory:'); "
  + "c.execute('create table t(a)'); c.execute('insert into t values(?)', ('live',)); "
  + "print(json.dumps(c.execute('select a from t').fetchone()[0]))";
const io = "print(open('/home/user/note.txt').read()); "
  + "open('/home/user/from-python.txt', 'w').write('written by python')";

console.log('python: ' + await must(py('print(6*7)')));
console.log('python: ' + await must(py(version)));
console.log('python: ' + await must(py(stdlib)));

// One filesystem, three writers: the host API, python, and bash.
await workspace.fs.writeFile('/home/user/note.txt', 'written by fs');
console.log('python: ' + await must(py(io)));
console.log('shared: ' + await must('bash -c "cat from-python.txt"'));

console.log('EMBEDDER OK');
`;

// The wasm is committed, but a worktree mid-rebuild has none of it.
const sources = ['wasm/bash/bash.async.wasm', 'wasm/python/python.wasm'];
const absent = sources.find((rel) => !existsSync(join(WORKER, rel)));
if (absent) {
  console.log(`runtime-npm-package-consumer: SKIPPED (${absent} not built)`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'nimbus-npm-consumer-'));
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });

try {
  // ── 1. Build the runtime packages from the script that publishes R2 ──────
  const staged = [];
  for (const { runtime, version } of RUNTIMES) {
    const out = join(work, `pkg-${runtime}`);
    run('node', ['scripts/bundle-runtime.mjs', runtime, version, '--npm-package', out], WORKER);
    staged.push(out);
  }
  console.log(`  ok  bundle-runtime.mjs built ${staged.length} runtime packages`);

  // The manifest is the publisher's, not a second one written for npm, and
  // core's own schema is what says so.
  const { parseRuntimeManifest } = await import('../../packages/core/src/runtime/runtime-manifest.ts');
  for (const [i, dir] of staged.entries()) {
    const manifest = parseRuntimeManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')));
    assert.equal(manifest.name, RUNTIMES[i].runtime);
    assert.equal(manifest.version, RUNTIMES[i].version);
    // Every blob sits under the key the manifest names — the R2 object key,
    // which is why the manifest needs no npm-side rewrite to be the same one.
    for (const file of manifest.files) {
      assert.match(file.content, /^blobs\//, `${file.path}: not a content-addressed key`);
      assert.ok(existsSync(join(dir, file.content)), `${file.path}: ${file.content} missing`);
    }
  }
  console.log('  ok  each package carries the publisher manifest and every blob it names');

  // ── 2. Pack what a consumer installs ────────────────────────────────────
  // `--ignore-scripts` so packing core does not rebuild this repo's dist as a
  // side effect. dist matching src is scripts/dist-integrity.mjs's invariant,
  // not this test's, and a test that silently rewrites the tree it is testing
  // is how a stale dist gets papered over.
  const tarballs = [];
  for (const dir of [join(REPO, 'packages', 'core'), ...staged]) {
    const packed = JSON.parse(
      run('npm', ['pack', dir, '--json', '--ignore-scripts', '--pack-destination', work], work),
    );
    tarballs.push(join(work, packed[0].filename));
  }
  console.log(`  ok  npm pack → ${tarballs.map((t) => t.split('/').pop()).join(', ')}`);

  // ── 3. A clean directory, outside this repo, that installs them ──────────
  const consumer = mkdtempSync(join(tmpdir(), 'nimbus-embedder-'));
  writeFileSync(join(consumer, 'package.json'), `${JSON.stringify({
    name: 'nimbus-embedder-acceptance', version: '0.0.0', private: true, type: 'module',
  }, null, 2)}\n`);
  run('npm', ['install', '--no-audit', '--no-fund', ...tarballs], consumer);

  // Unpacked from the tarball, not linked at it: a symlink into the repo would
  // make every claim below a claim about the workspace instead.
  const installedCore = join(consumer, 'node_modules', '@nimbus-sh', 'core');
  assert.ok(existsSync(join(installedCore, 'dist', 'index.js')), 'core installed without a dist');
  assert.ok(
    !readFileSync(join(installedCore, 'package.json'), 'utf8').includes(REPO),
    'the installed core points back into the repo',
  );
  console.log(`  ok  installed into ${consumer}`);

  writeFileSync(join(consumer, 'embed.mjs'), EMBEDDER);

  // ── 4. Run it under plain node, over node:sqlite ─────────────────────────
  const output = run('node', ['embed.mjs'], consumer);
  process.stdout.write(output.replace(/^(?!$)/gm, '  | '));

  assert.match(output, /^installed: bash, cpython$/m);
  assert.match(output, /^bash: hi$/m);
  assert.match(output, /^bash: 5\.2\.37\(1\)-release$/m);
  assert.match(output, /^bash: x-y-z$/m);
  assert.match(output, /^python: 42$/m);
  assert.match(output, /^python: 3\.13$/m);
  assert.match(output, /^python: "live"$/m);
  assert.match(output, /^python: written by fs$/m);
  assert.match(output, /^shared: written by python$/m);
  assert.match(output, /^EMBEDDER OK$/m);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log('runtime-npm-package-consumer: ok');
