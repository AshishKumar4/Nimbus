#!/usr/bin/env bun
// The shell's built-in node, against the host's Node 22 running the same
// program from the same tree:
//
//   - a CommonJS file runs with `this` its module.exports, sloppy or strict;
//   - require('fs').promises is require('fs/promises'), and require('dns')'s
//     is require('dns/promises'): one module each, a patch of one seen
//     through the other;
//   - module.builtinModules, module.isBuiltin and Module's own agree on one
//     inventory of core modules: http2 is one, an npm package is not;
//   - fs.rm and fs.rmSync remove a dangling link, never what it names, and
//     refuse a directory without `recursive` with Node's ERR_FS_EISDIR.
//
// Red before: the wrapper ran with `this` the realm's global; fs, dns and
// their promises were separate objects; Module.isBuiltin read a hand-kept
// list (no http2) while the shim's took rimraf and esbuild for core; fs.rm
// followed a link to ENOENT, and with `force` left the link, and removed an
// empty directory.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const FILES = {
  'this-sloppy.js': 'this.x = 1;\nconsole.log(this === module.exports, module.exports.x);\n',
  'this-strict.js': '"use strict";\nconsole.log(this === module.exports, typeof this);\n',
  'one-fs.js': [
    "const fs = require('fs'), fsp = require('fs/promises'), dns = require('dns'), dnsp = require('dns/promises');",
    'fsp.patched = 1; dnsp.patched = 2;',
    "console.log(fs.promises === fsp, fs.promises.patched, dns.promises === dnsp, dns.promises.patched, require('fs').constants === fs.constants);",
  ].join('\n'),
  'builtins.js': [
    "const module_ = require('module');",
    "const names = ['http2', 'fs', 'node:fs', 'fs/promises', 'rimraf', 'esbuild', 'no-such'];",
    'console.log(names.map((n) => `${n}:${module_.isBuiltin(n)}:${module_.Module.isBuiltin(n)}`).join(" "));',
    "console.log(module_.builtinModules === module_.Module.builtinModules, module_.builtinModules.includes('http2'), module_.builtinModules.includes('rimraf'));",
  ].join('\n'),
  'rm.js': [
    "const fs = require('fs');",
    "fs.writeFileSync('kept', 'k'); fs.symlinkSync('missing', 'dangling'); fs.symlinkSync('kept', 'live'); fs.mkdirSync('empty');",
    "const seen = [];",
    "fs.rmSync('dangling'); seen.push(fs.readdirSync('.').includes('dangling') ? 'dangling left' : 'dangling gone');",
    "fs.rmSync('live', { force: true }); seen.push(fs.existsSync('kept') ? 'target kept' : 'target lost', fs.readdirSync('.').includes('live') ? 'link left' : 'link gone');",
    "try { fs.rmSync('empty'); seen.push('removed empty'); } catch (e) { seen.push(e.code + ' ' + e.message); }",
    "fs.rmSync('nothing', { force: true }); seen.push('force ok');",
    "fs.promises.rm('empty', { recursive: true }).then(() => { seen.push(fs.existsSync('empty') ? 'dir left' : 'dir gone'); console.log(seen.join(' | ')); });",
  ].join('\n'),
};
const said = (stderr) => stderr.split('\n')
  .filter((line) => line !== '' && !/^\s+at /.test(line) && !/^(node:|\s+throw |\s*\^|Node\.js v)/.test(line))
  .join('\n');

const host = mkdtempSync(join(tmpdir(), 'lifo-module-surface-'));
const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const failed = [];
try {
  for (const [name, text] of Object.entries(FILES)) {
    const dir = join(host, name.replace(/\.js$/, ''));
    mkdirSync(dir);
    writeFileSync(join(dir, name), text);
    const node = spawnSync(process.env.NODE_BIN ?? 'node', [name], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
    const lifoDir = `/home/user/${name.replace(/\.js$/, '')}`;
    await ws.exec(`mkdir -p ${lifoDir}`, { cwd: '/home/user' });
    await ws.fs.writeFile(`${lifoDir}/${name}`, text);
    const ours = await ws.exec(`node ${name}`, { cwd: lifoDir });
    const expected = { code: node.status, stdout: node.stdout, said: said(node.stderr) };
    const actual = { code: ours.exitCode, stdout: ours.stdout, said: said(ours.stderr) };
    try {
      assert.deepEqual(actual, expected);
      console.log(`  ✓ ${name}`);
    } catch {
      failed.push(`${name}\n  node: ${JSON.stringify(expected)}\n  ours: ${JSON.stringify(actual)}`);
    }
  }
} finally {
  await ws.close();
  rmSync(host, { recursive: true, force: true });
}
assert.deepEqual(failed, [], `as host node:\n${failed.join('\n')}`);
console.log('lifo-node-module-surface: ok');
