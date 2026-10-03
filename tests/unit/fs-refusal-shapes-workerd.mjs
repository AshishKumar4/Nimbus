// @serial
// A filesystem refusal reaches a program exactly as it did when SupervisorRPC
// threw it (Kinu ask 16), through the real workerd hops: process isolate →
// SupervisorRPC → session Durable Object and back. SupervisorRPC now answers a
// refusal as a value (`answer`) and the process's client rethrows it; what a
// node program and bash print for each refused call below is what they
// printed on 1bf0d609, where the entrypoint threw (EXPECTED, recorded there
// with this file).
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

// Node: every refused call's error, all of it a program can read but the
// stack (`~` marks a property that is not enumerable).
const NODE_SCRIPT = "const fs = require('fs').promises; const ops = ["
  + "['stat', () => fs.stat('/home/user/file/child')], "
  + "['lstat', () => fs.lstat('/home/user/file/child')], "
  + "['readFile', () => fs.readFile('/home/user/full')], "
  + "['readdir', () => fs.readdir('/home/user/file')], "
  + "['writeFile', () => fs.writeFile('/home/user/missing/f', 'x')], "
  + "['appendFile', () => fs.appendFile('/home/user/full', 'x')], "
  + "['mkdir', () => fs.mkdir('/home/user/file')], "
  + "['rmdir', () => fs.rmdir('/home/user/full')], "
  + "['unlink', () => fs.unlink('/home/user/full')], "
  + "['rename', () => fs.rename('/home/user/nope', '/home/user/else')], "
  + "['open', () => fs.open('/home/user/nope', 'r')], "
  + "['access', () => fs.access('/home/user/nope')], "
  + "['truncate', () => fs.truncate('/home/user/nope')], "
  + "['readlink', () => fs.readlink('/home/user/file')], "
  + "['copyFile', () => fs.copyFile('/home/user/nope', '/home/user/copy')], "
  + "['symlink', () => fs.symlink('/x', '/home/user/file')]]; "
  + "(async () => { for (const [name, op] of ops) { try { await op(); console.log('SHAPE ' + name + ' ok'); } "
  + "catch (e) { const own = Object.getOwnPropertyNames(e).filter((k) => k !== 'stack')"
  + ".map((k) => k + '=' + JSON.stringify(e[k]) + (Object.getOwnPropertyDescriptor(e, k).enumerable ? '' : '~')).join(' '); "
  + "console.log('SHAPE ' + name + ' ' + e.constructor.name + ' ' + e.name + ' ' + own); } } })();";

// Bash: its WASI syscalls reach the same filesystem through the same hop.
const BASH_SCRIPT = "cat /home/user/file/child; cat < /home/user/full; mkdir /home/user/full; rmdir /home/user/full; "
  + "cd /home/user/file; echo x > /home/user/missing/f; ln -s /x /home/user/file; mv /home/user/nope /home/user/else; "
  + "ls /home/user/nope; true";

const EXPECTED = {
  node: [
    "SHAPE stat Error Error message=\"ENOTDIR: not a directory, stat '/home/user/file/child'\"~ code=\"ENOTDIR\" errno=-20 syscall=\"stat\" path=\"/home/user/file/child\"",
    "SHAPE lstat Error Error message=\"ENOENT: no such file or directory, lstat '/home/user/file/child'\"~ code=\"ENOENT\" errno=-2 syscall=\"lstat\" path=\"/home/user/file/child\"",
    "SHAPE readFile Error Error message=\"EISDIR: illegal operation on a directory, read '/home/user/full'\"~ code=\"EISDIR\" errno=-21 syscall=\"read\" path=\"/home/user/full\"",
    "SHAPE readdir Error Error message=\"ENOTDIR: not a directory, scandir '/home/user/file'\"~ code=\"ENOTDIR\" errno=-20 syscall=\"scandir\" path=\"/home/user/file\"",
    "SHAPE writeFile Error Error message=\"ENOENT: no such file or directory, open '/home/user/missing/f'\"~ code=\"ENOENT\" errno=-2 syscall=\"open\" path=\"/home/user/missing/f\"",
    "SHAPE appendFile Error Error message=\"EISDIR: illegal operation on a directory, write '/home/user/full'\"~ code=\"EISDIR\" errno=-21 syscall=\"write\" path=\"/home/user/full\"",
    "SHAPE mkdir Error Error message=\"EEXIST: file already exists, mkdir '/home/user/file'\"~ code=\"EEXIST\" errno=-17 syscall=\"mkdir\" path=\"/home/user/file\"",
    "SHAPE rmdir Error Error message=\"ENOTEMPTY: directory not empty, rmdir '/home/user/full'\"~ code=\"ENOTEMPTY\" errno=-39 syscall=\"rmdir\" path=\"/home/user/full\"",
    "SHAPE unlink Error Error message=\"EISDIR: illegal operation on a directory, unlink '/home/user/full'\"~ code=\"EISDIR\" errno=-21 syscall=\"unlink\" path=\"/home/user/full\"",
    "SHAPE rename Error Error message=\"ENOENT: no such file or directory, rename '/home/user/nope' -> '/home/user/else'\"~ code=\"ENOENT\" errno=-2 syscall=\"rename\" path=\"/home/user/nope\" dest=\"/home/user/else\"",
    "SHAPE open Error Error message=\"ENOENT: no such file or directory, open '/home/user/nope'\"~ code=\"ENOENT\" errno=-2 syscall=\"open\" path=\"/home/user/nope\"",
    "SHAPE access Error Error message=\"ENOENT: no such file or directory, access '/home/user/nope'\"~ code=\"ENOENT\" errno=-2 syscall=\"access\" path=\"/home/user/nope\"",
    "SHAPE truncate Error Error message=\"ENOENT: no such file or directory, truncate '/home/user/nope'\"~ code=\"ENOENT\" errno=-2 syscall=\"truncate\" path=\"/home/user/nope\"",
    "SHAPE readlink Error Error message=\"EINVAL: invalid argument, readlink '/home/user/file'\"~ code=\"EINVAL\" errno=-22 syscall=\"readlink\" path=\"/home/user/file\"",
    "SHAPE copyFile Error Error message=\"ENOENT: no such file or directory, copyfile '/home/user/nope' -> '/home/user/copy'\"~ code=\"ENOENT\" errno=-2 syscall=\"copyfile\" path=\"/home/user/nope\" dest=\"/home/user/copy\"",
    "SHAPE symlink Error Error message=\"EEXIST: file already exists, symlink '/x' -> '/home/user/file'\"~ code=\"EEXIST\" errno=-17 syscall=\"symlink\" path=\"/x\" dest=\"/home/user/file\"",
  ],
  bash: [
    "cat: can't open '/home/user/file/child': Not a directory",
    "cat: read error: Is a directory",
    "mkdir: can't create directory '/home/user/full': File exists",
    "rmdir: '/home/user/full': Directory not empty",
    "bash: line 1: cd: /home/user/file: Not a directory",
    "bash: line 1: /home/user/missing/f: No such file or directory",
    "ln: /home/user/file: File exists",
    "mv: can't rename '/home/user/nope': No such file or directory",
    "ls: /home/user/nope: No such file or directory",
  ],
};

console.log('fs-refusal-shapes-workerd: starting local workerd');
const probe = await startLocalProbe();
try {
  const terminal = await localTerminal(probe);
  try {
    const setup = await terminal.run('mkdir -p /home/user/full && echo x > /home/user/full/f && echo y > /home/user/file', 300_000);
    assert.equal(setup.status, 0, `setup: ${setup.stdout}`);
    const node = await terminal.run(`node -e "${NODE_SCRIPT}"`, 300_000);
    const bash = await terminal.run(`bash -c '${BASH_SCRIPT}' 2>&1`, 300_000);
    const observed = {
      node: node.stdout.split('\n').filter((line) => line.startsWith('SHAPE ')),
      bash: bash.stdout.split('\n').filter((line) => line.length > 0),
    };
    assert.equal(observed.node.length, EXPECTED.node.length, node.stdout);
    assert.deepEqual(observed, EXPECTED);
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('fs-refusal-shapes-workerd: refused calls reach node and bash as they did when SupervisorRPC threw');
