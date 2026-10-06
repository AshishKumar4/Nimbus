#!/usr/bin/env bun
// A lifo package's CommonJS command and a node program load their modules
// with one loader (node-compat/cjs-loader.ts). lifo-runtime had its own,
// which knew no "exports" maps, no `node:` prefix and no MODULE_NOT_FOUND
// code, ran no cycle (nothing was cached before it ran), and cached a
// relative require by the name as written, so `./util` from two
// directories was one module. node's `createRequire(filename)` resolves
// from that file's directory.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createLifoCommand } from '../../packages/core/src/substrate/lifo/pkg/lifo-runtime.ts';
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
} finally {
  await ws.close();
}
console.log('lifo-cjs-loader: ok');
