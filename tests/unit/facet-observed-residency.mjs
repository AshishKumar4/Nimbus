#!/usr/bin/env bun
// A program that could not read a file must not report success, and must not
// have to miss twice.
//
// Every pass that decides what a facet's bundle carries is a proxy for intent
// — a call shape, a package layout, a filename, a size — and each is wrong for
// whatever its author did not anticipate. A `.d.ts` rule stripped TypeScript's
// own standard library; a `.md` rule stripped pi's CHANGELOG; a size rule
// drops the data file that happens to be large. There is no extension rule
// left, and there does not need to be another guess: what a program reads is
// observable.
//
// So the pair of behaviours under test:
//
//   1. A run that ends holding an unanswered synchronous read FAILS, naming
//      the file. The program itself cannot tell — EAGAIN is a code no library
//      branches on, so the catch block it lands in was written for a missing
//      file and the program carries on with a default. That is the silent
//      wrong answer this exists to prevent.
//   2. The supervisor keeps what the miss reported and stages exactly those
//      paths for the same entry next time, bounded only by the bundle's byte
//      budget. Evidence, admitted ahead of every guess.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FacetManager,
  addObservedReads,
  buildPrefetchBundle,
} from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { ExecutionFs } from '../../packages/core/src/shell/execution-fs.ts';
import { SqliteFilesystemAuthority } from '../../packages/core/src/runtime/filesystem-authority.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import {
  CWD_SNAPSHOT_MAX_FILE_BYTES,
} from '../../packages/core/src/constants.ts';

// ── Part 1: admission is a budget, not a policy ─────────────────────────────
//
// The observed-read pass carries no rule about what a file looks like. The
// shapes every previous rule got wrong go in here deliberately.
{
  const files = {
    'home/user/pkg/lib.es2020.full.d.ts': 64 * 1024,
    'home/user/pkg/CHANGELOG.md': 480 * 1024,
    'home/user/pkg/huge.bin': 6 * 1024 * 1024,
    'home/user/pkg/gone.txt': null,
  };
  const vfs = {
    lstat(path) {
      const size = files[path];
      if (size === undefined || size === null) throw new Error(`ENOENT ${path}`);
      return { size, type: 'file' };
    },
    readFile(path) {
      const size = files[path];
      if (size === undefined || size === null) throw new Error(`ENOENT ${path}`);
      return new TextEncoder().encode('x'.repeat(size));
    },
  };
  const bundle = {};
  const requiredPaths = new Set();
  const budgetState = { totalBytes: 0, fileCount: 0 };
  const observed = new Set([
    'home/user/pkg/huge.bin',
    'home/user/pkg/CHANGELOG.md',
    'home/user/pkg/lib.es2020.full.d.ts',
    'home/user/pkg/gone.txt',
  ]);
  const { added } = (await addObservedReads(vfs, observed, bundle, requiredPaths, budgetState));

  assert.equal(added, 3, 'a path that no longer exists is skipped, the rest are staged');
  assert.ok(
    'home/user/pkg/lib.es2020.full.d.ts' in bundle,
    'the suffix that broke tsc must not be able to break it again',
  );
  assert.ok('home/user/pkg/CHANGELOG.md' in bundle, 'nor the suffix that broke pi');
  assert.ok(
    'home/user/pkg/huge.bin' in bundle,
    `an observed read is admitted above the ${CWD_SNAPSHOT_MAX_FILE_BYTES}-byte guess `
      + 'that dropped it, because it is evidence rather than a guess',
  );

  // Evicted enrichment misses again on the next run and the loop never closes,
  // so an observed path is admitted as required rather than as evictable.
  for (const path of Object.keys(bundle)) {
    assert.ok(requiredPaths.has(path), `${path} must not be evictable`);
  }

  // Smallest-first: the budget is shared with every other pass, so ordering by
  // size repairs the most misses per byte spent.
  assert.deepEqual(
    Object.keys(bundle),
    [
      'home/user/pkg/lib.es2020.full.d.ts',
      'home/user/pkg/CHANGELOG.md',
      'home/user/pkg/huge.bin',
    ],
    'observed paths are admitted smallest-first',
  );
  assert.equal(budgetState.fileCount, 3);
}

// A miss on a path the build already staged as speculative, then evicted:
// nuxt's on-change, reached through a dynamic import. Skipping it because it
// is "already in the bundle" left it evictable, so every launch missed again.
// It also brings its static imports, or each of them misses on its own launch.
{
  const h = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(h.sql, h.ctx).as(CRED_KERNEL);
  const dir = 'home/user/app/node_modules/on-change/source';
  vfs.mkdir(dir, { recursive: true });
  vfs.writeFile(`${dir}/index.js`, "import { TARGET } from './constants.js';\nexport default TARGET;\n");
  vfs.writeFile(`${dir}/constants.js`, "import './smart-clone.js';\nexport const TARGET = 1;\n");
  vfs.writeFile(`${dir}/smart-clone.js`, 'export const clone = 1;\n');
  const path = `${dir}/index.js`;
  const bundle = { [path]: vfs.readFileString(path) };
  const requiredPaths = new Set();
  await addObservedReads(vfs, new Set([path]), bundle, requiredPaths, { totalBytes: 0, fileCount: 0 });
  assert.ok(requiredPaths.has(path), 'an observed path already staged is promoted to required');
  for (const dep of [`${dir}/constants.js`, `${dir}/smart-clone.js`]) {
    assert.ok(dep in bundle && requiredPaths.has(dep), `${dep} comes with it, as required`);
  }
}

// A miss inside a package is not the static closure choosing that corner of
// it. nuxt dev missed vue/dist/vue.cjs.js; once that was required, the greedy
// pass skipped vue's main, vue/index.js, which is the file that loads it.
{
  const h = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(h.sql, h.ctx);
  const k = raw.as(CRED_KERNEL);
  const app = 'home/user/vue-app';
  k.mkdir(`${app}/node_modules/vue/dist`, { recursive: true, mode: 0o755 });
  k.writeFile(`${app}/package.json`, JSON.stringify({ dependencies: { vue: '3' } }), { mode: 0o644 });
  k.writeFile(`${app}/entry.js`, "require(process.env.NAME);\n", { mode: 0o644 });
  k.writeFile(`${app}/node_modules/vue/package.json`, JSON.stringify({ name: 'vue', main: 'index.js' }), { mode: 0o644 });
  k.writeFile(`${app}/node_modules/vue/index.js`, "module.exports = require('./dist/vue.cjs.js');\n", { mode: 0o644 });
  k.writeFile(`${app}/node_modules/vue/dist/vue.cjs.js`, 'exports.h = 1;\n', { mode: 0o644 });
  for (const d of ['home/user', app]) k.chown(d, 1000, 1000);
  const fs = new ExecutionFs(new SqliteFilesystemAuthority(raw).openHost({ uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }).fs);
  const state = await buildPrefetchBundle(
    fs, `/${app}/entry.js`, `/${app}`, '', undefined, undefined,
    new Set([`${app}/node_modules/vue/dist/vue.cjs.js`]),
  );
  assert.ok(`${app}/node_modules/vue/dist/vue.cjs.js` in state.bundle, 'the observed module is staged');
  assert.ok(`${app}/node_modules/vue/index.js` in state.bundle, 'the package main that loads it stays staged');
}

// ── Part 2: the whole loop, through a real facet ────────────────────────────

adoptCtxExports({ SupervisorRPC: () => makeSupervisor() });

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = rawVfs.as(CRED_KERNEL);
const dec = new TextDecoder();
let bridge = null;

function makeSupervisor() {
  if (!bridge) {
    bridge = new SqliteRuntimeFsBridge(
      rawVfs.as({ uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }),
      rawVfs,
    );
  }
  return {
    async readFile(path) { const b = await bridge.readFile(path); return b ? dec.decode(b) : null; },
    async stat(path) { return bridge.stat(path); },
    async lstat(path) { return bridge.stat(path, { followSymlinks: false }); },
    async readdir(path) { return bridge.readdir(path); },
    async exists(path) { return (await bridge.stat(path)) !== null; },
    async fsReadRange(path, offset, length) { return bridge.readRange(path, offset, length); },
    async stdout() {}, async stderr() {}, async reportExit() {},
    [Symbol.dispose]() {},
  };
}

// The Worker Loader stands in for workerd: it writes the generated facet out
// and imports it, so the program under test is the real generated runner
// running the real shims, not a stub.
const runnerDir = mkdtempSync(join(tmpdir(), 'nimbus-observed-residency-'));
// Removed however the test ends: its assertions run at top level.
process.on('exit', () => rmSync(runnerDir, { recursive: true, force: true }));
let runnerN = 0;
const env = {
  LOADER: {
    load(config) {
      const file = join(runnerDir, `runner-${runnerN++}.mjs`);
      writeFileSync(file, config.modules['runner.js']);
      const loaded = import(pathToFileURL(file).href);
      const supervisor = config.env?.SUPERVISOR;
      return {
        getEntrypoint: () => ({
          async fetch(request) {
            return (await loaded).default.fetch(request, { SUPERVISOR: supervisor });
          },
          [Symbol.dispose]() {},
        }),
        [Symbol.dispose]() {},
      };
    },
    get() { throw new Error('a one-shot exec never takes the keyed loader path'); },
  },
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\//, '');
      return new Response(
        readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)),
      );
    },
  },
};

// A real session ctx, not a bare `{ id, waitUntil }`: the exec's bundle build
// is paged like a resident launch, and the second run below — with the data
// file admitted — is large enough to cross a turn, whose pump reconciles the
// launch journal off ctx.storage before any launch resumes.
const manager = new FacetManager(
  createFacetCtx(createFacetWorld(() => ({})), 'observed-residency'),
  env, new SessionProcessSupervisor(), new PortRegistry(), processHostFor, {},
);
manager.setVfs(rawVfs, new SqliteFilesystemAuthority(rawVfs));

// A data file too large for the cwd snapshot's per-file bound, reached through
// a path the program computes — so no static scan of the entry can find it
// either. That is the residue: a runtime-computed data path.
const DATA = 'home/user/example-app/dataset.bin';
const DATA_BYTES = CWD_SNAPSHOT_MAX_FILE_BYTES + 4096;
kernel.mkdir('home/user/example-app', { recursive: true, mode: 0o755 });
kernel.writeFile(DATA, 'D'.repeat(DATA_BYTES), { mode: 0o644 });
kernel.chown('home/user', 1000, 1000);
kernel.chown('home/user/example-app', 1000, 1000);

// The premise, asserted rather than assumed: nothing already stages it.
{
  const state = await buildPrefetchBundle(
    new ExecutionFs(new SqliteFilesystemAuthority(rawVfs).openHost({ uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }).fs),
    '/home/user/example-app/entry.js', '/home/user/example-app', '', undefined,
  );
  assert.ok(
    !(DATA in state.bundle),
    'the test is only meaningful while no existing pass stages the file',
  );
}

// The shape that makes this class dangerous: the program treats the failure as
// "the file is not there" and carries on with a default.
const PROGRAM = `
const fs = require('fs');
const target = ['', 'home', 'user', 'example-app', 'data' + 'set.bin'].join('/');
let body = 'FALLBACK';
try { body = fs.readFileSync(target, 'utf8'); } catch (error) { /* looks like ENOENT */ }
console.log('bytes=' + body.length);
`;
const OPTS = { filename: '/home/user/example-app/entry.js', cwd: '/home/user/example-app', captureOutput: true };

const real = { console: globalThis.console, process: globalThis.process, Buffer: globalThis.Buffer };
const restore = () => {
  globalThis.console = real.console;
  globalThis.process = real.process;
  globalThis.Buffer = real.Buffer;
};

const first = await manager.exec(PROGRAM, OPTS);
restore();

assert.equal(
  first.stdout, 'bytes=8\n',
  'the premise: the program swallowed the error and used its default',
);
assert.notEqual(
  first.exitCode, 0,
  'a run whose result rests on a read that failed must not report success',
);
assert.ok(
  first.stderr.includes('/' + DATA),
  `the failure must name the file: ${JSON.stringify(first.stderr)}`,
);
assert.deepEqual(
  first.residencyMisses, [DATA],
  'the supervisor has to be told which path was missing, or it repairs nothing',
);

// Each facet is its own isolate in production; here both evaluations share one
// globalThis, so the ledger is cleared between them rather than inherited.
globalThis.__nimbusVfsResidencyMisses?.clear();

const second = await manager.exec(PROGRAM, OPTS);
restore();

assert.equal(
  second.stdout, `bytes=${DATA_BYTES}\n`,
  'the same command, run again, must read the file it was refused',
);
assert.deepEqual(second.residencyMisses, [], 'and must not miss a second time');
assert.ok(
  !second.stderr.includes('never staged into the process'),
  `a repaired run must not still be failing on residency: ${JSON.stringify(second.stderr)}`,
);

process.stdout.write('facet-observed-residency: all tests passed\n');
