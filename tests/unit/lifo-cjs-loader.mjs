#!/usr/bin/env bun
// A lifo package's CommonJS command and a node program load their modules
// with one loader (node-compat/cjs-loader.ts). lifo-runtime had its own,
// which knew no "exports" maps, no `node:` prefix and no MODULE_NOT_FOUND
// code, ran no cycle (nothing was cached before it ran), and cached a
// relative require by the name as written, so `./util` from two
// directories was one module. node's `createRequire(filename)` resolves
// from that file's directory, a file: URL's path decoded (`a%20b` is `a b`).
// A lifo command's entry runs from the source the runtime already read,
// as it did before the loaders were one: a dependency-free entry on a
// mount that has no synchronous reads (an async-only backend) runs, where
// a second, synchronous read of it is EAGAIN.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createLifoCommand } from '../../packages/core/src/substrate/lifo/pkg/lifo-runtime.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
try {
  const files = {
    '/home/user/pkg/package.json': JSON.stringify({ name: 'lifo-pkg-t', lifo: { commands: { t: 'bin/t.js' } } }),
    '/home/user/pkg/bin/t.js': `
      const a = require('./a');
      const b = require('../lib/b');
      const dep = require('@sc/dep');
      const sub = require('@sc/dep/feature');
      const path = require('node:path');
      const cycle = require('./cycle-1');
      let missing = '';
      try { require('./nope'); } catch (e) { missing = e.code; }
      module.exports = async (ctx) => {
        await ctx.stdout.write([a.name, b.name, b.util, dep, sub, path.basename('/x/y.z'), cycle, missing].join(' ') + '\\n');
        return 3;
      };`,
    '/home/user/pkg/bin/a.js': "module.exports = { name: 'a', util: require('./util') };",
    '/home/user/pkg/bin/util.js': "module.exports = 'bin-util';",
    '/home/user/pkg/lib/b.js': "module.exports = { name: 'b', util: require('./util') };",
    '/home/user/pkg/lib/util.js': "module.exports = 'lib-util';",
    '/home/user/pkg/bin/cycle-1.js': "exports.one = 1; const two = require('./cycle-2'); module.exports = 'cycle:' + two;",
    '/home/user/pkg/bin/cycle-2.js': "module.exports = String(require('./cycle-1').one);",
    '/home/user/pkg/node_modules/@sc/dep/package.json': JSON.stringify({ name: '@sc/dep', exports: { '.': { require: './cjs.js', import: './esm.mjs' }, './feature': './f.js' } }),
    '/home/user/pkg/node_modules/@sc/dep/cjs.js': "module.exports = 'dep-cjs';",
    '/home/user/pkg/node_modules/@sc/dep/f.js': "module.exports = 'dep-feature';",
    '/home/user/pkg/lib/req.js': "module.exports = require('module').createRequire(__filename)('./util');",
  };
  for (const [path, body] of Object.entries(files)) {
    await ws.fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await ws.fs.writeFile(path, body);
  }
  ws.registry.register('t', createLifoCommand('/home/user/pkg/bin/t.js', ws.filesystem.view({ pid: 900, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } })));
  const r = await ws.exec('cd /home/user && t');
  assert.equal(r.stderr, '');
  assert.equal(r.exitCode, 3, 'the command function returns the status');
  assert.equal(r.stdout, 'a b lib-util dep-cjs dep-feature y.z cycle:1 MODULE_NOT_FOUND\n');

  const node = await ws.exec(`cd /home/user && node -e "console.log(require('module').createRequire('/home/user/pkg/bin/x.js')('./util'), require('/home/user/pkg/lib/req.js'))"`);
  assert.equal(node.stderr, '');
  assert.equal(node.stdout, 'bin-util lib-util\n');

  await ws.fs.mkdir('/home/user/a b', { recursive: true });
  await ws.fs.writeFile('/home/user/a b/util.js', "module.exports = 'spaced-util';");
  await ws.fs.writeFile('/home/user/a b/main.js', "const { createRequire } = require('module'); console.log(createRequire(new URL('file://' + __filename))('./util'), createRequire('file:///home/user/a%20b/main.js')('./util'));");
  const spaced = await ws.exec(`cd /home/user && node 'a b/main.js'`);
  assert.equal(spaced.stderr, '');
  assert.equal(spaced.stdout, 'spaced-util spaced-util\n', 'a file: URL names its decoded path');

  // An entry on a mount with no synchronous reads: it runs from the source the runtime read.
  const backing = new MemoryVFS({ uid: 0, gid: 0 });
  backing.writeFile('/cmd.js', new TextEncoder().encode('module.exports = async (ctx) => { await ctx.stdout.write("from an async mount\\n"); return 4; };'));
  const asyncOnly = new Proxy(backing, {
    get(target, key) {
      if (key === 'sync') return undefined;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has(target, key) { return key !== 'sync' && key in target; },
  });
  ws.filesystem.vfs.mount('/async', asyncOnly);
  ws.registry.register('asynccmd', createLifoCommand('/async/cmd.js', ws.filesystem.view({ pid: 900, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } })));
  const fromAsync = await ws.exec('asynccmd');
  assert.equal(fromAsync.stderr, '');
  assert.deepEqual([fromAsync.stdout, fromAsync.exitCode], ['from an async mount\n', 4]);
} finally {
  await ws.close();
}
console.log('lifo-cjs-loader: ok');
