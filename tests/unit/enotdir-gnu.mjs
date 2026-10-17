#!/usr/bin/env bun
// A name below a regular file is "Not a directory" (ENOTDIR), as Linux says,
// not "No such file or directory": checked against the host's GNU tools and
// node under bash, over the same tree (f a regular file):
//
//   - stat, ls, test -e and -L, rm -f, mkdir -p, cp, mv, ln -s and touch of
//     f/x say what GNU's do, and exit as GNU's do;
//   - with several operands, f/x first, mv, cp, rm, touch, chmod, chown, cat,
//     mkdir, rmdir and ls report it and go on to the rest, as GNU's do;
//   - node's lstatSync and statSync of f/x throw ENOTDIR; existsSync is false;
//     renameSync from f/x, or to a name below it, throws ENOTDIR.
//
// Red before: the runtime bridge's lstat, and a mounted SQLite file system's
// stat, answered a name below a non-directory as absent (null), so callers
// said ENOENT; once lstat said ENOTDIR, mv's probe of a source rename refused
// threw it past the operand's own report and ended the command.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const FILES = { f: 'one\n', g: 'gee\n', g2: 'gee two\n' };
const NODE = `const fs = require("fs"); const t = (f) => { try { f(); return "ok"; } catch (e) { return e.code; } };
console.log(t(() => fs.lstatSync("f/x")), t(() => fs.statSync("f/x")), fs.existsSync("f/x"), t(() => fs.readFileSync("f/x")), t(() => fs.writeFileSync("f/x", "y")), t(() => fs.mkdirSync("f/x")), t(() => fs.renameSync("f/x", "y")), t(() => fs.renameSync("g", "f/x/y")));`;
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
  // Several operands, the first below a regular file: it is reported and the rest are done.
  'printf a > m1; mkdir -p md; mv f/x m1 md; echo "mv=$?"; ls md',
  'printf a > m2; mkdir -p mt; mv -t mt f/x m2; echo "mv=$?"; ls mt',
  'printf a > m3; mv m3 f/x/y; echo "mv=$?"; cat m3',
  'printf a > c1; mkdir -p cd; cp f/x c1 cd; echo "cp=$?"; ls cd',
  'printf a > c2; mkdir -p cr; cp -r f/x c2 cr; echo "cp=$?"; ls cr',
  'printf a > r1; rm f/x r1; echo "rm=$?"; test -e r1; echo "r1=$?"',
  'touch f/x t1; echo "touch=$?"; test -e t1; echo "t1=$?"',
  'printf a > h1; chmod 600 f/x h1; echo "chmod=$?"; stat -c %a h1',
  'printf a > o1; chown "$(stat -c %u o1)" f/x o1; echo "chown=$?"',
  'printf a > k1; cat f/x k1; echo "cat=$?"',
  'mkdir f/x n1; echo "mkdir=$?"; test -d n1; echo "n1=$?"',
  'mkdir -p q1/e; rmdir f/x q1/e; echo "rmdir=$?"; test -e q1/e; echo "e=$?"',
  'printf a > l1; ls f/x l1; echo "ls=$?"',
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
