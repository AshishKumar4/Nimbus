#!/usr/bin/env bun
/**
 * sed-addresses — `sed` selects lines by address.
 *
 * Live on production, the most common sed idiom in shell scripts failed:
 *
 *     $ printf "a\nb\nc\n" | sed -n "2p"
 *     sed: invalid expression: 2p        (exit 1)
 *
 * The parser recognised three whole-script forms — `d`, `p` and `s/…/…/` —
 * and nothing else. An address in front of a command, a `,` range, a `$`, a
 * `!`, or two commands separated by `;` all landed in the same error. A
 * script that asked for one line got no line and a failure exit.
 *
 * Every expectation below was produced by running the identical script under
 * GNU sed 4.9, and everything runs through the command wiring a session
 * resolves through — SqliteVFS mounted into the kernel VFS plus
 * registerUnixCommands, i.e. exactly the commands a prod terminal runs.
 */

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { Sandbox } from '../../packages/core/src/substrate/lifo/sandbox/Sandbox.ts';
import { SqliteVFS, SqliteVFSProvider } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { registerUnixCommands } from '../../packages/core/src/shell/unix-commands.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const root = rawVfs.as(CRED_KERNEL);
root.mkdir('tmp', { mode: 0o777 });
root.chown('tmp', 1000, 1000);

const box = await Sandbox.create({ persist: false });
box.kernel.vfs.mount('/tmp', new SqliteVFSProvider(rawVfs, 'tmp'));
registerUnixCommands(box.commands.registry, rawVfs);

const failures = [];

function check(name, condition, detail) {
  if (condition) { console.log(`  ok   ${name}`); return; }
  failures.push(name);
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

async function sh(line) {
  return box.shell.execute(line, {});
}

/** Asserts stdout byte-for-byte and a zero exit, the way a script sees sed. */
async function expectOut(name, command, stdout) {
  const r = await sh(command);
  check(name, r.exitCode === 0 && r.stdout === stdout,
    `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
}

const ABC = 'printf "a\\nb\\nc\\n"';

// ── numeric addresses ──────────────────────────────────────────────────────
await expectOut('-n with a line number prints that line', `${ABC} | sed -n '2p'`, 'b\n');
await expectOut('a line number selects only its own line', `${ABC} | sed -n '1p'`, 'a\n');
await expectOut('an address past the last line selects nothing',
  `${ABC} | sed -n '4p'`, '');

// ── ranges ─────────────────────────────────────────────────────────────────
await expectOut('a numeric range prints every line in it', `${ABC} | sed -n '2,3p'`, 'b\nc\n');
await expectOut('a range ending past the input stops at the last line',
  `${ABC} | sed -n '2,5p'`, 'b\nc\n');
await expectOut('a range whose end precedes its start selects one line',
  `${ABC} | sed -n '2,1p'`, 'b\n');
await expectOut('a range whose start never matches selects nothing',
  `${ABC} | sed -n '4,2p'`, '');

// ── $ is the last line ─────────────────────────────────────────────────────
await expectOut('$ addresses the last line', `${ABC} | sed -n '$p'`, 'c\n');
await expectOut('a range ending at $ runs to the last line',
  `${ABC} | sed -n '2,$p'`, 'b\nc\n');

// ── regular-expression addresses ───────────────────────────────────────────
await expectOut('a regex address prints matching lines', `${ABC} | sed -n '/b/p'`, 'b\n');
await expectOut('a regex address matches every occurrence',
  `printf "ax\\nb\\nay\\n" | sed -n '/a/p'`, 'ax\nay\n');
await expectOut('an escaped delimiter is literal inside a regex address',
  `printf "a/c\\nb\\n" | sed -n '/a\\/c/p'`, 'a/c\n');
await expectOut('an escaped newline may continue a regex address',
  `${ABC} | sed -n '/a\\
b/p'`, '');
await expectOut('a regex range restarts after it closes',
  `printf "a\\nb\\nc\\nb\\nd\\n" | sed -n '/b/,/c/p'`, 'b\nc\nb\nd\n');
await expectOut('a regex range tests its end from the next line on',
  `printf "a\\nb\\na\\n" | sed -n '/a/,/a/p'`, 'a\nb\na\n');
await expectOut('a regex range that never closes runs to the last line',
  `${ABC} | sed -n '/a/,/zzz/p'`, 'a\nb\nc\n');
await expectOut('an empty regex repeats the previous one',
  `${ABC} | sed -n '/b/p;//p'`, 'b\nb\n');
await expectOut('an empty regex repeats across -e expressions',
  `${ABC} | sed -n -e '/b/p' -e '//p'`, 'b\nb\n');
await expectOut('an empty regex repeats the last evaluated one, not the last parsed',
  `printf "ax\\nbx\\n" | sed -n '/a/,/zzz/p;//p'`, 'ax\nax\nbx\n');
await expectOut('an empty address never inherits g-position state',
  `printf "a\\n" | sed -n 's/a/a/g;//p;//p'`, 'a\na\n');

// ── addresses on d ─────────────────────────────────────────────────────────
await expectOut('a line number deletes that line', `${ABC} | sed '2d'`, 'a\nc\n');
await expectOut('a range deletes every line in it', `${ABC} | sed '2,3d'`, 'a\n');
await expectOut('a regex address deletes matching lines', `${ABC} | sed '/b/d'`, 'a\nc\n');
await expectOut('$ deletes the last line', `${ABC} | sed '$d'`, 'a\nb\n');

// ── negated addresses ──────────────────────────────────────────────────────
await expectOut('! inverts a regex address', `${ABC} | sed -n '/b/!p'`, 'a\nc\n');
await expectOut('! inverts a range', `${ABC} | sed -n '2,3!p'`, 'a\n');
await expectOut('! inverts $', `${ABC} | sed '$!d'`, 'c\n');

// ── several commands in one script ─────────────────────────────────────────
await expectOut('; separates commands', `${ABC} | sed -n '1p;3p'`, 'a\nc\n');
await expectOut('the same line can be printed twice', `${ABC} | sed -n '2p;2p'`, 'b\nb\n');
await expectOut('d ends the cycle before later commands run',
  `${ABC} | sed -n '2!d;p'`, 'b\n');
await expectOut('a trailing ; is not a command', `${ABC} | sed -n '2p;'`, 'b\n');
await expectOut('-e supplies one command each',
  `${ABC} | sed -n -e '1p' -e '3p'`, 'a\nc\n');
await expectOut('blanks around an address and a command are ignored',
  `${ABC} | sed -n ' 2 p '`, 'b\n');
await expectOut('a newline separates commands',
  `printf "a\\nb\\nc\\n" | sed -n '1p
3p'`, 'a\nc\n');
await expectOut('a comment survives between newline-separated commands',
  `printf "a\\nb\\nc\\n" | sed -n '#pick
2p'`, 'b\n');
await expectOut('an empty regex repeats across a newline separator',
  `printf "a\\nb\\nc\\n" | sed -n '/b/p
//p'`, 'b\nb\n');

// ── addresses on s ─────────────────────────────────────────────────────────
await expectOut('a line number restricts a substitution',
  `${ABC} | sed '2s/./X/'`, 'a\nX\nc\n');
await expectOut('a regex address restricts a substitution',
  `printf "a\\nb\\n" | sed -n '/a/s/a/X/p'`, 'X\n');
await expectOut('each substitution sees the previous one',
  `printf "ab\\n" | sed -n 's/a/X/p;s/b/Y/p'`, 'Xb\nXY\n');
await expectOut('an empty s pattern repeats the evaluated address regex',
  `printf "abc\\n" | sed '/b/s//X/'`, 'aXc\n');
await expectOut('an empty s pattern keeps its own flags',
  `printf "abab\\n" | sed 's/b/&/; s//Q/g'`, 'aQaQ\n');
await expectOut('an empty address never inherits g-position state',
  `printf "aa\\naa\\n" | sed -n 's/a/X/gp;//p'`, 'XX\nXX\n');
await expectOut('an empty s pattern inherits prior match flags',
  `printf "A\\n" | sed 's/a/A/i;s//X/'`, 'X\n');

// ── behavior that existed before addresses did ─────────────────────────────
await expectOut('s replaces the first match', `${ABC} | sed 's/b/B/'`, 'a\nB\nc\n');
await expectOut('the g flag replaces every match',
  `printf "aaa\\n" | sed 's/a/X/g'`, 'XXX\n');
await expectOut('the i flag ignores case', `printf "AbA\\n" | sed 's/a/X/gi'`, 'XbX\n');
await expectOut('blanks may sit between s flags',
  `printf "aaa\\n" | sed 's/a/X/ g'`, 'XXX\n');
await expectOut('& is the matched text', `printf "ab\\n" | sed 's/a/[&]/'`, '[a]b\n');
await expectOut('\\1 is a capture group',
  `printf "ab\\n" | sed 's/\\(a\\)\\(b\\)/\\2\\1/'`, 'ba\n');
await expectOut('an escaped ampersand is literal',
  `printf "abc\\n" | sed "s/b/\\\\&/"`, 'a&c\n');
await expectOut('a dollar in a replacement is literal',
  `printf "abc\\n" | sed "s/a/\\$1/"`, '$1bc\n');
await expectOut('the p flag prints a changed line',
  `${ABC} | sed -n 's/b/B/p'`, 'B\n');
await expectOut('p without an address prints every line', `${ABC} | sed -n 'p'`, 'a\nb\nc\n');
await expectOut('p without -n doubles every line',
  `${ABC} | sed 'p'`, 'a\na\nb\nb\nc\nc\n');
await expectOut('d without an address deletes everything', `${ABC} | sed 'd'`, '');
await expectOut('an empty script copies the input', `${ABC} | sed ''`, 'a\nb\nc\n');

// ── the end of the input ───────────────────────────────────────────────────
await expectOut('an input with no final newline keeps none',
  `printf "a\\nb" | sed -n '$p'`, 'b');
await expectOut('only the last output line loses the newline',
  `printf "a" | sed 'p'`, 'a\na');
await expectOut('empty input runs no cycles', `printf "" | sed 'p'`, '');

// ── files ──────────────────────────────────────────────────────────────────
await sh('printf "1\\n2\\n3\\n" > /tmp/one.txt');
await sh('printf "4\\n5\\n" > /tmp/two.txt');

await expectOut('a file operand is addressed like stdin',
  `sed -n '2p' /tmp/one.txt`, '2\n');
await expectOut('several files are one stream for $',
  `sed -n '$p' /tmp/one.txt /tmp/two.txt`, '5\n');
await expectOut('several files are one stream for line numbers',
  `sed -n '1p' /tmp/one.txt /tmp/two.txt`, '1\n');
await expectOut('several files are one stream for a range',
  `sed -n '3,4p' /tmp/one.txt /tmp/two.txt`, '3\n4\n');

await sh('printf "a" > /tmp/glue1.txt');
await sh('printf "b\\nc\\n" > /tmp/glue2.txt');
await sh("printf 'x\\ny' > /tmp/glue3.txt");
await expectOut('an unterminated earlier file still ends its own line',
  `sed -n 'p' /tmp/glue1.txt /tmp/glue2.txt`, 'a\nb\nc\n');
await expectOut('an unterminated last file keeps no final newline',
  `sed -n 'p' /tmp/glue1.txt /tmp/glue3.txt`, 'a\nx\ny');
await expectOut('line numbers continue past an unterminated file',
  `sed -n '2p' /tmp/glue1.txt /tmp/glue2.txt`, 'b\n');

await sh('printf "1\\n2\\n3\\n" > /tmp/edit.txt');
{
  const r = await sh(`sed -i '2d' /tmp/edit.txt`);
  check('-i applies an address in place with a zero status',
    r.exitCode === 0 && r.stdout === '' && r.stderr === '',
    `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
}
await expectOut('the edited file holds the surviving lines',
  `cat /tmp/edit.txt`, '1\n3\n');

await sh('printf "1\\n2\\n" > /tmp/a.txt');
await sh('printf "3\\n4\\n" > /tmp/b.txt');
{
  const r = await sh(`sed -i '1d' /tmp/a.txt /tmp/b.txt`);
  check('-i across files reports a zero status',
    r.exitCode === 0 && r.stdout === '' && r.stderr === '',
    `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
}
await expectOut('the edited files restart line numbers per file',
  `cat /tmp/a.txt /tmp/b.txt`, '2\n4\n');

// ── refusals ───────────────────────────────────────────────────────────────
{
  const r = await sh(`${ABC} | sed 'Z'`);
  check('an unknown command is refused',
    r.exitCode === 1 && r.stderr === 'sed: invalid expression: Z\n',
    `exit=${r.exitCode} stderr=${JSON.stringify(r.stderr)}`);
}
{
  const r = await sh(`${ABC} | sed 's/a/b'`);
  check('an unterminated s is refused', r.exitCode === 1 && r.stdout === '',
    `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)}`);
}
{
  const r = await sh(`${ABC} | sed '0p'`);
  check('line address 0 is refused', r.exitCode === 1 && r.stdout === '',
    `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)}`);
}
{
  const r = await sh(`${ABC} | sed '2,p'`);
  check('a range with no end address is refused', r.exitCode === 1 && r.stdout === '',
    `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)}`);
}
{
  const r = await sh(`${ABC} | sed 'p d'`);
  check('blanks cannot separate two commands', r.exitCode === 1 && r.stdout === '',
    `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)}`);
}
{
  const r = await sh(`${ABC} | sed '2!!p'`);
  check('a second ! is refused', r.exitCode === 1 && r.stdout === '',
    `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)}`);
}
{
  const r = await sh(`printf "a\\nb\\nc\\n" | sed -n '/a
b/p'`);
  check('an unescaped newline inside an address is refused',
    r.exitCode === 1 && r.stdout === '',
    `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)}`);
}
{
  const r = await sh(`printf "a\\nb\\nc\\n" | sed -n '//p'`);
  check('an empty regex with no prior evaluation is refused',
    r.exitCode === 1 && r.stdout === '' && r.stderr === 'sed: no previous regular expression\n',
    `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
}
{
  const r = await sh(`${ABC} | sed -n 's//X/i'`);
  check('an i modifier on an empty pattern is refused',
    r.exitCode === 1 && r.stdout === '',
    `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)}`);
}
{
  const r = await sh(`${ABC} | sed -n '2,//p'`);
  check('a runtime empty-pattern error keeps earlier output',
    r.exitCode === 1 && r.stdout === 'b\n' && r.stderr === 'sed: no previous regular expression\n',
    `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
}
{
  const r = await sh(`printf "aa\\n" | sed 's/a/a/g;s//X/'`);
  check('an empty pattern does not repeat the substitution action',
    r.exitCode === 0 && r.stdout === 'Xa\n',
    `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)}`);
}
{
  await sh('printf "a\\nb\\nc\\n" > /tmp/ie.txt');
  const r = await sh(`sed -i -n '2,//p' /tmp/ie.txt`);
  check('an in-place runtime error writes no stdout and keeps the file',
    r.exitCode === 1 && r.stdout === '' && r.stderr === 'sed: no previous regular expression\n'
      && (await sh('cat /tmp/ie.txt')).stdout === 'a\nb\nc\n',
    `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
}
{
  const r = await sh('sed');
  check('a missing expression is refused',
    r.exitCode === 1 && r.stderr === 'sed: missing expression\n',
    `exit=${r.exitCode} stderr=${JSON.stringify(r.stderr)}`);
}

box.destroy();

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
