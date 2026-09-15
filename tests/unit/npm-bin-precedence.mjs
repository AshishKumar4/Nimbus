#!/usr/bin/env bun
// npm-bin-precedence — a registered builtin beats a node_modules/.bin
// shim, never the other way around.
//
// `wrangler` is the live case: a project can now `npm i wrangler` (the
// retired warn-reject used to keep it out), which materialises
// node_modules/.bin/wrangler — while `nimbus-wrangler` registers a
// builtin answering `wrangler`. If the .bin shim ever won, the real
// wrangler would dispatch instead of the shim and its `wrangler dev`
// would try to boot workerd inside workerd. The fallback resolver
// consults the registry FIRST and only reaches for .bin on a miss;
// this test pins that order.

import assert from 'node:assert/strict';
import { installNpmBinFallbackResolver } from '../../packages/worker/src/shell/npm-bin-entrypoints.ts';
import {
  createNpmBinManifest,
  createNpmBinShim,
  npmBinManifestPath,
} from '../../packages/worker/src/npm/bin-links.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const project = 'home/user/project';
const nodeModules = `${project}/node_modules`;

// A real wrangler install: package on disk + .bin shim + manifest.
const entry = {
  name: 'wrangler',
  packageName: 'wrangler',
  packageVersion: '4.0.0',
  packagePath: `${nodeModules}/wrangler`,
  targetPath: `${nodeModules}/wrangler/bin/wrangler.js`,
};
vfs.mkdir(`${nodeModules}/.bin`, { recursive: true });
vfs.mkdir(entry.packagePath, { recursive: true });
vfs.writeFile(`${nodeModules}/.bin/${entry.name}`, createNpmBinShim(entry));
vfs.writeFile(npmBinManifestPath(nodeModules), JSON.stringify(createNpmBinManifest([entry])));
vfs.mkdir(`${entry.packagePath}/bin`, { recursive: true });
vfs.writeFile(entry.targetPath, 'console.log("real wrangler — must never run")\n');

const commands = new Map();
const registry = {
  register(name, handler) { commands.set(name, handler); },
  resolve(name) { return commands.get(name); },
};

// The nimbus-wrangler builtin. Registration precedes the fallback
// install the same way init.ts orders them.
const BUILTIN = Symbol('builtin-wrangler');
registry.register('wrangler', async () => BUILTIN);
registry.register('node', async () => 0);

installNpmBinFallbackResolver(registry, {
  vfs,
  getCwd: () => `/${project}`,
  processes: new SessionProcessSupervisor(),
  getFacetManager() { throw new Error('unexpected staged artifact'); },
  notifyTerminalEvent() {},
  async runtimeCommandHint() { return null; },
  emitShellExecDone() {},
});

// The builtin wins — the .bin shim is never even consulted.
const handler = await registry.resolve('wrangler');
assert.equal(typeof handler, 'function');
const pid = 4242;
const out = [];
const code = await handler({ pid, args: ['dev'], cwd: `/${project}`, env: {}, stdout: { write(s) { out.push(s); } }, stderr: { write(s) { out.push(s); } } });
assert.equal(code, BUILTIN, 'the builtin handler ran, not the shim');
assert.equal(out.join(''), '', 'the real wrangler bin never dispatches (no stdout)');

// A name with only a .bin entry still resolves through the shim — the
// fallback is a fallback, not a denial.
const lone = {
  name: 'lone-cli',
  packageName: 'lone-cli',
  packageVersion: '1.0.0',
  packagePath: `${nodeModules}/lone-cli`,
  targetPath: `${nodeModules}/lone-cli/cli.js`,
};
vfs.mkdir(lone.packagePath, { recursive: true });
vfs.writeFile(`${nodeModules}/.bin/${lone.name}`, createNpmBinShim(lone));
vfs.writeFile(npmBinManifestPath(nodeModules), JSON.stringify(createNpmBinManifest([entry, lone])));
vfs.writeFile(lone.targetPath, 'console.log("lone")\n');

const loneHandler = await registry.resolve('lone-cli');
assert.equal(typeof loneHandler, 'function', 'a .bin-only name still resolves');
assert.notEqual(loneHandler, handler, 'and it is the shim path, not the builtin');

console.log('npm-bin-precedence: ok');
