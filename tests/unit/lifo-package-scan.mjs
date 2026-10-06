#!/usr/bin/env bun
// One walk over node_modules (npm.ts packagesIn) serves lifo list, the boot
// restore, npm ls and local bin registration; one registrar
// (registerLifoManifestCommands) serves lifo install, the boot restore and
// dev links. A package is a directory or a link (an npm-linked or workspace
// package: npm ls lists it, its bins run), a scope's packages count, and
// npm's dot files are not packages. A missing entry is skipped at install
// and boot, and registered by a dev link (it fails when it runs).
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { rehydrateGlobalPackages } from '../../packages/core/src/substrate/lifo/commands/system/lifo.ts';
import { createNpmCommand } from '../../packages/core/src/substrate/lifo/commands/system/npm.ts';
import { CommandRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { linkPackage, loadDevLinks } from '../../packages/core/src/substrate/lifo/pkg/lifo-dev.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
try {
  const sh = async (line) => {
    const r = await ws.exec(line);
    assert.equal(r.exitCode, 0, `${line}: ${r.stderr}`);
    return r.stdout;
  };
  const pkg = async (dir, json, files = {}) => {
    await ws.fs.mkdir(dir, { recursive: true });
    await ws.fs.writeFile(`${dir}/package.json`, JSON.stringify(json));
    for (const [file, body] of Object.entries(files)) await ws.fs.writeFile(`${dir}/${file}`, body);
  };
  const G = '/usr/lib/node_modules';
  await pkg(`${G}/plain`, { name: 'plain', version: '1.0.0', bin: { plainbin: 'cli.js' } }, { 'cli.js': 'x' });
  await pkg(`${G}/@sc/tool`, { name: '@sc/tool', version: '2.0.0', bin: { scbin: 'b.js' } }, { 'b.js': 'x' });
  await pkg(`${G}/lifo-pkg-demo`, { name: 'lifo-pkg-demo', version: '0.1.0', bin: { shadowed: 'n.js' }, lifo: { commands: { demo: 'd.js', gone: 'missing.js' } } }, { 'd.js': 'x', 'n.js': 'x' });
  await pkg('/home/user/linked', { name: 'linked', version: '3.0.0', bin: { linkbin: 'l.js' } }, { 'l.js': 'x' });
  await ws.fs.symlink('/home/user/linked', `${G}/linked`);
  await ws.fs.mkdir(`${G}/.bin`, { recursive: true });
  await ws.fs.writeFile(`${G}/.package-lock.json`, '{}');

  const view = ws.filesystem.view({ pid: 900, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } });
  const registry = new CommandRegistry();
  await rehydrateGlobalPackages(view, registry);
  assert.deepEqual(registry.list(), ['demo', 'linkbin', 'plainbin', 'scbin'], 'boot restore: bins, scoped bins, linked bins, lifo commands with entries; a lifo manifest wins over its bins');

  // npm ls over a project's node_modules: the same walk.
  const N = '/home/user/proj/node_modules';
  await pkg(`${N}/plain`, { name: 'plain', version: '1.0.0' });
  await pkg(`${N}/@sc/tool`, { name: '@sc/tool', version: '2.0.0' });
  await pkg(`${N}/lifo-pkg-demo`, { name: 'lifo-pkg-demo', version: '0.1.0' });
  await ws.fs.symlink('/home/user/linked', `${N}/linked`);
  await ws.fs.mkdir(`${N}/.bin`, { recursive: true });
  await ws.fs.writeFile(`${N}/.package-lock.json`, '{}');
  ws.registry.register('npm', createNpmCommand(ws.registry, undefined, ws.kernel));
  const ls = await sh('cd /home/user/proj && npm ls');
  assert.deepEqual(ls.trim().split('\n').slice(1).map((l) => l.slice(4)).sort(), ['@sc/tool@2.0.0', 'lifo-pkg-demo@0.1.0', 'linked@3.0.0', 'plain@1.0.0']);

  // A dev link registers every declared command; its boot restore, only those with an entry.
  await pkg('/home/user/dev', { name: 'devpkg', lifo: { commands: { here: 'h.js', absent: 'nope.js' } } }, { 'h.js': 'x' });
  // Dev links live in /etc/lifo, root's.
  const root = ws.filesystem.view({ pid: 901, cred: { uid: 0, gid: 0, groups: [0], umask: 0o022 } });
  const linked = new CommandRegistry();
  assert.deepEqual(await linkPackage(root, linked, '/home/user/dev'), ['here', 'absent']);
  const booted = new CommandRegistry();
  await loadDevLinks(root, booted);
  assert.deepEqual(booted.list(), ['here']);
} finally {
  await ws.close();
}
console.log('lifo-package-scan: ok');
