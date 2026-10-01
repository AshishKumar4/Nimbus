#!/usr/bin/env bun
// Code a program produces while it runs is interpreted in the launch that
// produced it, and compiles in the next launch of the same command.
//
// A Worker compiles code only from the module map it was launched with, and
// that map cannot grow (core/_shared/commonjs-cell.ts, RUNTIME CODE). So the
// two shapes of runtime code — text handed to a Function constructor (a module
// runner's `new AsyncFunction`) and a file written, then required (Vite's
// `.vite-temp/vite.config.ts.timestamp-<now>.mjs`) — run in the interpreter
// the launch's map carries, reach the supervisor in the run's report, and are
// carried by content into the next launch: the file under a name it has never
// had before included, which is why the key is the text and not the path.
// The next launch may be served by a fresh isolate — the session's was
// evicted or hibernated in between — so what was learned is kept in the
// session's storage, and the second launch here runs on a new manager over
// the same storage.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { processBridge, processFiles } from './lib/process-bridge.mjs';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { _rpcFsAcquire, _rpcFsList, _rpcFsReadBatch } from '../../packages/worker/src/session/rpc.ts';
import { attachSupervisorOps } from './session-supervisor-ops.mjs';
import { writeModuleSet } from './lib/module-map-bundle.mjs';

adoptCtxExports({ SupervisorRPC: () => makeSupervisor() });

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = rawVfs.as(CRED_KERNEL);
const dec = new TextDecoder();
let bridge = null;
const sessionHost = attachSupervisorOps({ sqliteFs: rawVfs, processes: new SessionProcessSupervisor(), ensureSqliteFs() {} });

function makeSupervisor() {
  if (!bridge) bridge = processBridge(rawVfs, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 });
  return {
    async readFile(path) { const b = await bridge.readFile(path); return b ? dec.decode(b) : null; },
    async stat(path) { return bridge.stat(path); },
    async lstat(path) { return bridge.stat(path, { followSymlinks: false }); },
    async readdir(path) { return bridge.readdir(path); },
    async exists(path) { return (await bridge.stat(path)) !== null; },
    async fsReadRange(path, offset, length) { return bridge.readRange(path, offset, length); },
    fsList: (after, limit) => _rpcFsList(sessionHost, after ?? null, limit ?? null),
    fsReadBatch: (requests) => _rpcFsReadBatch(sessionHost, requests),
    fsAcquire: (epoch, cursor, options) => _rpcFsAcquire(sessionHost, epoch, cursor, options),
    async stdout() {}, async stderr() {}, async reportExit() {},
    [Symbol.dispose]() {},
  };
}

// The loader writes the generated facet out and imports it: the program runs
// in the real generated runner over the real shims, with the registry
// stand-in of lib/module-map-bundle.mjs compiling its `{ cjs }` modules.
const runnerDir = mkdtempSync(join(tmpdir(), 'nimbus-runtime-code-'));
process.on('exit', () => rmSync(runnerDir, { recursive: true, force: true }));
let runnerN = 0;
const loaded = [];
const env = {
  LOADER: {
    load(config) {
      loaded.push(config);
      const file = writeModuleSet(join(runnerDir, `runner-${runnerN++}`), config.modules, 'runner.js');
      const module = import(pathToFileURL(file).href);
      const supervisor = config.env?.SUPERVISOR;
      return {
        getEntrypoint: () => ({
          async fetch(request) { return (await module).default.fetch(request, { SUPERVISOR: supervisor }); },
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
      return new Response(readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)));
    },
  },
};

// The session's Durable Object storage, which outlives any one isolate.
const sessionStorage = new Map();
function sessionManager() {
  const manager = new FacetManager(
    createFacetCtx(createFacetWorld(() => ({})), 'runtime-code', sessionStorage),
    env, new SessionProcessSupervisor(), new PortRegistry(), processHostFor, {},
  );
  manager.setVfs(rawVfs, processFiles(rawVfs));
  return manager;
}
kernel.mkdir('home/user/app', { recursive: true, mode: 0o755 });
kernel.chown('home/user', 1000, 1000);
kernel.chown('home/user/app', 1000, 1000);

// A fresh file name every run, the same text: Vite's temp config shape. The
// file stays behind, so the next launch also stages the old name by path —
// which must not stand in for the content the fresh name needs.
const PROGRAM = `
const fs = require('fs');
const out = [];
try {
  const add = globalThis.__nimbusRuntimeCode.compileFunction('async', ['a', 'b'], 'return a + b + (typeof module);');
  out.push('fn=' + add.name + ':' + add.constructor.name);
  add(2, 3).then((v) => console.log('async=' + v));
} catch (e) { out.push('fn-error=' + e.code); }
const temp = '/home/user/app/.temp/config.timestamp-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.js';
fs.mkdirSync('/home/user/app/.temp', { recursive: true });
fs.writeFileSync(temp, 'module.exports = { answer: 42, file: __filename.endsWith(".js") };\\n');
try {
  out.push('file=' + JSON.stringify(require(temp)));
} catch (e) { out.push('file-error=' + e.code); }
console.log(out.join(' '));
`;
const OPTS = { filename: '/home/user/app/entry.js', cwd: '/home/user/app', captureOutput: true };

const real = { console: globalThis.console, process: globalThis.process, Buffer: globalThis.Buffer };
const restore = () => {
  globalThis.console = real.console;
  globalThis.process = real.process;
  globalThis.Buffer = real.Buffer;
};

// What the constructor builds, reading globals only; the file runs under its new name.
const EXPECTED = 'fn=anonymous:AsyncFunction file={"answer":42,"file":true}\nasync=5undefined\n';

// ── First launch: both are produced here, so the interpreter runs them ─────
const first = await sessionManager().exec(PROGRAM, OPTS);
restore();
assert.equal(first.stdout, EXPECTED, `both run in the launch that produced them: ${JSON.stringify(first)}`);
assert.deepEqual(
  first.runtimeCode.map((entry) => entry.kind).sort(), ['async', 'module'],
  'the run reports what its map did not carry',
);
assert.ok(
  !Object.keys(loaded.at(-1).modules).some((name) => name.startsWith('gen/')),
  'the premise: the first launch carried no runtime code',
);
globalThis.__nimbusModuleMisses?.clear();

// ── Next launch of the same command, after the isolate was evicted: both
// compile, from the map ─────────────────────────────────────────────────────
const second = await sessionManager().exec(PROGRAM, OPTS);
restore();
assert.equal(second.stdout, EXPECTED, `the staged modules answer the same: ${JSON.stringify(second)}`);
assert.deepEqual(second.runtimeCode, [], 'and nothing is missed a second time');
const genModules = Object.keys(loaded.at(-1).modules).filter((name) => name.startsWith('gen/'));
assert.equal(genModules.length, 2, 'the launch carries each piece of runtime code once, by its key');
assert.ok(genModules.every((name) => /^gen\/[0-9a-f]{64}\.js$/.test(name)), 'named by content key');

process.stdout.write('facet-runtime-code: all tests passed\n');
