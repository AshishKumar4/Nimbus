#!/usr/bin/env bun
// Each CommonJS loader's `module` built-in is its own (RTM-2): a lifo
// command that took `require('module').Module` resolves and creates requires
// in its own workspace, however many other loaders load `module` meanwhile.
// The class was one for the whole realm: loading `module` set its statics
// (createRequire, _resolveFilename, _resolveLookupPaths) to that loader's,
// so a command in workspace B that loaded it while one in workspace A was
// awaiting sent A's Module.createRequire and Module._resolveFilename into
// B's filesystem.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createLifoCommand } from '../../packages/core/src/substrate/lifo/pkg/lifo-runtime.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
/** A workspace whose lifo command `t` takes Module, waits `waitMs`, then requires and resolves `./x` through it. */
const workspace = async (name, waitMs) => {
  const harness = createSqliteVfsTestHarness();
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
  const files = {
    '/home/user/pkg/bin/t.js': `
      const { Module } = require('module');
      module.exports = async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, ${waitMs}));
        const required = Module.createRequire(__filename)('./x');
        const resolved = Module._resolveFilename('./x', { filename: __filename });
        await ctx.stdout.write(required + ' ' + resolved + ' ' + (Module._resolveLookupPaths('dep', { filename: __filename }) ?? []).length + '\\n');
        return 0;
      };`,
    '/home/user/pkg/bin/x.js': `module.exports = 'from-${name}';`,
  };
  for (const [path, body] of Object.entries(files)) {
    await ws.fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await ws.fs.writeFile(path, body);
  }
  ws.registry.register('t', createLifoCommand('/home/user/pkg/bin/t.js', ws.filesystem.view({ pid: 900, cred: USER })));
  return ws;
};

const a = await workspace('a', 200);
const b = await workspace('b', 0);
try {
  // A takes its Module and waits; B loads `module` (and runs) meanwhile.
  const [ra, rb] = await Promise.all([a.exec('cd /home/user && t'), new Promise((resolve) => setTimeout(resolve, 50)).then(() => b.exec('cd /home/user && t'))]);
  assert.equal(rb.stderr, '');
  assert.match(rb.stdout, /^from-b \/home\/user\/pkg\/bin\/x\.js \d+\n$/);
  assert.equal(ra.stderr, '', 'A\'s Module is its own after B loaded `module`');
  assert.match(ra.stdout, /^from-a \/home\/user\/pkg\/bin\/x\.js \d+\n$/, 'A\'s Module.createRequire requires from A\'s workspace');
} finally {
  await a.close();
  await b.close();
}
console.log('lifo-module-per-loader: ok');
