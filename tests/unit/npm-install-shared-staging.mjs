#!/usr/bin/env bun
// Two npm installs at once in one session go through the session's one
// installer (hosted/services.ts ensureNpmInstaller, which the install port
// asks), so each knows what the other is staging. A mounted project's
// packages are staged in /tmp and then copied onto the mount; each install
// first sweeps the staging directories no install in the session is using.
// Before, the session built an installer for each install, each with its own
// record of what it staged: a second install swept the first's staging
// directory while the first waited on the mount, and the first then reported
// installed a package it never put there. One installer serves both, and
// what each prints is still its own: its progress and its npm log, passed
// with the install, not kept on the installer for the other to take over.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { makeFanoutEnv } from './lib/npm-fanout-test-env.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

// The session's factory reaches `cloudflare:workers`: it is bundled, with what it is handed, as one graph.
const {
  ensureNpmInstaller, createNpmInstallPort, ProcessFiles, SessionProcessSupervisor, SqliteVFS, MemoryVFS, asyncOnly,
  CRED_KERNEL, CRED_SESSION_USER, ISOLATE_NETWORK,
} = await importWorkerBundle({
  'packages/worker/src/hosted/services.ts': ['ensureNpmInstaller'],
  'packages/worker/src/session/npm-install-port.ts': ['createNpmInstallPort'],
  'packages/core/src/runtime/process-files.ts': ['ProcessFiles'],
  'packages/core/src/runtime/session-process-supervisor.ts': ['SessionProcessSupervisor'],
  'packages/core/src/vfs/sqlite-vfs.ts': ['SqliteVFS'],
  'packages/core/src/vfs/memory.ts': ['MemoryVFS'],
  'tests/unit/lib/async-memory-vfs.mjs': ['asyncOnly'],
  'packages/core/src/runtime/os-contracts.ts': ['CRED_KERNEL', 'CRED_SESSION_USER'],
  'packages/core/src/_shared/workspace-network.ts': ['ISOLATE_NETWORK'],
});

const resolved = (name, version) => ({
  pkg: {
    name, version, tarballUrl: `https://registry.invalid/${name}-${version}.tgz`, integrity: 'sha512-fixture',
    dependencies: {}, exports: null, main: 'index.js', module: '', bin: {},
  },
  cacheWrites: [], messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [],
});

const harness = createSqliteVfsTestHarness(new Database(':memory:'));
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const root = vfs.as(CRED_KERNEL);
root.mkdir('tmp');
root.chmod('tmp', 0o1777);
root.mkdir('home/user', { recursive: true, mode: 0o755 });
root.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const files = new ProcessFiles(vfs);
const staged = () => root.readdir('tmp').filter((entry) => entry.name.startsWith('.npm-stage-')).map((entry) => entry.name);

// The mount: install A, once its packages are staged, waits at its node_modules there until B is done.
let arrived;
const atMount = new Promise((resolve) => { arrived = resolve; });
let release;
const released = new Promise((resolve) => { release = resolve; });
let holding = true;
files.vfs.mount('/m', asyncOnly(new MemoryVFS({ uid: 1000, gid: 1000 }), {
  deep: true,
  beforeCall: async (method, [path]) => {
    if (!holding || method !== 'mkdir' || !String(path).endsWith('/a/node_modules') || staged().length === 0) return;
    holding = false;
    arrived(staged());
    await released;
  },
}));
const view = files.view({ pid: 1, cred: CRED_SESSION_USER });
for (const project of ['a', 'b']) {
  await view.mkdir(`/m/${project}`, { recursive: true });
  await view.writeFile(`/m/${project}/package.json`, JSON.stringify({ name: project, version: '1.0.0', dependencies: { [`dep-${project}`]: '1.0.0' } }));
}

// The session as the install port sees it, its installer made by the session's own factory.
const processes = new SessionProcessSupervisor();
const env = makeFanoutEnv({ root: vfs.as(CRED_SESSION_USER), NM: 'unused', resultFor: (name) => resolved(name, '1.0.0') });
const session = {
  npmInstaller: null,
  esbuildService: null,
  sqliteFs: vfs,
  ensureSqliteFs: () => vfs,
  getFilesystemAuthority: () => files,
  ensureBundlePool: () => null,
  ensureGlobalPrefixDirs() {},
  processes,
};
const context = { ctx: { id: { toString: () => 'coordinator-do-id' }, storage: { ...harness.ctx.storage, sql: harness.sql } }, env, network: () => ISOLATE_NETWORK };
session.ensureNpmInstaller = () => ensureNpmInstaller(session, context);
const port = createNpmInstallPort(session, files);

const output = { a: [], b: [] };
const install = (project) => {
  const entry = processes.spawn('npm install', ['npm', 'install'], `/m/${project}`, { cred: CRED_SESSION_USER });
  return port.install({
    projectDir: `/m/${project}`, packages: [], global: false, pid: entry.pid, registry: 'https://registry.invalid',
    onProgress: (line) => output[project].push(line),
    npmLog: (level, line) => { output[project].push(`${level}: ${line}`); },
  });
};

const a = install('a');
const stagingOfA = await atMount;
const b = await install('b');
const leftByB = staged();
release();
const resultA = await a;
assert.deepEqual(b.failed, [], output.b.join('\n'));
assert.deepEqual(resultA.failed, [], output.a.join('\n'));
assert.deepEqual(resultA.installed, ['dep-a@1.0.0'], output.a.join('\n'));
for (const project of ['a', 'b']) {
  assert.equal(await view.exists(`/m/${project}/node_modules/dep-${project}/package.json`), true, `${project}'s package is where its install reported it installed it`);
}
assert.deepEqual(leftByB, stagingOfA, 'B swept nothing A was staging');
assert.deepEqual(staged(), [], 'and each removed its own staging directory');
console.log('  an install sweeps nothing another install in the session is staging');

// Each install's lines are its own; A's last npm log line was written after B finished.
assert.ok(output.a.includes('Copying 1 package into /m/a/node_modules...'), output.a.join('\n'));
assert.ok(output.b.includes('Copying 1 package into /m/b/node_modules...'), output.b.join('\n'));
assert.ok(output.a.every((line) => !line.includes('/m/b')) && output.b.every((line) => !line.includes('/m/a')), JSON.stringify(output));
for (const project of ['a', 'b']) assert.ok(output[project].some((line) => line.startsWith('http: added 1 package in ')), output[project].join('\n'));
console.log('  each install\'s progress and npm log go to its own command');

// A session's first two installs, asking at once while the installer's module loads.
const fresh = { ...session, npmInstaller: null, esbuildService: null };
const [first, second] = await Promise.all([ensureNpmInstaller(fresh, context), ensureNpmInstaller(fresh, context)]);
assert.equal(first, second, 'two installs that ask at once get one installer');
assert.equal(await ensureNpmInstaller(fresh, context), first, 'and so does every install after them');
console.log('  the session has one installer');

console.log('npm-install-shared-staging: ok');
