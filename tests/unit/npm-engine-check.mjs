#!/usr/bin/env bun
// npm's engine check (arborist build-ideal-tree #checkEngineAndPlatform, by
// npm-install-checks' own checkEngine): the project, unless it declares
// devEngines, and every package the tree requires (an optional one is not
// checked) against this runtime's Node and npm. npm warns of each mismatch,
// in its exact text; under --engine-strict (an .npmrc's, as `sv create`
// writes) the first fails the install, which changes nothing; --force checks
// npm alone. Red before: engine-strict was refused as unsupported, and no
// engine was ever checked or warned of.
//
// The text is real npm 10.9.8's (an install of a package whose engines say
// `node: '>=99'`), with this runtime's versions.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { NODE_VERSION, NPM_VERSION } from '../../packages/core/src/constants.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { npmEngineLines } from '../../packages/core/src/substrate/lifo/commands/system/npm-log.ts';
import { createNpmCommand } from '../../packages/core/src/substrate/lifo/commands/system/npm.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { kernelInstaller, makeFanoutEnv } from './npm-fanout-test-env.mjs';

const PROJ = 'app';
const NM = `${PROJ}/node_modules`;
const FAR = { node: '>=99' };

function resolvedResult(name, version, overrides = {}) {
  return {
    pkg: {
      name, version, tarballUrl: `https://registry.invalid/${name}-${version}.tgz`, integrity: 'sha512-fixture',
      dependencies: {}, exports: null, main: 'index.js', module: '', bin: {}, ...overrides,
    },
    cacheWrites: [], messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [],
  };
}

function makeInstaller(pkgJson, packages) {
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = vfs.as(CRED_KERNEL);
  root.mkdir(NM, { recursive: true });
  root.writeFile(`${PROJ}/package.json`, JSON.stringify(pkgJson));
  const env = makeFanoutEnv({ root, NM, resultFor: (name) => packages[name] ?? null });
  const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
  return { installer: kernelInstaller(vfs, harness.sql, { env, ctx, onProgress: () => {} }), root };
}

// ── npm's own words ─────────────────────────────────────────────────────
{
  const mismatch = { pkgid: 'dep@1.0.0', required: FAR, current: { node: NODE_VERSION, npm: NPM_VERSION } };
  assert.deepEqual(npmEngineLines(mismatch, false), [
    'npm warn EBADENGINE Unsupported engine {',
    "npm warn EBADENGINE   package: 'dep@1.0.0',",
    "npm warn EBADENGINE   required: { node: '>=99' },",
    `npm warn EBADENGINE   current: { node: '${NODE_VERSION}', npm: '${NPM_VERSION}' }`,
    'npm warn EBADENGINE }',
  ]);
  assert.deepEqual(npmEngineLines(mismatch, true), [
    'npm error code EBADENGINE',
    'npm error engine Unsupported engine',
    'npm error engine Not compatible with your version of node/npm: dep@1.0.0',
    'npm error notsup Not compatible with your version of node/npm: dep@1.0.0',
    'npm error notsup Required: {"node":">=99"}',
    `npm error notsup Actual:   {"npm":"${NPM_VERSION}","node":"${NODE_VERSION}"}`,
  ]);
}

// ── The session's installer checks the tree it plans ─────────────────────
{
  const packages = {
    dep: resolvedResult('dep', '1.0.0', { engines: FAR, dependencies: { deep: '1.0.0' }, optionalDependencies: { maybe: '1.0.0' } }),
    deep: resolvedResult('deep', '1.0.0', { engines: { node: '>=18', npm: '>=99' } }),
    maybe: resolvedResult('maybe', '1.0.0', { engines: FAR }),
    fine: resolvedResult('fine', '1.0.0', { engines: { node: '>=18' } }),
  };
  const app = { name: 'app', version: '1.0.0', engines: FAR, dependencies: { dep: '1.0.0', fine: '1.0.0' } };

  const loose = makeInstaller(app, packages);
  const warned = await loose.installer.install(PROJ);
  assert.deepEqual(warned.failed, []);
  assert.deepEqual(warned.engines.map((m) => m.pkgid), ['app@1.0.0', 'dep@1.0.0', 'deep@1.0.0'],
    'the project, then each required package that excludes this node or npm; the optional one is not checked');
  assert.ok(loose.root.exists(`${NM}/dep/package.json`), 'npm warns, and installs');

  const strict = makeInstaller(app, packages);
  const refused = await strict.installer.install(PROJ, { engineStrict: true });
  assert.deepEqual(refused.failed, ['app@1.0.0'], 'the first mismatch fails the install');
  assert.deepEqual(refused.installed, []);
  assert.equal(strict.root.exists(`${NM}/dep`), false, 'and nothing changed');

  const devEngines = makeInstaller({ ...app, devEngines: { runtime: { name: 'node' } } }, packages);
  assert.deepEqual((await devEngines.installer.install(PROJ)).engines.map((m) => m.pkgid), ['dep@1.0.0', 'deep@1.0.0'],
    'a project that declares devEngines is not checked against its engines');

  const forced = makeInstaller(app, packages);
  assert.deepEqual((await forced.installer.install(PROJ, { force: true })).engines.map((m) => m.pkgid), ['deep@1.0.0'],
    '--force checks npm alone');
}

// ── npm install says it as npm does: a warning of each, or the strict error ──
{
  const harness = createSqliteVfsTestHarness();
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
  const vfs = ws.vfs.as(CRED_KERNEL);
  vfs.mkdir('home/user/proj', { recursive: true });
  vfs.writeFile('home/user/proj/package.json', '{"name":"proj","version":"1.0.0"}');
  const engines = [{ pkgid: 'dep@1.0.0', required: FAR, current: { node: NODE_VERSION, npm: NPM_VERSION } }];
  const asked = [];
  ws.registry.register('npm', createNpmCommand(ws.registry, undefined, ws.kernel, {
    installer: {
      async install(spec) {
        asked.push(spec.engineStrict);
        return spec.engineStrict ? { installed: [], failed: ['dep@1.0.0'], engines } : { installed: ['dep@1.0.0'], failed: [], engines };
      },
    },
  }));
  const warn = await ws.exec('cd /home/user/proj && npm install dep');
  assert.equal(warn.exitCode, 0, warn.stderr);
  assert.ok(warn.stderr.includes(npmEngineLines(engines[0], false).join('\n')), warn.stderr);
  vfs.writeFile('home/user/proj/.npmrc', 'engine-strict=true\n');
  const strict = await ws.exec('cd /home/user/proj && npm install dep');
  assert.equal(strict.exitCode, 1);
  assert.equal(strict.stderr, `${npmEngineLines(engines[0], true).join('\n')}\n`, 'npm\'s error, and nothing else');
  assert.deepEqual(asked, [false, true], 'an .npmrc\'s engine-strict reaches the install');
  const quiet = await ws.exec('cd /home/user/proj && npm install --loglevel=error --no-engine-strict dep');
  assert.ok(!quiet.stderr.includes('EBADENGINE'), 'a log level below warn shows no warning');
}

console.log('npm-engine-check: ok');
