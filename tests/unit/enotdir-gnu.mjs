#!/usr/bin/env bun
// A name below a regular file is "Not a directory" (ENOTDIR), as Linux says,
// not "No such file or directory": checked against the host's GNU tools and
// node under bash, over the same tree (f a regular file):
//
//   - stat, ls, test -e and -L, rm -f, mkdir -p, cp, mv, ln -s and touch of
//     f/x say what GNU's do, and exit as GNU's do;
//   - node's lstatSync and statSync of f/x throw ENOTDIR; existsSync is false.
//
// Red before: the runtime bridge's lstat, and a mounted SQLite file system's
// stat, answered a name below a non-directory as absent (null), so callers
// said ENOENT.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const FILES = { f: 'one\n', g: 'gee\n', g2: 'gee two\n' };
const NODE = `const fs = require("fs"); const t = (f) => { try { f(); return "ok"; } catch (e) { return e.code; } };
console.log(t(() => fs.lstatSync("f/x")), t(() => fs.statSync("f/x")), fs.existsSync("f/x"), t(() => fs.readFileSync("f/x")), t(() => fs.writeFileSync("f/x", "y")), t(() => fs.mkdirSync("f/x")));`;
const CASES = [
  'stat f/x',
  'stat -c %n f/x g',
  'ls f/x',
  'ls -l f/x/y',
  'test -e f/x; echo "e=$?"; test -L f/x; echo "L=$?"; test -f f/x/y; echo "f=$?"',
  'rm -f f/x; echo "rm=$?"; rm f/x',
  'mkdir -p f/x',
  'mkdir f/x',
  'cp g f/x',
  'mv g2 f/x',
  'ln -s g f/x',
  'touch f/x',
  'cat f/x',
  `node -e '${NODE}'`,
];

const run = (line) => `${line}; echo "status=$?"`;
const dir = mkdtempSync(join(tmpdir(), 'enotdir-gnu-'));
const gnu = {};
try {
  for (const [name, text] of Object.entries(FILES)) writeFileSync(join(dir, name), text);
  for (const line of CASES) {
    const r = spawnSync('bash', ['--norc', '--noprofile', '-c', run(line)], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, LC_ALL: 'C' } });
    gnu[line] = { stdout: r.stdout, stderr: r.stderr };
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const failed = [];
try {
  for (const [name, text] of Object.entries(FILES)) await ws.fs.writeFile(`/home/user/${name}`, text);
  for (const line of CASES) {
    const r = await ws.exec(run(line), { cwd: '/home/user' });
    const ours = { stdout: r.stdout, stderr: r.stderr };
    try {
      assert.deepEqual(ours, gnu[line]);
      console.log(`  ✓ ${line.slice(0, 80)}`);
    } catch {
      failed.push(`${line}\n  gnu:  ${JSON.stringify(gnu[line])}\n  ours: ${JSON.stringify(ours)}`);
      console.log(`  ✗ ${line.slice(0, 80)}`);
    }
  }
} finally {
  await ws.close();
}
assert.deepEqual(failed, [], `as GNU:\n${failed.join('\n')}`);
console.log('enotdir-gnu: ok');
