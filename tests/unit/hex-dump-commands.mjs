#!/usr/bin/env bun
/**
 * hex-dump-commands — od, hexdump and xxd behaviour through the live shell.
 *
 * Three gaps verified on production, each reproducible as a pipeline:
 * `printf A | od -An -tx1`, `printf A | hexdump -e '1/1 "%02x"'` and
 * `printf A | xxd -p` all failed — the first two exited 127, xxd ignored
 * stdin and printed a usage line. Every expected string below is byte-for-
 * byte output captured from this machine's reference tools (uutils coreutils
 * 0.8.0 od, util-linux 2.41.3 hexdump, xxd 2025-11-26), except the xxd row
 * layout, which predates this change and is pinned as-is.
 *
 * The harness is the live session shape: SqliteVFS mounted into the kernel
 * VFS plus registerUnixCommands, i.e. exactly the commands a prod terminal
 * runs.
 */

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { Sandbox } from '../../packages/core/src/substrate/lifo/sandbox/Sandbox.ts';
import { SqliteVFS, SqliteVFSProvider } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { registerUnixCommands } from '../../packages/core/src/shell/unix-commands.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { TerminalStdin } from '../../packages/core/src/substrate/lifo/shell/terminal-stdin.ts';
import { staticStdinReader } from '../../packages/core/src/shell/stdin-adapter.ts';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const root = rawVfs.as(CRED_KERNEL);
root.mkdir('tmp', { mode: 0o777 });
root.chown('tmp', 1000, 1000);

const bytes = (values) => new Uint8Array(values);
root.writeFile('tmp/h.txt', 'Hello, World!\n', { mode: 0o644 });
root.writeFile('tmp/a.bin', 'A', { mode: 0o644 });
root.writeFile('tmp/z.bin', bytes([...Array(32).fill(0), 0x5a, 0x5a]), { mode: 0o644 });
root.writeFile('tmp/zz.bin', bytes([0x00, 0x00]), { mode: 0o644 });
root.writeFile('tmp/r.bin', bytes(Array.from({ length: 20 }, (_, i) => i)), { mode: 0o644 });
root.writeFile('tmp/b27.bin', bytes(Array(27).fill(0)), { mode: 0o644 });
root.writeFile('tmp/s100.bin', bytes(Array.from({ length: 100 }, (_, i) => i)), { mode: 0o644 });
root.writeFile('tmp/four.bin', bytes([0x30, 0x31, 0x32, 0x33]), { mode: 0o644 });
root.writeFile('tmp/abcd.bin', bytes([0x41, 0x42, 0x43, 0x44]), { mode: 0o644 });
root.writeFile('tmp/bin4.bin', bytes([0xff, 0xfe, 0x00, 0x41]), { mode: 0o644 });
root.writeFile('tmp/ctrl1.bin', bytes([0x01]), { mode: 0o644 });
root.writeFile('tmp/one80.bin', bytes([0x80]), { mode: 0o644 });
root.writeFile('tmp/k3.bin', bytes(Array(3072).fill(0)), { mode: 0o644 });
root.writeFile('tmp/big.bin', bytes(Array.from({ length: 70000 }, (_, i) => i % 251)), { mode: 0o644 });

const box = await Sandbox.create({ persist: false });
box.kernel.vfs.mount('/tmp', new SqliteVFSProvider(rawVfs, 'tmp'));
registerUnixCommands(box.commands.registry, rawVfs);

async function sh(line) {
  return box.shell.execute(line, {});
}

const failures = [];
let checks = 0;
function check(name, condition, detail) {
  checks++;
  if (!condition) failures.push(`${name}: ${detail}`);
}

// ── od ────────────────────────────────────────────────────────────────────

{
  const r = await sh('printf A | od -An -tx1');
  check('od reads a pipe', r.exitCode === 0 && r.stdout === ' 41\n',
    `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
}

{
  const r = await sh('od /tmp/h.txt');
  check('od default matches GNU format', r.stdout ===
    '0000000 062510 066154 026157 053440 071157 062154 005041\n0000016\n',
    JSON.stringify(r.stdout));
}

{
  const r = await sh('od -tx1 /tmp/h.txt');
  check('od -tx1 emits one byte per item', r.stdout ===
    '0000000 48 65 6c 6c 6f 2c 20 57 6f 72 6c 64 21 0a\n0000016\n',
    JSON.stringify(r.stdout));
}

{
  const r = await sh('od -Ad -td2 /tmp/h.txt');
  check('od decimal radix and signed 16-bit words align right', r.stdout ===
    '0000000  25928  27756  11375  22304  29295  25708   2593\n0000014\n',
    JSON.stringify(r.stdout));
}

{
  const r = await sh('od -Ax -tc /tmp/h.txt');
  check('od -tc renders escapes and closes uppercase-hex', r.stdout ===
    '000000   H   e   l   l   o   ,       W   o   r   l   d   !  \\n\n00000E\n',
    JSON.stringify(r.stdout));
}

{
  const r = await sh('od -Ax /tmp/b27.bin');
  check('od row addresses stay lowercase while the closing one does not', r.stdout ===
    '000000 000000 000000 000000 000000 000000 000000 000000 000000\n' +
    '000010 000000 000000 000000 000000 000000 000000\n00001B\n',
    JSON.stringify(r.stdout));
}

{
  const r = await sh('od -td1 /tmp/h.txt');
  check('od -td1 pads decimal bytes to four columns', r.stdout ===
    '0000000   72  101  108  108  111   44   32   87  111  114  108  100   33   10\n0000016\n',
    JSON.stringify(r.stdout));
}

{
  const r = await sh('od -N4 -tx1 /tmp/h.txt');
  check('od -N stops reading at the byte limit', r.stdout ===
    '0000000 48 65 6c 6c\n0000004\n',
    JSON.stringify(r.stdout));
}

{
  const r = await sh('od /tmp/z.bin');
  check('od collapses repeated rows into *', r.stdout ===
    '0000000 000000 000000 000000 000000 000000 000000 000000 000000\n' +
    '*\n0000040 055132\n0000042\n',
    JSON.stringify(r.stdout));
}

{
  const r = await sh('od -v -tx1 /tmp/z.bin');
  check('od -v keeps every row', r.stdout ===
    '0000000 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00\n' +
    '0000020 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00\n' +
    '0000040 5a 5a\n0000042\n',
    JSON.stringify(r.stdout));
}

{
  const empty = await sh("printf '' | od");
  check('od of empty stdin still closes with the offset', empty.exitCode === 0 &&
      empty.stdout === '0000000\n',
    `exit=${empty.exitCode} stdout=${JSON.stringify(empty.stdout)}`);
  const suppressed = await sh("printf '' | od -An -tx1");
  check('od -An on empty input prints nothing at all', suppressed.exitCode === 0 &&
      suppressed.stdout === '',
    `exit=${suppressed.exitCode} stdout=${JSON.stringify(suppressed.stdout)}`);
}

{
  const r = await sh('od -Aq /tmp/h.txt');
  check('od rejects an unknown radix loudly', r.exitCode !== 0 &&
    r.stderr === "od: Radix must be one of [o, d, x, n], got: q\n",
    `exit=${r.exitCode} stderr=${JSON.stringify(r.stderr)}`);
}

{
  const r = await sh('od -q /tmp/h.txt');
  check('od rejects unknown options', r.exitCode !== 0 &&
    r.stderr === "od: invalid option -- 'q'\n",
    `exit=${r.exitCode} stderr=${JSON.stringify(r.stderr)}`);
}

{
  const r = await sh('od /nonexistent');
  check('od reports a missing operand file without an offset trailer', r.exitCode !== 0 &&
    r.stderr === 'od: /nonexistent: No such file or directory\n' && r.stdout === '',
    `exit=${r.exitCode} stderr=${JSON.stringify(r.stderr)} stdout=${JSON.stringify(r.stdout)}`);
}

{
  const which = await sh('which od');
  check('which resolves od', which.stdout === '/usr/bin/od\n',
    JSON.stringify(which.stdout));
}

// ── hexdump ───────────────────────────────────────────────────────────────

{
  const r = await sh(`printf A | hexdump -e '1/1 "%02x"'`);
  check('hexdump formats a pipe through -e', r.exitCode === 0 && r.stdout === '41',
    `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
}

{
  const r = await sh(`hexdump -e '1/1 "%02x"' /tmp/zz.bin`);
  check('hexdump -e without a newline format never stars repeats', r.exitCode === 0 &&
      r.stdout === '0000',
    `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
}

{
  const r = await sh('hexdump /tmp/h.txt');
  check('hexdump default pads the word column to full width', r.stdout ===
    '0000000 6548 6c6c 2c6f 5720 726f 646c 0a21     \n000000e\n',
    JSON.stringify(r.stdout));
}

{
  const r = await sh('hexdump -C /tmp/h.txt');
  check('hexdump -C pairs hex with an ASCII gutter', r.stdout ===
    '00000000  48 65 6c 6c 6f 2c 20 57  6f 72 6c 64 21 0a        |Hello, World!.|\n0000000e\n',
    JSON.stringify(r.stdout));
}

for (const [flag, rows] of [
  ['-x', '0000000    6548    6c6c    2c6f    5720    726f    646c    0a21        \n'],
  ['-d', '0000000   25928   27756   11375   22304   29295   25708   02593        \n'],
  ['-o', '0000000  062510  066154  026157  053440  071157  062154  005041        \n'],
]) {
  const r = await sh(`hexdump ${flag} /tmp/h.txt`);
  check(`hexdump ${flag} renders eight aligned slots`, r.stdout === `${rows}000000e\n`,
    JSON.stringify(r.stdout));
}

{
  const r = await sh('hexdump -C /tmp/z.bin');
  check('hexdump -C suppresses repeated rows after the first', r.stdout ===
    '00000000  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00  |................|\n' +
    '*\n' +
    `00000020  5a 5a${' '.repeat(45)}|ZZ|\n00000022\n`,
    JSON.stringify(r.stdout));
}

{
  const r = await sh('hexdump -v -C /tmp/z.bin');
  check('hexdump -v keeps every canonical row', r.stdout ===
    '00000000  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00  |................|\n' +
    '00000010  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00  |................|\n' +
    `00000020  5a 5a${' '.repeat(45)}|ZZ|\n00000022\n`,
    JSON.stringify(r.stdout));
}

{
  const r = await sh('hexdump -n4 -C /tmp/h.txt');
  check('hexdump -n limits the dump length', r.stdout ===
    `00000000  48 65 6c 6c${' '.repeat(39)}|Hell|\n00000004\n`,
    JSON.stringify(r.stdout));
}

{
  const r = await sh('hexdump /tmp/r.bin');
  check('hexdump default pads short trailing rows to the same width', r.stdout ===
    '0000000 0100 0302 0504 0706 0908 0b0a 0d0c 0f0e\n' +
    '0000010 1110 1312                              \n0000014\n',
    `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
}

{
  const empty = await sh("printf '' | hexdump -C");
  check('hexdump of empty input prints nothing at all', empty.exitCode === 0 && empty.stdout === '',
    `exit=${empty.exitCode} stdout=${JSON.stringify(empty.stdout)}`);
}

{
  const r = await sh(`hexdump -v -e '"%08.8_ax  " 8/1 "%02x " "\\n"' /tmp/h.txt`);
  check('hexdump -e runs the canonical address-plus-bytes format', r.stdout ===
    '00000000  48 65 6c 6c 6f 2c 20 57\n00000008  6f 72 6c 64 21 0a      \n',
    JSON.stringify(r.stdout));
}

{
  const r = await sh("hexdump -e '%Q' /tmp/h.txt");
  check('hexdump -e names an unsupported directive instead of guessing', r.exitCode !== 0 &&
    r.stderr === 'hexdump: bad format {%Q}\n',
    `exit=${r.exitCode} stderr=${JSON.stringify(r.stderr)}`);
}

{
  const r = await sh('hexdump /nonexistent');
  check('hexdump reports every failed operand, the summary line, and fails', r.exitCode === 1 &&
    r.stderr === 'hexdump: /nonexistent: No such file or directory\nhexdump: all input file arguments failed\n',
    `exit=${r.exitCode} stderr=${JSON.stringify(r.stderr)}`);
}

{
  const which = await sh('which hexdump');
  check('which resolves hexdump', which.stdout === '/usr/bin/hexdump\n',
    JSON.stringify(which.stdout));
}

// ── xxd ───────────────────────────────────────────────────────────────────

{
  const r = await sh('printf A | xxd -p');
  check('xxd -p reads a pipe', r.exitCode === 0 && r.stdout === '41\n',
    `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
}

{
  const stdinRow = `00000000: 41${' '.repeat(46)}  A\n`;
  const piped = await sh('printf A | xxd');
  check('xxd dumps stdin without a FILE operand', piped.exitCode === 0 && piped.stdout === stdinRow,
    JSON.stringify(piped.stdout));
  const dash = await sh('printf A | xxd -');
  check('xxd treats - as stdin', dash.exitCode === 0 && dash.stdout === stdinRow,
    JSON.stringify(dash.stdout));
}

{
  const r = await sh('xxd /tmp/h.txt');
  check('xxd rows keep their ASCII column', r.stdout ===
    `00000000: 48 65 6c 6c 6f 2c 20 57 6f 72 6c 64 21 0a${' '.repeat(7)}  Hello, World!.\n`,
    JSON.stringify(r.stdout));
}

{
  const r = await sh('xxd -l 4 /tmp/r.bin');
  check('xxd -l limits the dump', r.exitCode === 0 &&
      r.stdout === `00000000: 00 01 02 03${' '.repeat(37)}  ....\n`,
    `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
}

{
  const r = await sh('xxd -p /tmp/s100.bin');
  const hex = (lo, hi) => Array.from({ length: hi - lo }, (_, i) => (lo + i).toString(16).padStart(2, '0')).join('');
  const lines = r.stdout.split('\n');
  check('xxd -p wraps continuous hex at 60 columns', r.exitCode === 0 &&
      lines.length === 5 && lines[0] === hex(0, 30) && lines[1] === hex(30, 60) &&
      lines[2] === hex(60, 90) && lines[3] === hex(90, 100) && lines[4] === '',
    `lines=${JSON.stringify(lines.map((line) => line.length))}`);
}

{
  const r = await sh('xxd /nonexistent');
  check('xxd reports a missing file and fails', r.exitCode !== 0 &&
    r.stderr === 'xxd: /nonexistent: No such file or directory\n',
    `exit=${r.exitCode} stderr=${JSON.stringify(r.stderr)}`);
}

{
  const empty = await sh('printf "" | xxd');
  check('xxd of empty input prints nothing', empty.exitCode === 0 && empty.stdout === '',
    `exit=${empty.exitCode} stdout=${JSON.stringify(empty.stdout)}`);
}

// ── review follow-ups: failure rc paths and -e numeric surfaces ──────────

root.writeFile('tmp/neg.bin', bytes([0x01, 0x80, 0xff, 0x7f]), { mode: 0o644 });

{
  const odNeg = await sh('od -td1 /tmp/neg.bin');
  check('od -td1 renders signed bytes', odNeg.stdout === '0000000    1 -128   -1  127\n0000004\n',
    JSON.stringify(odNeg.stdout));
}

{
  const r = await sh(`printf A | hexdump -v -e '"%02x\\n"' /nonexistent`);
  check('hexdump -e over a failed operand still fails', r.exitCode === 1 &&
    r.stderr === 'hexdump: /nonexistent: No such file or directory\nhexdump: all input file arguments failed\n',
    `exit=${r.exitCode} stderr=${JSON.stringify(r.stderr)}`);
}

{
  const r = await sh(`hexdump -v -e '1/2 "%u\\n"' /tmp/h.txt`);
  check('hexdump -e %u renders unsigned decimal', r.stdout ===
    '25928\n27756\n11375\n22304\n29295\n25708\n2593\n',
    JSON.stringify(r.stdout));
}

{
  const r = await sh(`hexdump -v -e '1/4 "%x\\n"' /tmp/h.txt`);
  check('hexdump -e 4-byte words assemble exactly and zero-pad the tail', r.stdout ===
    '6c6c6548\n57202c6f\n646c726f\na21\n',
    JSON.stringify(r.stdout));
}

{
  const r = await sh(`hexdump -v -e '1/2 "%d|%u\\n"' /tmp/neg.bin`);
  check('hexdump -e rejects multiple conversions per byte count like util-linux', r.exitCode === 1 &&
    r.stderr === 'hexdump: byte count with multiple conversion characters\n',
    `exit=${r.exitCode} stderr=${JSON.stringify(r.stderr)}`);
}

{
  const r = await sh(`hexdump -e '1/8 "%x\\n"' /tmp/h.txt`);
  check('hexdump -e rejects 8-byte words loudly', r.exitCode === 1 &&
    r.stderr === 'hexdump: bad format {1/8}\n',
    `exit=${r.exitCode} stderr=${JSON.stringify(r.stderr)}`);
}
{
  const r = await sh(`hexdump -e '0/1 "%02x\\n"' /tmp/h.txt`);
  check('hexdump -e rejects zero repeat counts loudly', r.exitCode === 1 &&
    r.stderr === 'hexdump: bad format {0/1}\n',
    `exit=${r.exitCode} stderr=${JSON.stringify(r.stderr)}`);
}


// ── adversarial review: discriminating cases ─────────────────────────────

{
  const piped = await sh('cat /tmp/bin4.bin | xxd -p');
  check('xxd -p receives raw pipe bytes', piped.exitCode === 0 && piped.stdout === 'fffe0041\n',
    JSON.stringify(piped.stdout));
  const odPiped = await sh('cat /tmp/bin4.bin | od -An -tx1');
  check('od receives raw pipe bytes', odPiped.exitCode === 0 && odPiped.stdout === ' ff fe 00 41\n',
    JSON.stringify(odPiped.stdout));
}

{
  const r = await sh('seq 1 5000 | od -N3 -An -tx1');
  check('od -N stops pulling a live producer after the limit', r.exitCode === 0 &&
      r.stdout === ' 31 0a 32\n',
    `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)}`);
}

{
  const r = await sh('hexdump -n 1K -C /tmp/k3.bin');
  check('hexdump -n accepts suffixes and limits reads', r.exitCode === 0 && r.stdout.endsWith('00000400\n'),
    `exit=${r.exitCode} tail=${JSON.stringify(r.stdout.slice(-40))}`);
}

{
  const r = await sh('printf A | od -An -tx1 - -');
  check('a second - operand finds stdin at EOF', r.exitCode === 0 && r.stdout === ' 41\n',
    JSON.stringify(r.stdout));
}

{
  const r = await sh('od -tx1c /tmp/four.bin');
  check('cumulative -t prints one line per type', r.stdout ===
    '0000000  30  31  32  33\n          0   1   2   3\n0000004\n',
    JSON.stringify(r.stdout));
  const noAddress = await sh('od -An -tx1c /tmp/four.bin');
  check('multi-type rows keep their grid without addresses', noAddress.stdout ===
    '  30  31  32  33\n   0   1   2   3\n',
    JSON.stringify(noAddress.stdout));
}

{
  const dump = await sh('xxd /tmp/a.bin /tmp/dump.txt');
  const roundTrip = await sh('cat /tmp/dump.txt');
  const legacyRow = `00000000: 41${' '.repeat(46)}  A\n`;
  check('xxd writes its dump to the output operand', dump.exitCode === 0 && dump.stdout === '' &&
      roundTrip.stdout === legacyRow,
    `dump=${dump.exitCode}/${JSON.stringify(dump.stderr)} cat=${JSON.stringify(roundTrip.stdout)}`);
}

{
  const r = await sh(`hexdump -v -e '1/1 "%02x" "%_ax\\n"' /tmp/four.bin`);
  check('%_ax reports the offset of the next byte to display', r.stdout === '301\n312\n323\n334\n',
    JSON.stringify(r.stdout));
}

{
  const r = await sh(`hexdump -e '1/1 "\"%02x\""' /tmp/a.bin`);
  check('escaped delimiters inside -e units fail like util-linux', r.exitCode !== 0 &&
    r.stderr.startsWith('hexdump: bad format {') && r.stderr.includes('%02x'),
    `exit=${r.exitCode} stderr=${JSON.stringify(r.stderr)}`);
}

{
  const chars = await sh(`hexdump -e '"%c\\n"' /tmp/abcd.bin`);
  check('%c defaults to one-byte units', chars.stdout === 'A\nB\nC\nD\n',
    JSON.stringify(chars.stdout));
  const padded = await sh(`hexdump -e '1/1 "%4c"' /tmp/a.bin`);
  check('%c honors field width', padded.stdout === '   A',
    JSON.stringify(padded.stdout));
  const wide = await sh(`hexdump -e '1/2 "%c"' /tmp/abcd.bin`);
  check('%c rejects multi-byte units like util-linux', wide.exitCode !== 0 &&
    wide.stderr === 'hexdump: bad byte count for conversion character c\n',
    `exit=${wide.exitCode} stderr=${JSON.stringify(wide.stderr)}`);
}

{
  const r = await sh('od -Aod /tmp/h.txt');
  check('od -A requires exactly one radix letter', r.exitCode !== 0 &&
    r.stderr === 'od: Radix must be one of [o, d, x, n], got: od\n',
    `exit=${r.exitCode} stderr=${JSON.stringify(r.stderr)}`);
}

{
  const r = await sh('od -An -tc /tmp/ctrl1.bin');
  check('od -tc renders control bytes as bare three-digit octal', r.stdout === ' 001\n',
    JSON.stringify(r.stdout));
}

{
  const r = await sh(`hexdump -e '1/1 "%05d"' /tmp/one80.bin`);
  check('zero padding keeps the sign in front', r.stdout === '-0128',
    JSON.stringify(r.stdout));
}

{
  const octal = await sh('xxd -l 010 /tmp/r.bin');
  check('xxd -l parses leading-zero lengths as octal', octal.exitCode === 0 &&
      octal.stdout === `00000000: 00 01 02 03 04 05 06 07${' '.repeat(25)}  ........\n`,
    JSON.stringify(octal.stdout));
  const hex = await sh('od -N 0x8 -An -tx1 /tmp/h.txt');
  check('od -N parses hexadecimal counts', hex.stdout === ' 48 65 6c 6c 6f 2c 20 57\n',
    JSON.stringify(hex.stdout));
}

{
  const reader = staticStdinReader('héllo\n');
  const b1 = await reader.readBytes(1);
  const b2 = await reader.readBytes(1);
  check('adapter readBytes counts bytes, not code units', b1?.[0] === 0x68 && b2?.[0] === 0xc3,
    `${b1} ${b2}`);
  // After a consumer splits mid code point, the text view faithfully shows
  // the replacement char for the orphaned continuation byte — same as
  // reading the leftover bytes off Unix pipes.
  const line = await reader.readLine();
  const rest = await reader.read();
  check('adapter text reads stay byte-faithful after byte splits',
    line === '\uFFFDllo' && rest === null,
    `line=${JSON.stringify(line)} rest=${JSON.stringify(rest)}`);
}

{
  const heredoc = await sh("xxd -p <<EOF\nh\u00e9llo\nEOF");
  check('heredoc stdin streams bounded windows through xxd -p', heredoc.exitCode === 0 &&
      heredoc.stdout === '68c3a96c6c6f0a\n',
    `exit=${heredoc.exitCode} stdout=${JSON.stringify(heredoc.stdout)} stderr=${JSON.stringify(heredoc.stderr)}`);
}

for (const cmd of ['xxd -l0 /nonexistent', 'od -N0 /nonexistent', 'hexdump -n0 /nonexistent']) {
  const r = await sh(cmd);
  check(`zero limit still reports the open error (${cmd})`, r.exitCode !== 0 &&
      r.stderr.includes('No such file or directory'),
    `exit=${r.exitCode} stderr=${JSON.stringify(r.stderr)}`);
}

{
  const r = await sh("printf '' | hexdump /nonexistent -");
  check('an opened empty stdin prevents the all-failed summary', r.exitCode === 1 &&
      r.stderr === 'hexdump: /nonexistent: No such file or directory\n' && r.stdout === '',
    `exit=${r.exitCode} stderr=${JSON.stringify(r.stderr)}`);
}

{
  const dump = await sh('xxd /tmp/k3.bin /tmp/bigdump.txt');
  const sized = await sh('wc -c /tmp/bigdump.txt');
  const head = await sh('head -1 /tmp/bigdump.txt');
  check('output-operand dumps land incrementally and completely', dump.exitCode === 0 &&
      sized.stdout.trim() === '14784 /tmp/bigdump.txt' &&
      head.stdout.startsWith('00000000: 00 00'),
    `dump=${dump.exitCode} size=${JSON.stringify(sized.stdout)} head=${JSON.stringify(head.stdout.slice(0,30))}`);
}

{
  const mixed = await sh(`hexdump -v -e '2/1 "%02x" 1/1 "%02x " "\n"' /tmp/four.bin`);
  check('unit-local trim: count-1 tail unit keeps its space', mixed.stdout ===
    '303132 \n33     \n',
    JSON.stringify(mixed.stdout));
}

{
  root.writeFile('tmp/existing.txt', 'KEEP', { mode: 0o644 });
  const r = await sh('xxd /nonexistent /tmp/existing.txt');
  const kept = await sh('cat /tmp/existing.txt');
  check('failed input preserves an existing output file untouched', r.exitCode === 1 &&
      r.stderr === 'xxd: /nonexistent: No such file or directory\n' &&
      kept.stdout === 'KEEP',
    `exit=${r.exitCode} stderr=${JSON.stringify(r.stderr)} kept=${JSON.stringify(kept.stdout)}`);
}

{
  // Inject a mid-stream writeRange failure after the first flushed block.
  const original = rawVfs.writeRange.bind(rawVfs);
  let injected = false;
  rawVfs.writeRange = (path, off, chunk) => {
    if (!injected && off >= 65536 && String(path).endsWith('mid.txt')) {
      injected = true;
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    }
    return original(path, off, chunk);
  };
  try {
    const r = await sh('xxd /tmp/big.bin /tmp/mid.txt');
    check('a mid-stream write failure is labeled and fails the dump',
      r.exitCode === 1 && r.stderr.includes('xxd: /tmp/mid.txt'),
      `exit=${r.exitCode} stderr=${JSON.stringify(r.stderr)}`);
  } finally {
    rawVfs.writeRange = original;
  }
}
{
  const r = await sh('xxd -p < /tmp/big.bin | wc -l');
  check('a >64KiB redirect streams intact to xxd -p', r.exitCode === 0 &&
      r.stdout.trim() === '2334',
    `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)}`);
}

{
  // A read()-only embedder whose first chunk exceeds one pull window and
  // carries a multibyte sequence: every byte must land exactly once.
  const chunks = ['\u00e9A', 'B'];
  // Prototype-less so the wrap layer cannot stringify the reader away.
  const readOnly = Object.assign(Object.create(null), { read: async () => chunks.shift() ?? null });
  // Registry-level invocation supplies the full typed CommandContext
  // (cred/vfs/signal/setUmask/runAs) that credentialed coreutils require.
  const od = await box.commands.registry.resolve('od');
  let outText = '';
  let errText = '';
  const exitCode = await od({
    args: ['-An', '-tx1', '-N3'],
    cwd: '/tmp',
    env: {},
    pid: 1,
    cred: CRED_KERNEL,
    vfs: rawVfs.as(CRED_KERNEL),
    stdin: readOnly,
    stdout: { write: (t) => { outText += t; } },
    stderr: { write: (t) => { errText += t; } },
    signal: new AbortController().signal,
    setUmask: () => {},
    runAs: async () => 0,
  });
  check('read()-only embedders stream multibyte input without loss or duplication',
    exitCode === 0 && outText === ' c3 a9 41\n',
    `exit=${exitCode} stdout=${JSON.stringify(outText)} stderr=${JSON.stringify(errText)}`);
}
box.destroy();

console.log(failures.length === 0 ? `\nALL PASS (${checks} checks)` : `\n${failures.length} FAILED (${checks} checks)`);
for (const failure of failures) console.log(failure);
process.exit(failures.length === 0 ? 0 : 1);
