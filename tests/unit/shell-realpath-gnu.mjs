#!/usr/bin/env bun
// realpath and readlink against GNU coreutils 9.7 (`gnurealpath`,
// `gnureadlink`, where installed): the same tree built on disk and in a
// workspace, each command run in both, stdout, stderr and exit status
// compared (the host prefix mapped away). Where GNU is not installed, the
// recorded answers below stand in for it. readlink -f/-e/-m canonicalize
// as realpath does, with the same engine; readlink is quiet unless -v.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testBox } from './lib/test-box.mjs';

const CASES = [
  ['realpath', 'dirlink', '/home/user/w/real\n', '', 0],
  ['realpath', 'chain/f', '/home/user/w/real/f\n', '', 0],
  ['realpath', 'rel', '/home/user/w/real/sub\n', '', 0],
  ['realpath', 'dirlink/newname', '/home/user/w/real/newname\n', '', 0],
  ['realpath', 'dang', '/home/user/w/nowhere\n', '', 0],
  ['realpath', 'real/f/', '', 'realpath: real/f/: Not a directory\n', 1],
  ['realpath', 'nope/x', '', 'realpath: nope/x: No such file or directory\n', 1],
  ['realpath', '-e dang', '', 'realpath: dang: No such file or directory\n', 1],
  ['realpath', '-e nope', '', 'realpath: nope: No such file or directory\n', 1],
  ['realpath', '-m dang/x/y', '/home/user/w/nowhere/x/y\n', '', 0],
  ['realpath', '-m nope/../x', '/home/user/w/x\n', '', 0],
  ['realpath', '-m la', '/home/user/w/la\n', '', 0],
  ['realpath', '-m la/x/y', '/home/user/w/la/x/y\n', '', 0],
  ['realpath', 'la', '', 'realpath: la: Too many levels of symbolic links\n', 1],
  ['realpath', '-s dirlink/f', '/home/user/w/dirlink/f\n', '', 0],
  ['realpath', '-L dirlink/../real', '/home/user/w/real\n', '', 0],
  ['realpath', '-P dirlink/..', '/home/user/w\n', '', 0],
  ['realpath', '-q nope/x', '', '', 1],
  ['realpath', '-z dirlink', '/home/user/w/real\0', '', 0],
  ['realpath', '--relative-to=real/sub dirlink/f', '../f\n', '', 0],
  ['realpath', '--relative-to real/sub dirlink/f', '../f\n', '', 0],
  ['realpath', '--relative-base=/home/user/w dirlink/f /home', 'real/f\n/home\n', '', 0],
  ['realpath', '-e dirlink real/f nope', '/home/user/w/real\n/home/user/w/real/f\n', 'realpath: nope: No such file or directory\n', 1],
  ['realpath', '', '', "realpath: missing operand\nTry 'realpath --help' for more information.\n", 1],
  ['realpath', '--bogus x', '', "realpath: unrecognized option '--bogus'\nTry 'realpath --help' for more information.\n", 1],
  ['realpath', '-x dirlink', '', "realpath: invalid option -- 'x'\nTry 'realpath --help' for more information.\n", 1],
  ['readlink', 'dirlink', 'real\n', '', 0],
  ['readlink', 'chain', 'dirlink\n', '', 0],
  ['readlink', 'real/f', '', '', 1],
  ['readlink', 'nope', '', '', 1],
  ['readlink', '-v real/f', '', 'readlink: real/f: Invalid argument\n', 1],
  ['readlink', '-v nope', '', 'readlink: nope: No such file or directory\n', 1],
  ['readlink', '-f chain/f', '/home/user/w/real/f\n', '', 0],
  ['readlink', '-f dirlink/newname', '/home/user/w/real/newname\n', '', 0],
  ['readlink', '-f dang', '/home/user/w/nowhere\n', '', 0],
  ['readlink', '-f nope/x', '', '', 1],
  ['readlink', '-f la', '', '', 1],
  ['readlink', '-v -f la', '', 'readlink: la: Too many levels of symbolic links\n', 1],
  ['readlink', '-f real/f/', '', '', 1],
  ['readlink', '-e dang', '', '', 1],
  ['readlink', '-e chain', '/home/user/w/real\n', '', 0],
  ['readlink', '-m dang/x/y', '/home/user/w/nowhere/x/y\n', '', 0],
  ['readlink', '--canonicalize rel', '/home/user/w/real/sub\n', '', 0],
  ['readlink', '-n dirlink', 'real', '', 0],
  ['readlink', '-z dirlink', 'real\0', '', 0],
  ['readlink', '-f dirlink nope/x chain/f', '/home/user/w/real\n/home/user/w/real/f\n', '', 1],
  ['readlink', '', '', "readlink: missing operand\nTry 'readlink --help' for more information.\n", 1],
  ['readlink', '-x dirlink', '', "readlink: invalid option -- 'x'\nTry 'readlink --help' for more information.\n", 1],
];

const box = await testBox();
const setup = await box.commands.run(
  'mkdir -p /home/user/w/real/sub && cd /home/user/w && echo x > real/f && ln -s real dirlink && ln -s dirlink chain && ln -s ../w/real/sub rel && ln -s nowhere dang && ln -s lb la && ln -s la lb',
);
assert.equal(setup.exitCode, 0, setup.stderr);

// The oracle, when GNU coreutils is installed: the recorded answers must be its.
const gnu = spawnSync('gnurealpath', ['--version'], { encoding: 'utf8' });
if (gnu.status === 0 && spawnSync('gnureadlink', ['--version']).status === 0) {
  const host = mkdtempSync(join(process.env.NIMBUS_SCRATCH ?? tmpdir(), 'nimbus-realpath-'));
  try {
    const w = join(host, 'home/user/w');
    mkdirSync(join(w, 'real/sub'), { recursive: true });
    writeFileSync(join(w, 'real/f'), 'x\n');
    symlinkSync('real', join(w, 'dirlink'));
    symlinkSync('dirlink', join(w, 'chain'));
    symlinkSync('../w/real/sub', join(w, 'rel'));
    symlinkSync('nowhere', join(w, 'dang'));
    symlinkSync('lb', join(w, 'la'));
    symlinkSync('la', join(w, 'lb'));
    for (const [tool, line, out, err, code] of CASES) {
      const args = line === '' ? [] : line.split(' ').map((arg) => arg.replace('=/home', `=${host}/home`).replace(/^\/home$/, `${host}/home`));
      const result = spawnSync(`gnu${tool}`, args, { cwd: w, encoding: 'utf8' });
      const unhost = (text) => text.split(host).join('').replaceAll(`gnu${tool}`, tool);
      assert.deepEqual([unhost(result.stdout), unhost(result.stderr), result.status], [out, err, code], `GNU: ${tool} ${line}`);
    }
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
}

for (const [tool, line, out, err, code] of CASES) {
  const result = await box.commands.run(`cd /home/user/w && ${tool} ${line}`);
  assert.deepEqual([result.stdout, result.stderr, result.exitCode], [out, err, code], `${tool} ${line}`);
}

box.destroy();
console.log('shell-realpath-gnu: ok');
