#!/usr/bin/env bun
// `npm uninstall` unlinks the bins the session's installer linked: a global
// package's command is gone from PATH and stays gone. The installer records
// each bin in a manifest (.nimbus-bin-map.json) in the tree's .bin and in
// <prefix>/bin, and a global install links every bin the tree's manifest
// keeps; a staged artifact's bin (opencode-ai's) names no file in the
// package. Before, uninstall removed the package and <prefix>/bin/<bin>
// and left both manifest entries and the .bin shim: the next global install
// linked the removed package's command into <prefix>/bin again. And the
// uninstall changes the tree under the hold its installs take: an install
// that starts while an uninstall is retiring a bin waits for it. Before, the
// uninstall wrote back the manifest it had read, over what the install had
// linked meanwhile: the install's own command, of the same name, was
// unlinked. Run through the hosted install port and the session's
// installer, with core's npm command over them, as the hosted runtime
// composes them.

import assert from 'node:assert/strict';
import { makeFanoutEnv } from './lib/npm-fanout-test-env.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const {
  ensureNpmInstaller, ensureGlobalPrefixDirs, createNpmInstallPort, createNpmCommand, NimbusWorkspace, SessionProcessSupervisor, SqliteVFS,
  CRED_KERNEL, CRED_SESSION_USER, ISOLATE_NETWORK,
} = await importWorkerBundle({
  'packages/worker/src/hosted/services.ts': ['ensureNpmInstaller', 'ensureGlobalPrefixDirs'],
  'packages/worker/src/session/npm-install-port.ts': ['createNpmInstallPort'],
  'packages/core/src/substrate/lifo/commands/system/npm.ts': ['createNpmCommand'],
  'packages/core/src/workspace/nimbus-workspace.ts': ['NimbusWorkspace'],
  'packages/core/src/runtime/session-process-supervisor.ts': ['SessionProcessSupervisor'],
  'packages/core/src/vfs/sqlite-vfs.ts': ['SqliteVFS'],
  'packages/core/src/runtime/os-contracts.ts': ['CRED_KERNEL', 'CRED_SESSION_USER'],
  'packages/core/src/_shared/workspace-network.ts': ['ISOLATE_NETWORK'],
});

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const processes = new SessionProcessSupervisor();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes });
const user = vfs.as(CRED_SESSION_USER);
const kernel = vfs.as(CRED_KERNEL);

// The registry: opencode-ai's bin is a staged artifact (the package's own is a native launcher); tool's is its file.
const packages = {
  'opencode-ai': { resolvedBin: { opencode: 'nimbus-staged:opencode' }, bin: { opencode: 'bin/opencode.exe' }, files: { 'bin/opencode.exe': 'MZ' } },
  tool: { resolvedBin: { tool: 'bin/cli.js' }, bin: { tool: 'bin/cli.js' }, files: { 'bin/cli.js': 'console.log("tool")\n' } },
  // Two packages with one command.
  old: { resolvedBin: { cmd: 'bin/cli.js' }, bin: { cmd: 'bin/cli.js' }, files: { 'bin/cli.js': 'console.log("old")\n' } },
  new: { resolvedBin: { cmd: 'bin/cli.js' }, bin: { cmd: 'bin/cli.js' }, files: { 'bin/cli.js': 'console.log("new")\n' } },
};
const env = makeFanoutEnv({
  root: user,
  NM: 'unused',
  resultFor: (name) => ({
    pkg: {
      name, version: '1.0.0', tarballUrl: `https://registry.invalid/${name}-1.0.0.tgz`, integrity: 'sha512-fixture',
      dependencies: {}, exports: null, main: 'index.js', module: '', bin: packages[name].resolvedBin,
    },
    cacheWrites: [], messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [],
  }),
  manifestFor: (p) => ({ name: p.name, version: p.version, bin: packages[p.name].bin }),
  filesFor: (p) => packages[p.name].files,
});

// The session as hosted/commands.ts hands it to the port: its one installer, made by the session's factory.
const session = {
  npmInstaller: null,
  esbuildService: null,
  sqliteFs: vfs,
  ensureSqliteFs: () => vfs,
  getFilesystemAuthority: () => ws.filesystem,
  ensureBundlePool: () => null,
  processes,
};
const context = { ctx: { id: { toString: () => 'coordinator-do-id' }, storage: { ...harness.ctx.storage, sql: harness.sql } }, env, network: () => ISOLATE_NETWORK };
session.ensureNpmInstaller = () => ensureNpmInstaller(session, context);
session.ensureGlobalPrefixDirs = (prefix, cred) => ensureGlobalPrefixDirs(session, context, prefix, cred);

// The port's namespace, whose views can stop the uninstall's retirement once it has read the tree's bin manifest.
const TREE_MANIFEST = '/usr/local/lib/node_modules/.bin/.nimbus-bin-map.json';
const gate = { armed: false, reached: Promise.withResolvers(), open: Promise.withResolvers() };
const bound = (target, key) => {
  const value = Reflect.get(target, key);
  return typeof value === 'function' ? value.bind(target) : value;
};
const gatedView = (view) => new Proxy(view, {
  get: (target, key) => (key !== 'readFileString' ? bound(target, key) : async (path) => {
    const text = await target.readFileString(path);
    if (gate.armed && path === TREE_MANIFEST) {
      gate.armed = false;
      gate.reached.resolve();
      await gate.open.promise;
    }
    return text;
  }),
});
const files = new Proxy(ws.filesystem, {
  get: (target, key) => (key === 'view' ? (...args) => gatedView(target.view(...args)) : bound(target, key)),
});
ws.registry.register('npm', createNpmCommand(ws.registry, undefined, ws.kernel, { installer: createNpmInstallPort(session, files) }));

const sh = async (line) => {
  const r = await ws.exec(line);
  assert.equal(r.exitCode, 0, `${line}: ${r.stdout}${r.stderr}`);
};
const bins = (dir) => {
  const manifest = `${dir}/.nimbus-bin-map.json`;
  return {
    shims: kernel.readdir(dir).map((entry) => entry.name).filter((name) => !name.startsWith('.')).sort(),
    manifest: kernel.exists(manifest) ? Object.keys(JSON.parse(kernel.readFileString(manifest)).bins).sort() : [],
  };
};
const ON_PATH = 'usr/local/bin';
const IN_TREE = 'usr/local/lib/node_modules/.bin';

try {
  await sh('cd /home/user && npm install -g opencode-ai');
  assert.deepEqual(bins(ON_PATH), { shims: ['opencode'], manifest: ['opencode'] }, 'premise: opencode is on PATH');
  assert.deepEqual(bins(IN_TREE), { shims: ['opencode'], manifest: ['opencode'] });

  await sh('cd /home/user && npm uninstall -g opencode-ai');
  assert.equal(kernel.exists('usr/local/lib/node_modules/opencode-ai'), false, 'the package is gone');
  assert.deepEqual(bins(ON_PATH).shims, [], 'and its command, from PATH');

  await sh('cd /home/user && npm install -g tool');
  assert.deepEqual(bins(ON_PATH).shims, ['tool'], 'the next global install puts its own command on PATH, not the removed one\'s');
  assert.deepEqual(bins(ON_PATH).manifest, ['tool'], 'nor does PATH\'s manifest name it');
  assert.deepEqual(bins(IN_TREE), { shims: ['tool'], manifest: ['tool'] }, 'nor the tree\'s .bin');
  console.log('  a global uninstall unlinks the command; the next global install does not bring it back');

  // A project's: its .bin shim and manifest entry go with it.
  await sh('mkdir -p /home/user/p && cd /home/user/p && echo \'{"name":"p","version":"1.0.0"}\' > package.json && npm install tool opencode-ai');
  assert.deepEqual(bins('home/user/p/node_modules/.bin'), { shims: ['opencode', 'tool'], manifest: ['opencode', 'tool'] }, 'premise');
  await sh('cd /home/user/p && npm uninstall opencode-ai');
  assert.deepEqual(bins('home/user/p/node_modules/.bin'), { shims: ['tool'], manifest: ['tool'] }, 'a project\'s uninstall unlinks the package\'s bins and leaves the rest');
  console.log('  a project\'s uninstall unlinks the package\'s bins and keeps the others\'');

  // An install of `new` while the uninstall of `old`, whose command it has, has read the manifest and not written it.
  await sh('cd /home/user && npm install -g old');
  gate.armed = true;
  const order = [];
  const uninstalling = ws.exec('cd /home/user && npm uninstall -g old').then((r) => { order.push('uninstall'); return r; });
  await gate.reached.promise;
  const installing = ws.exec('cd /home/user && npm install -g new').then((r) => { order.push('install'); return r; });
  // The install runs to its end now unless it waits for the tree: it is given the turns it takes, then the uninstall goes on.
  for (let turn = 0; turn < 2000 && order.length === 0; turn++) await new Promise((resolve) => setImmediate(resolve));
  gate.open.resolve();
  for (const r of await Promise.all([uninstalling, installing])) assert.equal(r.exitCode, 0, r.stdout + r.stderr);
  const owner = (dir) => JSON.parse(kernel.readFileString(`${dir}/.nimbus-bin-map.json`)).bins.cmd?.packageName;
  assert.equal(owner(IN_TREE), 'new', 'the install\'s command is the tree\'s');
  assert.deepEqual(bins(IN_TREE).shims, ['cmd', 'tool'], 'and its shim is there');
  assert.equal(owner(ON_PATH), 'new', 'and on PATH');
  assert.deepEqual(bins(ON_PATH).shims, ['cmd', 'tool']);
  assert.deepEqual(order, ['uninstall', 'install'], 'the install waited for the uninstall');
  console.log('  an install waits for an uninstall changing its tree, and keeps its command');
} finally {
  await ws.close();
}
console.log('npm-uninstall-host-bins: ok');
