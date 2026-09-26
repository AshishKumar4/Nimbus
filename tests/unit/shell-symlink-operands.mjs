#!/usr/bin/env bun
// realpath and ls on symlink operands, as GNU coreutils answer them:
// - realpath resolves every link in every component; all but the last must
//   exist (its default, -E);
// - ls follows a command-line symlink to a directory and lists it, unless
//   -l, -d or -F (without -H or -L); -H follows every command-line link, -L
//   every link. Without following, the operand is shown as the link itself.

import assert from 'node:assert/strict';
import { testBox } from './lib/test-box.mjs';

const box = await testBox();
const run = async (command) => {
  const result = await box.commands.run(`cd /home/user/w && ${command}`);
  return { out: result.stdout, err: result.stderr, code: result.exitCode };
};
const setup = await box.commands.run(
  'mkdir -p /home/user/w/real/sub && cd /home/user/w && echo x > real/f && ln -s real dirlink && ln -s real/f filelink && ln -s dirlink chain && ln -s ../w/real/sub rel',
);
assert.equal(setup.exitCode, 0, setup.stderr);

// realpath
assert.equal((await run('realpath dirlink')).out, '/home/user/w/real\n');
assert.equal((await run('realpath chain/f')).out, '/home/user/w/real/f\n', 'a link to a link, then a file under it');
assert.equal((await run('realpath rel')).out, '/home/user/w/real/sub\n', 'a relative target with ..');
assert.equal((await run('realpath dirlink/newname')).out, '/home/user/w/real/newname\n', 'the last component may be absent');
const missing = await run('realpath nope/x');
assert.deepEqual([missing.code, missing.err], [1, 'realpath: nope/x: No such file or directory\n']);

// ls: a command-line link to a directory is listed, by default
assert.match((await run('ls dirlink')).out, /^f\s+sub\n$/);
assert.match((await run('ls chain')).out, /^f\s+sub\n$/);
// ... but shown as the link itself with -l, -d or -F
assert.match((await run('ls -l dirlink')).out, /^l\S+ .* dirlink -> real\n$/);
assert.equal((await run('ls -d dirlink')).out, 'dirlink\n');
// (this ls does not print -F's indicators; what matters is that it does not list)
assert.match((await run('ls -F dirlink')).out, /^dirlink@?\n$/);
// -H follows command-line links: -l lists the directory, -d shows it as a directory
assert.match((await run('ls -lH dirlink')).out, /^(total \d+\n)?-.* f\nd.* sub\n$/);
assert.match((await run('ls -dlH dirlink')).out, /^d\S+ .* dirlink\n$/);
assert.match((await run('ls -lL dirlink')).out, /^(total \d+\n)?-.* f\nd.* sub\n$/);
// a link to a file is shown by name, and with -l as the link
assert.equal((await run('ls filelink')).out, 'filelink\n');
assert.match((await run('ls -l filelink')).out, /^l\S+ .* filelink -> real\/f\n$/);
assert.match((await run('ls -lH filelink')).out, /^-\S+ .* filelink\n$/, '-H shows the target file under the link name');

box.destroy();
console.log('shell-symlink-operands: ok');
