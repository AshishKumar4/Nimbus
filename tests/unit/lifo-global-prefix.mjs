#!/usr/bin/env bun
// lifo finds its packages where npm installs them globally: under npm's
// prefix, as npm's configuration resolves it (/usr/local by default, or the
// prefix an .npmrc names), in lib/node_modules. A host that offers lifo
// restores its commands from there after a boot.
//
// Red before: lifo read /usr/lib/node_modules, where npm installs nothing,
// so a package `npm i -g` (or `lifo install`) put under the prefix was not
// listed, could not be removed, and was not restored.

import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createLifoPkgCommand, rehydrateLifoPackages } from '../../packages/core/src/substrate/lifo/commands/system/lifo.ts';
import { CommandRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { writeText } from '../../packages/core/src/vfs/vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
ws.registry.register('lifo', createLifoPkgCommand(ws.registry, undefined, ws.kernel));
/** A lifo package, as npm installs one globally into `modules`. */
const lifoPackage = async (modules, name, command) => {
  await ws.exec(`mkdir -p ${modules}/${name}`);
  await writeText(ws.fs, `${modules}/${name}/package.json`, JSON.stringify({ name, version: '1.0.0', lifo: { commands: { [command]: 'cmd.js' } } }));
  await writeText(ws.fs, `${modules}/${name}/cmd.js`, 'export default async (ctx) => { await ctx.stdout.write("ran\\n"); return 0; };\n');
};

try {
  // ── the default prefix ──
  await lifoPackage('/usr/local/lib/node_modules', 'lifo-pkg-demo', 'demo');
  const listed = await ws.exec('lifo list');
  assert.match(listed.stdout, /lifo-pkg-demo@1\.0\.0\s+\[demo\]/, `lifo lists what npm installed under /usr/local:\n${listed.stdout}${listed.stderr}`);
  const restored = new CommandRegistry();
  await rehydrateLifoPackages(ws.filesystem.view({ pid: 900, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } }), restored, { cwd: '/home/user', env: { HOME: '/home/user' } });
  assert.deepEqual(restored.list(), ['demo'], 'a lifo host restores it after a boot');
  const removed = await ws.exec('lifo remove demo');
  assert.equal(removed.exitCode, 0, removed.stderr);
  assert.equal((await ws.exec('test -e /usr/local/lib/node_modules/lifo-pkg-demo')).exitCode, 1, 'lifo remove removes it from the prefix');
  console.log('  ✓ lifo lists, restores and removes packages under npm\'s default prefix');

  // ── a prefix the user's .npmrc names ──
  await writeText(ws.fs, '/home/user/.npmrc', 'prefix=/home/user/.npm-global\n');
  await lifoPackage('/home/user/.npm-global/lib/node_modules', 'lifo-pkg-mine', 'mine');
  const mine = await ws.exec('lifo list', { cwd: '/home/user' });
  assert.match(mine.stdout, /lifo-pkg-mine@1\.0\.0\s+\[mine\]/, `lifo lists what npm installed under the .npmrc prefix:\n${mine.stdout}${mine.stderr}`);
  const again = new CommandRegistry();
  await rehydrateLifoPackages(ws.filesystem.view({ pid: 901, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } }), again, { cwd: '/home/user', env: { HOME: '/home/user' } });
  assert.deepEqual(again.list(), ['mine'], 'and restores it from there');
  console.log('  ✓ lifo follows a prefix set in ~/.npmrc');
} finally {
  await ws.close();
}
console.log('lifo-global-prefix: ok');
