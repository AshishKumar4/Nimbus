#!/usr/bin/env bun
// A staged binding the launch does not carry fails by name.
//
// rolldown, satteri and the Astro compiler run from staged wasm builds
// (staged-bindings.ts) that a launch carries when its closure names them. A
// launch whose closure does not (`nuxt dev`: nuxi loads the project's nuxt,
// and nuxt vite and rolldown, by names they compute) registered none, so
// rolldown's napi-rs loader tried its native candidates, swallowed the wasi
// ones, and failed with "Cannot find module '../rolldown-binding.linux-x64-gnu.node'",
// a file no Worker can load in any case. A require of a staged binding's
// package (its wasm32-wasi build or a platform shard) or of its owner's
// native `.node`, with no binding registered for it, now throws a named
// error, and says so once on stderr: which binding, the version Nimbus
// stages, and why this launch lacks it. With the binding carried, the same
// requires behave as before: the native ones fail plainly and the wasi one
// is answered from the registry.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { processBridge } from './lib/process-bridge.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { SHIMS_STORE_PRELUDE, declareNamespace } from './lib/shims-namespace.mjs';
import { STAGED_BINDINGS } from '../../packages/worker/src/runtime/staged-bindings.ts';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const bridge = processBridge(rawVfs, vfs);
const enc = new TextEncoder();
const dec = new TextDecoder();
const builds = STAGED_BINDINGS.filter((b) => b.name === 'rolldown');
const rolldown = builds[0];
const versions = builds.map((b) => b.version);

const APP = 'home/user/app';
const FILES = {
  [`${APP}/node_modules/rolldown/package.json`]: JSON.stringify({ name: 'rolldown', version: rolldown.version }),
  [`${APP}/node_modules/rolldown/dist/shared/binding.mjs`]: 'export {};\n',
  [`${APP}/node_modules/fsevents/package.json`]: JSON.stringify({ name: 'fsevents', version: '2.3.3' }),
};
// A rolldown at each staged version, and at one Nimbus has no build of, each nested in a package of its own.
const UNBUILT = '9.9.99';
const sharedAt = (version) => `${APP}/node_modules/at-${version}/node_modules/rolldown/dist/shared`;
for (const version of [...versions, UNBUILT]) {
  FILES[`${APP}/node_modules/at-${version}/node_modules/rolldown/package.json`] = JSON.stringify({ name: 'rolldown', version });
  FILES[`${sharedAt(version)}/binding.mjs`] = 'export {};\n';
}
// And rolldown installed under an alias at each staged version (`rd-0@npm:rolldown@<version>`): the folder is
// the alias's, the package.json rolldown's.
const sharedAlias = (i) => `${APP}/node_modules/rd-${i}/dist/shared`;
versions.forEach((version, i) => {
  FILES[`${APP}/node_modules/rd-${i}/package.json`] = JSON.stringify({ name: 'rolldown', version });
  FILES[`${sharedAlias(i)}/binding.mjs`] = 'export {};\n';
});
for (const [path, body] of Object.entries(FILES)) {
  vfs.mkdir('/' + path.slice(0, path.lastIndexOf('/')), { recursive: true });
  vfs.writeFile('/' + path, enc.encode(body));
}
const supervisor = {
  readFile: async (path) => { const bytes = await bridge.readFile(path); return bytes ? dec.decode(bytes) : null; },
  stat: (path) => bridge.stat(path),
  lstat: (path) => bridge.stat(path, { followSymlinks: false }),
  readdir: (path) => bridge.readdir(path),
  exists: async (path) => (await bridge.stat(path)) !== null,
  fsReadRange: (path, offset, length) => bridge.readRange(path, offset, length),
};
const statOf = (size) => ({ type: 'file', size, mode: 0o644, uid: 1000, gid: 1000 });
const dirOf = { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 };
const metadata = {};
const manifest = {};
for (const [path, body] of Object.entries(FILES)) {
  metadata[path] = statOf(body.length);
  const parts = path.split('/');
  for (let i = 3; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    metadata[dir] = dirOf;
    (manifest[dir] ??= new Set()).add(parts[i]);
  }
}
const factory = new Function(
  '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict"; let stdout = "", stderr = "";' + VFS_WRITE_LEDGER_SOURCE + '\n' + SHIMS_STORE_PRELUDE + generateShimsCode()
    + '\n;return { require: (id, dir) => __requireFrom(id, dir), stderrText: () => stderr };',
);
const bundle = Object.fromEntries(Object.entries(FILES));
const { require, stderrText } = (declareNamespace({ metadata, manifest: Object.fromEntries(Object.entries(manifest).map(([k, v]) => [k, [...v]])) }), factory(
  bundle, {}, supervisor, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, '/' + APP, [], {}, `/${APP}/entry.js`, '/' + APP,
));
const shared = `${APP}/node_modules/rolldown/dist/shared`;
const named = (id, from = shared) => {
  let error;
  try { require(id, from); } catch (e) { error = e; }
  assert.ok(error, `${id} is refused`);
  return error;
};

// ── no binding carried: every candidate rolldown's loader tries is named ──
for (const id of ['../rolldown-binding.linux-x64-gnu.node', '@rolldown/binding-linux-x64-gnu', '../rolldown-binding.wasi.cjs', '@rolldown/binding-wasm32-wasi']) {
  if (id === '../rolldown-binding.wasi.cjs') continue; // a file of rolldown's own, which it does not ship: an ordinary miss
  const error = named(id);
  assert.equal(error.code, 'ERR_NIMBUS_BINDING_NOT_CARRIED', `${id}: named, not a missing module (${error.message})`);
  assert.ok(error.message.includes(`rolldown's N-API binding from staged builds of ${versions.join(', ')}`), error.message);
  assert.match(error.message, /does not carry it/);
}
const lines = stderrText().split('\n').filter((line) => line.includes('does not carry it'));
assert.equal(lines.length, 1, `said once on stderr, however many candidates were tried (${JSON.stringify(stderrText())})`);

// A native addon of a package Nimbus stages nothing for is an ordinary miss.
assert.notEqual(named('./fsevents.node', `${APP}/node_modules/fsevents`).code, 'ERR_NIMBUS_BINDING_NOT_CARRIED');

// ── a version Nimbus has no build of is named as that, with the versions it has ──
{
  const error = named('@rolldown/binding-wasm32-wasi', sharedAt(UNBUILT));
  assert.equal(error.code, 'ERR_NIMBUS_BINDING_VERSION', error.message);
  assert.ok(error.message.includes(`staged wasm builds of ${versions.join(', ')}`) && error.message.includes(`rolldown@${UNBUILT}`)
    && error.message.includes(`npm install rolldown@${versions.at(-1)}`), error.message);
}

// ── the binding carried: the native candidates fail plainly, the wasi one is the build of the owner's version ──
const built = new Map(builds.map((b) => [b.version, { owner: 'rolldown', version: b.version, exports: { build: b.version } }]));
globalThis.__nimbusStagedBindings = new Map([['@rolldown/binding-wasm32-wasi', built]]);
assert.notEqual(named('../rolldown-binding.linux-x64-gnu.node').code, 'ERR_NIMBUS_BINDING_NOT_CARRIED');
assert.notEqual(named('@rolldown/binding-linux-x64-gnu').code, 'ERR_NIMBUS_BINDING_NOT_CARRIED');
for (const build of builds) {
  assert.deepEqual(require('@rolldown/binding-wasm32-wasi', sharedAt(build.version)), { build: build.version }, `rolldown@${build.version} is answered with its own build`);
}
assert.equal(named('@rolldown/binding-wasm32-wasi', sharedAt(UNBUILT)).code, 'ERR_NIMBUS_BINDING_VERSION', 'a carried launch names an unbuilt version too');
// Each alias is the owner by its package.json, whatever its folder is called: its own version's build.
versions.forEach((version, i) => {
  assert.deepEqual(require('@rolldown/binding-wasm32-wasi', sharedAlias(i)), { build: version }, `rd-${i}@npm:rolldown@${version} is answered with its own build`);
});
// One build carried, and the owner at another staged version: the next launch carries it.
globalThis.__nimbusStagedBindings = new Map([['@rolldown/binding-wasm32-wasi', new Map([[rolldown.version, built.get(rolldown.version)]])]]);
if (builds.length > 1) {
  const error = named('@rolldown/binding-wasm32-wasi', sharedAt(builds[1].version));
  assert.ok(error.message.includes(`this launch carries ${rolldown.version}, not ${builds[1].version}`), error.message);
}
assert.deepEqual(require('@rolldown/binding-wasm32-wasi', shared), { build: rolldown.version }, 'the build carried answers its own version');

console.log('staged-binding-not-carried: ok');
