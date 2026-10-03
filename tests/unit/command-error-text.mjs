#!/usr/bin/env bun
// What the file commands print when an operation fails, exactly, in GNU
// coreutils' words: the operand as the caller wrote it, named once, and
// strerror's text (or the refusal's own reason). Never a storage key (Kinu
// ask 9: ls named 'home/user/w/nope'). A VfsError's own message keeps Node's
// shape for programs (ASK-mounts item 11); the shell does not print it.

import assert from 'node:assert/strict';
import { testBox } from './lib/test-box.mjs';

const box = await testBox();
const setup = await box.commands.run(
  'mkdir -p /home/user/w/d/e && cd /home/user/w && echo hi > a && echo x > d/e/f && ln -s a l && cp -r d d2',
);
assert.equal(setup.exitCode, 0, setup.stderr);

const cases = [
  ['cat nope', 'cat: nope: No such file or directory\n'],
  ['cat d', 'cat: d: Is a directory\n'],
  ['ls nope', "ls: cannot access 'nope': No such file or directory\n"],
  ['cp nope y', "cp: cannot stat 'nope': No such file or directory\n"],
  ['mv nope z', "mv: cannot stat 'nope': No such file or directory\n"],
  ['mv d2 d2', "mv: cannot move 'd2' to a subdirectory of itself, 'd2/d2'\n"],
  ['rm d', "rm: cannot remove 'd': Is a directory\n"],
  ['rm nope', "rm: cannot remove 'nope': No such file or directory\n"],
  ['rmdir d', "rmdir: failed to remove 'd': Directory not empty\n"],
  ['mkdir d', "mkdir: cannot create directory 'd': File exists\n"],
  ['mkdir /rootdir', "mkdir: cannot create directory '/rootdir': Permission denied\n"],
  ['chmod 644 nope', "chmod: cannot access 'nope': No such file or directory\n"],
  ['chown 0 a', "chown: changing ownership of 'a': Operation not permitted\n"],
  ['chown 0 nope', "chown: cannot access 'nope': No such file or directory\n"],
];
for (const [command, stderr] of cases) {
  const result = await box.commands.run(`cd /home/user/w && ${command}`);
  assert.equal(result.stderr, stderr, command);
  assert.notEqual(result.exitCode, 0, `${command} fails`);
}

box.destroy();
console.log('command-error-text: ok');
