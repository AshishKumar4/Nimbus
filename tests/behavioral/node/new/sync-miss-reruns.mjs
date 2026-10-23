#!/usr/bin/env bun
// node/new/sync-miss-reruns — a node one-shot whose synchronous read finds a
// file its process does not hold is run again as a resident process, which
// holds it: the command gets the bytes on its first run, prints what it
// printed before that read once, and ends with its own status after its
// asynchronous work. Its next launch stages the file and runs as a one-shot.
// The read is readFileSync after an accessSync of the file, a require() of a
// JSON file, a readSync of a descriptor, or readFileSync of a wasm module the
// program then compiles, which a Worker compiles only from its launch's map.
//
// Each file lies outside the working tree and is named only on the command
// line, so no launch rule stages it before a run has read it.
//
// Red before: the read failed with EAGAIN, and the run ended 1 with a report
// that the file was not staged; only the next run of the command had it.
import { mintSession, deleteSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('node/new/sync-miss-reruns');

const PAYLOAD = Object.fromEntries(['x', 'y', 'w'].map((name) => [name, `${name}-${crypto.randomUUID()}`]));
const JSON_VALUE = `z-${crypto.randomUUID()}`;
// (module (func (export "answer") (result i32) i32.const 42))
const WASM_BYTES = [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 10, 1, 6, 97, 110, 115, 119, 101, 114, 0, 0, 10, 6, 1, 4, 0, 65, 42, 11];
// Each prints BEFORE, reads its file synchronously, and after its asynchronous
// work prints what it read and ends with its second argument as its status.
const PROGRAMS = {
  'read.js': `
const fs = require('fs');
fs.accessSync(process.argv[2]);
console.log('BEFORE');
const text = fs.readFileSync(process.argv[2], 'utf8').trim();
setTimeout(() => { console.log('READ=' + text); process.exitCode = Number(process.argv[3] ?? 0); }, 200);
`,
  'require.js': `
console.log('BEFORE');
const value = require(process.argv[2]).value;
setTimeout(() => { console.log('READ=' + value); process.exitCode = Number(process.argv[3] ?? 0); }, 200);
`,
  'wasm.js': `
const fs = require('fs');
console.log('BEFORE');
const bytes = fs.readFileSync(process.argv[2]);
const module = new WebAssembly.Module(bytes);
setTimeout(() => { console.log('READ=' + WebAssembly.Module.exports(module).map((e) => e.name).join(',')); process.exitCode = Number(process.argv[3] ?? 0); }, 200);
`,
  'descriptor.js': `
const fs = require('fs');
console.log('BEFORE');
const fd = fs.openSync(process.argv[2], 'r');
const bytes = Buffer.alloc(256);
const text = bytes.subarray(0, fs.readSync(fd, bytes, 0, 256, 0)).toString().trim();
fs.closeSync(fd);
setTimeout(() => { console.log('READ=' + text); process.exitCode = Number(process.argv[3] ?? 0); }, 200);
`,
};
const lines = (text) => stripAnsi(text).split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('[nimbus-debug]'));

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  for (const line of ['mkdir -p /home/user/d21/app /home/user/d21-data',
    ...Object.entries(PAYLOAD).map(([name, text]) => heredocCommand(`/home/user/d21-data/${name}.txt`, text)),
    heredocCommand('/home/user/d21-data/z.json', JSON.stringify({ value: JSON_VALUE })),
    // A module exporting a function named \`answer\`, compiled from the bytes the program reads.
    `node -e 'require("fs").writeFileSync("/home/user/d21-data/m.wasm", Buffer.from([${WASM_BYTES.join(',')}]))'`,
    ...Object.entries(PROGRAMS).map(([name, code]) => heredocCommand(`/home/user/d21/app/${name}`, code)), 'cd /home/user/d21/app']) {
    const r = await t.run(line, 30_000);
    if (r.exitCode !== 0) throw new Error(`setup failed: ${line.slice(0, 60)}: ${r.output.slice(-300)}`);
  }
  // A status of 0 shows the output as it was printed; another status shows the process's log again under it.
  for (const [run, program, file, expected, status] of [
    ['first', 'read.js', 'x.txt', PAYLOAD.x, 0],
    ['second', 'read.js', 'x.txt', PAYLOAD.x, 0],
    ['another file, status 3', 'read.js', 'y.txt', PAYLOAD.y, 3],
    ['a require', 'require.js', 'z.json', JSON_VALUE, 0],
    ['a descriptor', 'descriptor.js', 'w.txt', PAYLOAD.w, 0],
    ['a wasm module it compiles', 'wasm.js', 'm.wasm', 'answer', 0],
  ]) {
    const r = await t.run(`node ${program} /home/user/d21-data/${file} ${status}`, 120_000);
    const said = lines(r.output);
    console.log(JSON.stringify({ run, exit: r.exitCode, said }));
    a.check(`${run} run: it read the file, after its asynchronous work, and ended with its own status (${status})`,
      said.includes(`READ=${expected}`) && r.exitCode === status, JSON.stringify({ exit: r.exitCode, said }));
    a.check(`${run} run: no read failed`, !said.some((line) => /EAGAIN|never staged|did not retrace/.test(line)), JSON.stringify(said));
    if (status === 0) {
      a.check(`${run} run: what it printed is shown once`,
        said.filter((line) => line === 'BEFORE').length === 1 && said.filter((line) => line.startsWith('READ=')).length === 1, JSON.stringify(said));
    }
  }
} catch (error) {
  a.check('probe completes', false, String(error?.stack ?? error).slice(0, 2000));
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
