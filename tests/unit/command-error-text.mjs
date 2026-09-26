#!/usr/bin/env bun
// What the file commands print when an operation fails, exactly: one path,
// named once (review of 298d4028: converted errors printed it twice), and
// mkdir/rmdir in GNU coreutils' words. The rest keep the text they printed
// before commands got ProcessFiles' view.

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
  ['ls nope', "ls: cannot access 'nope': ENOENT: home/user/w/nope\n"],
  ['cp nope y', 'cp: ENOENT: /home/user/w/nope\n'],
  ['mv nope z', "mv: ENOENT: rename '/home/user/w/nope'\n"],
  ['mv d2 d2', 'mv: EINVAL: cannot move home/user/w/d2 inside itself\n'],
  ['rm d', 'rm: d: EISDIR: home/user/w/d\n'],
  ['rm nope', 'rm: nope: No such file or directory\n'],
  ['rmdir d', "rmdir: failed to remove 'd': Directory not empty\n"],
  ['mkdir d', "mkdir: cannot create directory 'd': File exists\n"],
  ['mkdir /rootdir', "mkdir: cannot create directory '/rootdir': Permission denied\n"],
  ['chmod 644 nope', "chmod: cannot access 'nope': ENOENT: /home/user/w/nope\n"],
  ['chown 0 a', 'chown: a: EPERM: home/user/w/a\n'],
];
for (const [command, stderr] of cases) {
  const result = await box.commands.run(`cd /home/user/w && ${command}`);
  assert.equal(result.stderr, stderr, command);
  assert.notEqual(result.exitCode, 0, `${command} fails`);
}

box.destroy();
console.log('command-error-text: ok');
