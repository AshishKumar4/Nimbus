#!/usr/bin/env bun

// The substrate commands parsed short flags with a `switch` that had no
// `default:` case, so an unrecognised letter fell through and vanished. Long
// options were worse: grep's fell past the short-option test into the branch
// that takes the first non-flag argument as the PATTERN, so
// `grep --ignore-case foo` searched for the literal text "--ignore-case".

import assert from 'node:assert/strict';

import { Sandbox } from '../../packages/worker/src/substrate/lifo/sandbox/Sandbox.ts';

const sandbox = await Sandbox.create();
await sandbox.fs.writeFile('/home/user/three.txt', 'alpha\nbeta\ngamma\n');
await sandbox.fs.writeFile('/home/user/dup.txt', 'a\na\nb\n');
await sandbox.fs.writeFile('/home/user/hay.txt', 'Alpha\nbeta\n');

async function run(line) {
  const result = await sandbox.commands.run(line);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ── an option the command does not implement is refused, never dropped ────
for (const [line, label] of [
  ['wc --bogus three.txt', 'wc long'],
  ['wc -Q three.txt', 'wc short'],
  ['uniq --bogus dup.txt', 'uniq long'],
  ['uniq -Q dup.txt', 'uniq short'],
  ['sort --bogus three.txt', 'sort long'],
  ['sort -Q three.txt', 'sort short'],
  ['grep --bogus alpha three.txt', 'grep long'],
  ['grep -Q alpha three.txt', 'grep short'],
  ['uname --bogus', 'uname long'],
  ['uname -Q', 'uname short'],
  ['strings --bogus three.txt', 'strings long'],
  ['cal --bogus', 'cal long'],
  ['tree --bogus', 'tree long'],
  ['find . -size +1M', 'find predicate'],
  ['base64 -D three.txt', 'base64 short'],
  ['ping --bogus example.com', 'ping long'],
  ['wget --bogus http://example.com', 'wget long'],
  ['dig --bogus example.com', 'dig long'],
]) {
  const refused = await run(line);
  assert.notEqual(refused.exitCode, 0, `${label}: should refuse (${line})`);
  assert.match(
    refused.stderr,
    /unrecognized option|invalid option|unknown predicate|unknown option/,
    `${label}: should name what it refused, got ${JSON.stringify(refused.stderr)}`,
  );
}

// ── grep's long options reach the flags, not the pattern ──────────────────
// This is the case that returned a confident WRONG answer rather than none:
// the pattern became "--ignore-case", which matches nothing.
const folded = await run('grep --ignore-case alpha hay.txt');
assert.equal(folded.exitCode, 0, folded.stderr);
assert.match(folded.stdout, /Alpha/, 'grep --ignore-case must fold case');

const numbered = await run('grep --line-number beta hay.txt');
assert.match(numbered.stdout, /^2:/m, numbered.stderr);

// The short spelling keeps working, so the long one is additive.
const foldedShort = await run('grep -i alpha hay.txt');
assert.match(foldedShort.stdout, /Alpha/, foldedShort.stderr);

// ── the flags that ARE implemented still do their job ─────────────────────
const lines = await run('wc -l three.txt');
assert.match(lines.stdout, /3/, lines.stderr);

const counted = await run('uniq -c dup.txt');
assert.match(counted.stdout, /2 a/, counted.stderr);

const reversed = await run('sort -r three.txt');
assert.equal(reversed.stdout.trim().split('\n')[0], 'gamma', reversed.stderr);

// uname prints its fields in a fixed order regardless of how they were given.
const unameAll = await run('uname -a');
assert.equal(unameAll.exitCode, 0, unameAll.stderr);
const unameMR = await run('uname -mr');
const unameRM = await run('uname -rm');
assert.equal(unameMR.stdout, unameRM.stdout, 'field order is fixed, not argument order');

// `uname -n` used to be dropped, leaving it indistinguishable from bare uname.
const nodename = await run('uname -n');
assert.notEqual(nodename.stdout, (await run('uname')).stdout);

// `strings -n` rejects a length that is not a length instead of using 4.
const badLength = await run('strings -n zero three.txt');
assert.notEqual(badLength.exitCode, 0);
assert.match(badLength.stderr, /invalid minimum string length/);

console.log('substrate-command-flags: ok');
