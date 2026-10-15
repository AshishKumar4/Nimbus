#!/usr/bin/env bun
// A program's standard input and terminal, as Node gives them (X-1, X-2): run
// through the public workspace API, a program writes exactly what real `node`
// writes running it, fed the same input through the same pipeline.
//
//   - process.stdin is a Readable over fd 0: 'data' as each piece arrives
//     (before the input ends), async iteration, pipe into stdout, and
//     readline over it, the engine's own, as Node's is;
//   - a program that never reads, or pauses stdin, does not wait for it;
//   - its process hears 'exit' as it ends, by itself, by process.exit() or
//     of an error nothing caught, and its listeners decide its status;
//   - readFileSync(0) and the stream read one fd 0;
//   - tty.WriteStream(fd) writes to that descriptor, in order with
//     process.stdout; isatty answers for each descriptor; a descriptor that is
//     not one, or a file, is refused as Node refuses it.
//
// And in a terminal (no oracle: a terminal Node is not available here),
// as Node documents: process.stdin and stdout are the tty module's streams,
// isatty is true, the window is COLUMNS x LINES, a typed line is read as it
// is typed, and setRawMode hands the terminal's keys to the program.
//
// Red before: process.stdin was a stub whose 'data' never fired, 'exit'
// was never emitted on a program's process, tty's
// streams were joined to no descriptor (a WriteStream's writes went nowhere),
// isatty was always false, readline was lifo's own (a line split across two
// pieces came out as two), and process.stdout.isTTY was false with 80
// columns whatever it was.
//
// Under Bun against the source, then under node against the built package
// (packages/core/dist: rebuild first).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostSqlite } from './lib/host-sqlite.mjs';

const underBun = typeof process.versions.bun === 'string';
const { NimbusWorkspace } = await import(underBun
  ? '../../packages/core/src/workspace/nimbus-workspace.ts'
  : '../../packages/core/dist/workspace/nimbus-workspace.js');

/** How long from the program's start it ended: Node runs on while it waits for its input, and not otherwise. */
const timed = "const started = Date.now(); process.on('exit', () => console.log(Date.now() - started < 1500 ? 'did not wait' : 'waited'));";

/** Each case: a program, and the shell line that runs it ({prog} is its name). */
const cases = {
  'data.js': ["process.stdin.on('data', (c) => console.log('got', Buffer.isBuffer(c), JSON.stringify(String(c)))); process.stdin.on('end', () => console.log('end'));",
    '{ printf a; sleep 0.3; printf b; } | node {prog}'],
  'encoding.js': ["process.stdin.setEncoding('utf8'); let s = ''; process.stdin.on('data', (c) => { s += c; console.log(typeof c); }); process.stdin.on('end', () => console.log(JSON.stringify(s)));",
    'node {prog} < utf8.txt'],
  'iterate.js': ["(async () => { const parts = []; for await (const c of process.stdin) parts.push(String(c)); console.log(JSON.stringify(parts.join(''))); })();",
    "{ printf 'one '; sleep 0.2; printf two; } | node {prog}"],
  'pipe.js': ["process.stdin.pipe(process.stdout); process.stdin.on('end', () => setTimeout(() => process.stdout.write('after\\n'), 10));",
    "printf 'piped\\n' | node {prog}"],
  'readline.js': ["const rl = require('readline').createInterface({ input: process.stdin }); rl.on('line', (l) => console.log('line', JSON.stringify(l))); rl.on('close', () => console.log('close'));",
    "{ printf 'one\\n\\ntwo\\nthr'; sleep 0.3; printf 'ee\\n'; } | node {prog}"],
  'question.js': ["const rl = require('readline/promises').createInterface({ input: process.stdin, output: process.stdout }); rl.question('name? ').then((a) => { console.log('hi', a); rl.close(); });",
    'echo bob | node {prog}'],
  'never.js': [`${timed} console.log('never reads');`,
    '{ sleep 3; echo late; } | node {prog}'],
  'paused.js': [`${timed} process.stdin.on('data', () => {}); process.stdin.pause(); console.log('paused');`,
    '{ sleep 3; echo late; } | node {prog}'],
  'whole.js': ["const all = require('fs').readFileSync(0, 'utf8'); console.log(JSON.stringify(all)); process.stdin.on('data', (c) => console.log('more', String(c))).on('end', () => console.log('end'));",
    "printf 'all of it' | node {prog}"],
  'empty.js': ["process.stdin.on('data', (c) => console.log('data', String(c))).on('end', () => console.log('end'));",
    'node {prog} < /dev/null'],
  'isatty.js': ["const tty = require('tty'); console.log(String(process.stdin.isTTY), String(process.stdout.isTTY), String(process.stderr.isTTY), tty.isatty(0), tty.isatty(1), tty.isatty(2), tty.isatty(7), tty.isatty(-1), String(process.stdout.columns), String(process.stdout.rows), process.stdout instanceof tty.WriteStream, process.stdin instanceof tty.ReadStream);",
    'echo x | node {prog} | cat'],
  'writestream.js': ["const tty = require('tty'); const one = new tty.WriteStream(1); one.write('via tty 1\\n'); process.stdout.write('via stdout\\n'); new tty.WriteStream(2).write('via tty 2\\n'); console.log(one.isTTY, typeof one.columns, one.fd); for (const fd of [9, -1]) { try { new tty.WriteStream(fd); console.log('made', fd); } catch (e) { console.log(fd, e.name, e.code, e.message); } }",
    'node {prog} 2>&1 | cat'],
  'exitcode.js': ["process.on('exit', (code) => console.log('exit', code, process.exitCode)); process.exitCode = 3;",
    'node {prog}; echo status $?'],
  'exitcall.js': ["process.on('exit', (code) => { console.log('exit', code, process.exitCode); process.exitCode = 5; }); setTimeout(() => console.log('never'), 50); process.exit(2);",
    'node {prog}; echo status $?'],
  'exitfatal.js': ["process.on('exit', (code) => console.log('exit', code)); setTimeout(() => { throw 1; }, 0);",
    'node {prog} 2>/dev/null; echo status $?'],
  'filefd.js': ["const tty = require('tty'); try { new tty.WriteStream(1); console.error('made'); } catch (e) { console.error(e.name, e.code, e.message); }",
    'node {prog} > out.txt; cat out.txt'],
};

/** `promise`, or a failure naming `what` once `ms` pass: a program that waits forever fails its case, not the run. */
const within = (ms, promise, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: still running after ${ms} ms`)), ms))]);

const { sql, transactions } = await hostSqlite();
let terminalOutput = '';
const terminal = {
  write(data) { terminalOutput += data; }, writeln(data) { terminalOutput += `${data}\n`; }, onData() {},
  cols: 80, rows: 24, focus() {}, clear() {},
};
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1, terminal });
const host = mkdtempSync(join(tmpdir(), 'lifo-node-stdio-'));
const failed = [];
try {
  // A file of bytes on both sides: a two-byte character, then a newline.
  const utf8 = new Uint8Array([0x68, 0xc3, 0xa9, 0x0a]);
  await ws.fs.writeFile('/home/user/utf8.txt', utf8);
  writeFileSync(join(host, 'utf8.txt'), utf8);
  for (const [name, [source, line]] of Object.entries(cases)) {
    const command = line.replaceAll('{prog}', name);
    await ws.fs.writeFile(`/home/user/${name}`, source);
    writeFileSync(join(host, name), source);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_NO_WARNINGS' && key !== 'NODE_OPTIONS'));
    const node = spawnSync('sh', ['-c', command], { cwd: host, env, encoding: 'utf8', timeout: 60_000 });
    let lifo;
    try {
      lifo = await within(30_000, ws.exec(command, { cwd: '/home/user' }), name);
    } catch (error) {
      failed.push(`${name}: ${command}\n  node (exit ${node.status}): ${JSON.stringify(node.stdout + node.stderr)}\n  lifo: ${error.message}`);
      continue;
    }
    if (lifo.exitCode !== node.status || lifo.stdout !== node.stdout || lifo.stderr !== node.stderr) {
      failed.push(`${name}: ${command}\n  node (exit ${node.status}): ${JSON.stringify(node.stdout + node.stderr)}\n  lifo (exit ${lifo.exitCode}): ${JSON.stringify(lifo.stdout + lifo.stderr)}`);
    }
  }

  // ── in a terminal ─────────────────────────────────────────────────────────
  // A failure here is reported with the oracle's, not instead of them.
  try {
  const shell = ws.shell;
  const settle = async (until, what) => {
    for (let i = 0; i < 400 && !until(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(until(), `${what}: ${JSON.stringify(terminalOutput.slice(-400))}`);
  };
  await ws.fs.writeFile('/home/user/term.js', [
    "const tty = require('tty');",
    "console.log('tty', process.stdin.isTTY, process.stdout.isTTY, tty.isatty(0), tty.isatty(1), tty.isatty(2), process.stdout.columns, process.stdout.rows, process.stdout instanceof tty.WriteStream, process.stdin instanceof tty.ReadStream);",
    "process.stdin.once('data', (c) => { console.log('typed', JSON.stringify(String(c))); process.stdin.setRawMode(true); console.log('raw', process.stdin.isRaw);",
    "  process.stdin.once('data', (k) => { console.log('key', JSON.stringify(String(k))); process.stdin.setRawMode(false); process.stdin.pause(); }); });",
  ].join('\n'));
  terminalOutput = '';
  const ran = shell.executeLine('COLUMNS=120 LINES=40 node term.js');
  await settle(() => terminalOutput.includes('tty '), 'the program starts');
  assert.match(terminalOutput, /tty true true true true true 120 40 true true/, 'in a terminal, the streams are the tty module\'s and the window is COLUMNS x LINES');
  for (const ch of 'hello') shell.handleInput(ch);
  shell.handleInput('\r');
  await settle(() => terminalOutput.includes('typed '), 'a typed line is read as it is typed');
  assert.match(terminalOutput, /typed "hello\\n"/);
  await settle(() => terminalOutput.includes('raw true'), 'setRawMode(true)');
  shell.handleInput('q');
  await settle(() => terminalOutput.includes('key '), 'a key in raw mode reaches the program without Enter');
  assert.match(terminalOutput, /key "q"/);
  await within(10_000, ran, 'the program in the terminal');
  } catch (error) {
    failed.push(`in a terminal: ${error.message}`);
  }
} finally {
  rmSync(host, { recursive: true, force: true });
  await within(10_000, ws.close(), 'the workspace closes').catch((error) => failed.push(error.message));
}

if (underBun) {
  // Under node whatever Bun answered, so a red run shows both.
  const node = spawnSync('node', ['--no-warnings', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 180_000 });
  assert.deepEqual(failed, [], `bun: lifo's node reads and writes its stdio as real node does:\n${failed.join('\n')}\n\nunder node (exit ${node.status}):\n${node.stdout}${node.stderr}`);
  assert.equal(node.status, 0, `under node:\n${node.stdout}${node.stderr}`);
  assert.match(node.stdout, /^ok - under node/m, node.stdout);
  console.log('ok - lifo-node-stdio (stdin, tty and isatty as node has them; under Bun and Node)');
} else {
  assert.deepEqual(failed, [], `node: lifo's node reads and writes its stdio as real node does:\n${failed.join('\n')}`);
  console.log('ok - under node');
}
