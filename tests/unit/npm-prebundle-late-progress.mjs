#!/usr/bin/env bun
/**
 * An install returns before its pre-bundle does (the bundle runs in the
 * background), so what the pre-bundle says after that belongs to no
 * terminal: not the finished command's (the prompt is back), not the
 * installer's own sink, and not the next install's. And the next install
 * that names no progress sink of its own speaks to the installer's, never to
 * a finished command's.
 */

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { kernelInstaller } from './npm-fanout-test-env.mjs';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness(new Database(':memory:'));
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const root = vfs.as(CRED_KERNEL);
root.mkdir('app/node_modules/pkg', { recursive: true });
root.mkdir('app/src', { recursive: true });
root.writeFile('app/package.json', JSON.stringify({ name: 'app', dependencies: { pkg: '1.0.0' } }));
root.writeFile('app/node_modules/pkg/package.json', JSON.stringify({ name: 'pkg', version: '1.0.0', main: 'index.js' }));
root.writeFile('app/node_modules/pkg/index.js', 'export const x = 1;\n');
root.writeFile('app/src/main.js', "import { x } from 'pkg';\nconsole.log(x);\n");

const resolved = {
  pkg: {
    name: 'pkg', version: '1.0.0', tarballUrl: 'https://registry.invalid/pkg-1.0.0.tgz', integrity: 'sha512-fixture',
    dependencies: {}, exports: null, main: 'index.js', module: '', bin: {},
  },
  deps: {}, peerDeps: {}, optionalDeps: {}, cacheWrites: [], messages: [], events: [],
  packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [],
};
const env = {
  LOADER: { get() { return { getEntrypoint: () => ({ execute: async () => resolved }) }; } },
  NIMBUS_SESSION: {
    idFromName: (name) => ({ toString: () => name, name }),
    idFromString: (id) => ({ toString: () => id, name: id }),
    get: () => ({ supervisorOp: async (envelope) => ({ results: envelope.args[1].map(() => resolved) }) }),
  },
};

// The bundle pool holds every pre-bundle until the test lets it finish.
let release;
const held = new Promise((resolve) => { release = resolve; });
// Each pre-bundle's last line, wherever it is said, settles the next of these.
const finishes = [];
const finished = (n) => (finishes[n] ??= Promise.withResolvers()).promise;
let completions = 0;
const completed = () => (finishes[completions] ??= Promise.withResolvers()).resolve(completions++);
const hear = (sink) => (msg) => {
  if (/Pre-bundle complete/.test(msg)) completed();
  sink.push(msg);
};
const bundlePool = {
  acquire: async () => ({
    prebundle: async (spec) => {
      await held;
      return { specifier: spec.specifier, ok: false, esmCode: '', errorText: 'held', elapsed: 0, warnings: [] };
    },
  }),
};

const installerSink = [];
const installer = kernelInstaller(vfs, harness.sql, {
  env,
  ctx: { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage },
  esbuild: new EsbuildService(undefined, {}),
  bundlePool,
  onProgress: hear(installerSink),
});

const originalLog = console.log;
console.log = (...args) => {
  const line = args.join(' ');
  if (line.includes('Pre-bundle complete')) completed();
  if (!line.startsWith('[npm:late]')) originalLog(...args);
};
try {
  const first = [];
  const result = await installer.install('app', { onProgress: hear(first) });
  assert.deepEqual(result.failed, []);
  assert.ok(first.some((msg) => /Pre-bundling 1 modules/.test(msg)), `the pre-bundle starts inside the install:\n${first.join('\n')}`);

  const heardByFirst = first.length;
  release();
  await finished(0);
  assert.ok(!first.some((msg) => /Pre-bundle complete/.test(msg)), "the finished command's terminal hears nothing after it returned");
  assert.ok(!installerSink.some((msg) => /Pre-bundle complete/.test(msg)), "nor does the installer's own sink");

  const before = installerSink.length;
  const second = await installer.install('app');
  assert.deepEqual(second.failed, []);
  await finished(1);
  assert.ok(installerSink.length > before, "an install with no sink of its own speaks to the installer's");
  assert.equal(first.length, heardByFirst, `and never to a finished command's:\n${first.slice(heardByFirst).join('\n')}`);
} finally {
  console.log = originalLog;
}

console.log('npm-prebundle-late-progress: ok');
