#!/usr/bin/env bun

// cat / wc / sort / tail / tee kept their operands with
// `args.filter(a => !a.startsWith('-'))`, which threw away every flag they
// did not implement. `cat -n` printed unnumbered lines, `wc -m` reported
// bytes, `sort -f` sorted case-sensitively — and nothing said so. Each flag
// now either works or is refused by name.

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { registerUnixCommands } from '../../packages/worker/src/shell/unix-commands.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);
kernel.mkdir('home/user', { recursive: true });
kernel.writeFile('home/user/three.txt', 'alpha\nbeta\ngamma\n');
kernel.writeFile('home/user/mixed.txt', 'Banana\napple\nCherry\n');
kernel.writeFile('home/user/blanks.txt', 'a\n\n\n\nb\n');
kernel.writeFile('home/user/tabs.txt', 'a\tb\n');
// Five characters, seven bytes — the case where -m and -c must disagree.
kernel.writeFile('home/user/utf8.txt', 'héllo\n');

const commands = new Map();
const registry = {
  register: (name, fn) => commands.set(name, fn),
  registerLazy: (name, loader) => commands.set(name, loader),
  has: (name) => commands.has(name),
  get: (name) => commands.get(name),
  unregister: (name) => commands.delete(name),
  list: () => [...commands.keys()],
};
registerUnixCommands(registry, vfs);

async function run(name, args, stdin) {
  const out = [];
  const err = [];
  const exitCode = await commands.get(name)({
    args,
    cwd: '/home/user',
    env: {},
    cred: CRED_KERNEL,
    vfs: kernel,
    stdin,
    stdout: { write: (d) => out.push(d) },
    stderr: { write: (d) => err.push(d) },
    signal: new AbortController().signal,
  });
  return { exitCode, stdout: out.join(''), stderr: err.join('') };
}

// ── every command refuses an option it does not implement ─────────────────
for (const [name, badExit] of [
  ['cat', 1], ['wc', 1], ['sort', 2], ['tail', 1], ['tee', 1],
]) {
  const long = await run(name, ['--definitely-not-a-flag']);
  assert.equal(long.exitCode, badExit, `${name} --definitely-not-a-flag exit`);
  assert.match(
    long.stderr,
    /unrecognized option '--definitely-not-a-flag'/,
    `${name} names the option it refused`,
  );
  assert.equal(long.stdout, '', `${name} produces no output when it refused`);
}

// A bad short option is refused too, including one hidden inside a cluster.
const badShort = await run('wc', ['-lQ', 'three.txt']);
assert.equal(badShort.exitCode, 1);
assert.match(badShort.stderr, /invalid option -- 'Q'/);

// ── wc ────────────────────────────────────────────────────────────────────
// `-m` counts characters and `-c` counts bytes; they differ here.
const chars = await run('wc', ['-m', 'utf8.txt']);
assert.equal(chars.stdout, '       6 utf8.txt\n', chars.stderr);
const bytes = await run('wc', ['-c', 'utf8.txt']);
assert.equal(bytes.stdout, '       7 utf8.txt\n', bytes.stderr);

// A cluster selects exactly the columns it names. This used to select NONE
// of them — `wc -lw` printed a bare filename and no counts at all.
const cluster = await run('wc', ['-lw', 'three.txt']);
assert.equal(cluster.stdout, '       3       3 three.txt\n', cluster.stderr);

// Flag order does not change column order, matching GNU.
const reordered = await run('wc', ['-cl', 'three.txt']);
assert.equal(reordered.stdout, '       3      17 three.txt\n', reordered.stderr);

const longest = await run('wc', ['-L', 'three.txt']);
assert.equal(longest.stdout, '       5 three.txt\n', longest.stderr);

// No selection still means GNU's default trio.
const wcDefault = await run('wc', ['three.txt']);
assert.equal(wcDefault.stdout, '       3       3      17 three.txt\n', wcDefault.stderr);

// ── cat ───────────────────────────────────────────────────────────────────
const numbered = await run('cat', ['-n', 'three.txt']);
assert.equal(
  numbered.stdout,
  '     1\talpha\n     2\tbeta\n     3\tgamma\n',
  numbered.stderr,
);

// -b numbers only non-blank lines, and numbering runs across operands.
const nonblank = await run('cat', ['-b', 'blanks.txt']);
assert.equal(nonblank.stdout, '     1\ta\n\n\n\n     2\tb\n', nonblank.stderr);

const squeezed = await run('cat', ['-s', 'blanks.txt']);
assert.equal(squeezed.stdout, 'a\n\nb\n', squeezed.stderr);

const ends = await run('cat', ['-E', 'three.txt']);
assert.equal(ends.stdout, 'alpha$\nbeta$\ngamma$\n', ends.stderr);

const showTabs = await run('cat', ['-T', 'tabs.txt']);
assert.equal(showTabs.stdout, 'a^Ib\n', showTabs.stderr);

// -A implies -vET.
const showAll = await run('cat', ['-A', 'tabs.txt']);
assert.equal(showAll.stdout, 'a^Ib$\n', showAll.stderr);

// The unformatted path is untouched.
const plain = await run('cat', ['three.txt']);
assert.equal(plain.stdout, 'alpha\nbeta\ngamma\n', plain.stderr);

// Line numbers continue across operands rather than restarting.
const twoFiles = await run('cat', ['-n', 'tabs.txt', 'tabs.txt']);
assert.equal(twoFiles.stdout, '     1\ta\tb\n     2\ta\tb\n', twoFiles.stderr);

// ── sort ──────────────────────────────────────────────────────────────────
// -f makes the two spellings compare equal, so input order survives; without
// it they are ordered. Either way the flag has to reach the comparator.
const folded = await run('sort', ['-f'], 'B\nb\nA\n');
assert.equal(folded.stdout, 'A\nB\nb\n', folded.stderr);

const unfolded = await run('sort', [], 'B\nb\nA\n');
assert.equal(unfolded.stdout, 'A\nb\nB\n', unfolded.stderr);

const byKey = await run('sort', ['-k', '2'], 'x 3\ny 1\nz 2\n');
assert.equal(byKey.stdout, 'y 1\nz 2\nx 3\n', byKey.stderr);

const bySeparator = await run('sort', ['-t', ':', '-k', '2'], 'x:3\ny:1\nz:2\n');
assert.equal(bySeparator.stdout, 'y:1\nz:2\nx:3\n', bySeparator.stderr);

const human = await run('sort', ['-h'], '2K\n1M\n500\n');
assert.equal(human.stdout, '500\n2K\n1M\n', human.stderr);

const numericSort = await run('sort', ['-n'], '10\n9\n100\n');
assert.equal(numericSort.stdout, '9\n10\n100\n', numericSort.stderr);

// `-k N` runs to the END OF LINE, so -k1 -u keeps rows differing past field 1.
const wholeLineKey = await run('sort', ['-k', '1', '-u'], 'a 1\na 2\nb 3\n');
assert.equal(wholeLineKey.stdout, 'a 1\na 2\nb 3\n', wholeLineKey.stderr);

// `-k N,N` bounds the key to that one field, and then -u collapses the pair.
const boundedKey = await run('sort', ['-k', '1,1', '-u'], 'a 1\na 2\nb 3\n');
assert.equal(boundedKey.stdout, 'a 1\nb 3\n', boundedKey.stderr);

// -k2 over three fields compares "field 2 through end of line".
const toEndOfLine = await run('sort', ['-k', '2'], 'a 2 z\nb 2 a\nc 1 m\n');
assert.equal(toEndOfLine.stdout, 'c 1 m\nb 2 a\na 2 z\n', toEndOfLine.stderr);

const boundedField = await run('sort', ['-k', '2,2'], 'a 2 z\nb 2 a\nc 1 m\n');
assert.equal(boundedField.stdout, 'c 1 m\na 2 z\nb 2 a\n', boundedField.stderr);

// A key that is not a field number is refused rather than silently ignored.
const badKey = await run('sort', ['-k', 'zz']);
assert.equal(badKey.exitCode, 2);
assert.match(badKey.stderr, /invalid number at field start/);

// ── tail ──────────────────────────────────────────────────────────────────
const lastTwo = await run('tail', ['-n', '2', 'three.txt']);
assert.equal(lastTwo.stdout, 'beta\ngamma\n', lastTwo.stderr);

// A trailing newline terminates the last line; it must not become a blank one.
const lastOne = await run('tail', ['-n', '1', 'three.txt']);
assert.equal(lastOne.stdout, 'gamma\n', lastOne.stderr);

// `tail -c` was dropped entirely and the count treated as a filename.
const lastBytes = await run('tail', ['-c', '6', 'three.txt']);
assert.equal(lastBytes.stdout, 'gamma\n', lastBytes.stderr);

// The obsolete `-2` form, and the attached `-n2` form.
for (const argv of [['-2', 'three.txt'], ['-n2', 'three.txt'], ['--lines=2', 'three.txt']]) {
  const parsed = await run('tail', argv);
  assert.equal(parsed.stdout, 'beta\ngamma\n', `tail ${argv.join(' ')}`);
}

// An operand that looks like a count is still an operand, not a flag value.
// `tail -n 2 three.txt` used to filter out any operand equal to the count.
const named = await run('tail', ['-n', '2', 'three.txt', 'three.txt']);
assert.match(named.stdout, /==> three\.txt <==/);

// -v forces the header for a single operand; -q suppresses it for many.
const forcedHeader = await run('tail', ['-v', '-n', '1', 'three.txt']);
assert.match(forcedHeader.stdout, /==> three\.txt <==/);
const quiet = await run('tail', ['-q', '-n', '1', 'three.txt', 'three.txt']);
assert.doesNotMatch(quiet.stdout, /==>/);

// ── tee ───────────────────────────────────────────────────────────────────
const teed = await run('tee', ['out.txt'], 'payload\n');
assert.equal(teed.exitCode, 0, teed.stderr);
assert.equal(kernel.readFileString('home/user/out.txt'), 'payload\n');

const appended = await run('tee', ['-a', 'out.txt'], 'more\n');
assert.equal(appended.exitCode, 0, appended.stderr);
assert.equal(kernel.readFileString('home/user/out.txt'), 'payload\nmore\n');

// -i is a real no-op here, so it is accepted rather than refused.
const ignored = await run('tee', ['-i', 'out2.txt'], 'x\n');
assert.equal(ignored.exitCode, 0, ignored.stderr);
assert.equal(kernel.readFileString('home/user/out2.txt'), 'x\n');

// ── the commands whose parsers had no refusal branch at all ───────────────
// grep's long options fell past the short-option test into the positional
// list, so `grep --colour PATTERN file` searched for the text "--colour".
const grepLong = await run('grep', ['--colour', 'alpha', 'three.txt']);
assert.equal(grepLong.exitCode, 2);
assert.match(grepLong.stderr, /unrecognized option '--colour'/);
assert.equal(grepLong.stdout, '', 'grep must not search for the flag itself');

const grepShort = await run('grep', ['-Q', 'alpha', 'three.txt']);
assert.equal(grepShort.exitCode, 2);
assert.match(grepShort.stderr, /invalid option -- 'Q'/);

// The flags grep does implement still work, so refusal is not over-broad.
const grepWorks = await run('grep', ['-n', 'beta', 'three.txt']);
assert.equal(grepWorks.exitCode, 0, grepWorks.stderr);
assert.match(grepWorks.stdout, /2/);

// find ignored any predicate it did not implement and returned EVERYTHING,
// which reads as a successful answer to the question that was asked.
const findBad = await run('find', ['.', '-perm', '600']);
assert.equal(findBad.exitCode, 1);
assert.match(findBad.stderr, /unknown predicate '-perm'/);
assert.equal(findBad.stdout, '');

const findWorks = await run('find', ['.', '-name', 'three.txt']);
assert.equal(findWorks.exitCode, 0, findWorks.stderr);
assert.match(findWorks.stdout, /three\.txt/);

// awk carried a comment saying it ignored other flags on purpose.
const awkBad = await run('awk', ['-Q', '{print}']);
assert.equal(awkBad.exitCode, 2);
assert.match(awkBad.stderr, /unrecognized option '-Q'/);

// which and readlink dropped unknown letters out of a cluster.
const whichBad = await run('which', ['-Q', 'ls']);
assert.equal(whichBad.exitCode, 2);
assert.match(whichBad.stderr, /invalid option -- 'Q'/);

const readlinkBad = await run('readlink', ['-Q', 'three.txt']);
assert.equal(readlinkBad.exitCode, 1);
assert.match(readlinkBad.stderr, /invalid option -- 'Q'/);

// base64 kept only -d, so `base64 -w 0` silently wrapped at the default.
const base64Bad = await run('base64', ['-Q', 'three.txt']);
assert.equal(base64Bad.exitCode, 1);
assert.match(base64Bad.stderr, /invalid option -- 'Q'/);

const base64Works = await run('base64', ['three.txt']);
assert.equal(base64Works.exitCode, 0, base64Works.stderr);
assert.match(base64Works.stdout, /^[A-Za-z0-9+/=\s]+$/);

// xargs turned an unknown flag into the command name.
const xargsBad = await run('xargs', ['-Q', 'echo'], 'a\n');
assert.equal(xargsBad.exitCode, 1);
assert.match(xargsBad.stderr, /unrecognized option '-Q'/);

console.log('unix-text-command-flags: ok');
