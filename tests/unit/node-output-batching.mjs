#!/usr/bin/env bun
// A node program's output to a pipe: the writes it makes while one relay call
// is on its way go together in the next (manager.ts __queueRpcWrite), so a
// loop of console.logs costs a call per 64 KiB, not a round trip a line.
// What has to hold besides: every byte, in order, on each stream and across
// them; the offsets a stop's replay is checked by; and a fatal report after
// everything written before it.

import assert from 'node:assert/strict';

import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { createAuthority } from './lib/resident-body.mjs';
import { oneShotManager, runnerLoader } from './lib/one-shot-runner.mjs';
import { opSender, supervisorDouble } from './lib/supervisor-double.mjs';

const { host, rawVfs } = createAuthority();

/** Every relay call, as the session is asked it: its stream, its text, and where it falls. */
let calls = [];
let slow = 0;
const dec = new TextDecoder();
adoptCtxExports({
  SupervisorRPC: /** @type {any} */ (({ props }) => {
    const send = opSender((envelope) => host.supervisorOp({ ...envelope, pid: props?.pid }));
    return supervisorDouble(async (op, args) => {
      if (op === 'stdout' || op === 'stderr') {
        calls.push({ op, text: dec.decode(/** @type {Uint8Array} */ (args[0])), at: args[1] });
        // A call on its way for a while, as one to the session is.
        if (slow > 0) await new Promise((resolve) => setTimeout(resolve, slow));
        return;
      }
      if (op === 'reportExit') return;
      return send(op, args);
    });
  }),
});

const manager = oneShotManager('node-output-batching', { host, rawVfs, loader: runnerLoader('node-output-batching') });

async function run(program, delayMs = 0) {
  calls = [];
  slow = delayMs;
  const real = { console: globalThis.console, process: globalThis.process, Buffer: globalThis.Buffer };
  let result;
  try {
    result = await manager.exec(program, { filename: '<eval>', dirname: '/home/user', cwd: '/home/user', argv: [], captureOutput: false });
  } finally { Object.assign(globalThis, real); }
  const text = (op) => calls.filter((c) => c.op === op).map((c) => c.text).join('');
  return { result, calls, stdout: text('stdout'), stderr: text('stderr') };
}

/** Each stream's calls carry on from where its last one ended. */
function contiguous(list) {
  const end = { stdout: 0, stderr: 0 };
  for (const c of list) {
    if (c.at === undefined) continue;
    assert.equal(c.at, end[c.op], `a ${c.op} call at ${c.at} after ${end[c.op]} bytes`);
    end[c.op] += new TextEncoder().encode(c.text).byteLength;
  }
}

{
  const N = 200_000;
  const { result, calls: made, stdout } = await run(`for (let i = 0; i < ${N}; i++) console.log(i);`);
  assert.equal(result.exitCode, 0, result.stderr);
  const lines = stdout.split('\n');
  assert.equal(lines.length, N + 1);
  assert.equal(lines[0], '0');
  assert.equal(lines[N - 1], String(N - 1), 'the last line');
  assert.equal(lines[N], '');
  const bytes = new TextEncoder().encode(stdout).byteLength;
  assert.ok(made.length <= Math.ceil(bytes / (64 * 1024)) + 1, `${made.length} relay calls for ${bytes} bytes`);
  assert.ok(made.every((c) => new TextEncoder().encode(c.text).byteLength <= 64 * 1024), 'a call carried more than 64 KiB');
  contiguous(made);
}

{
  // Each call on its way for a while: what is written meanwhile goes in the next.
  const { calls: made, stdout } = await run('let i = 0; const t = setInterval(() => { for (let k = 0; k < 50; k++) console.log(i++); if (i >= 1000) clearInterval(t); }, 1);', 5);
  assert.equal(stdout, Array.from({ length: 1000 }, (_, i) => `${i}\n`).join(''));
  assert.ok(made.length < 1000 / 2, `${made.length} calls for 1000 lines written while calls were on their way`);
  contiguous(made);
}

{
  // The streams interleaved: no call carries both, and their order is the order written.
  const { calls: made } = await run('for (let i = 0; i < 300; i++) { console.log("o" + i); if (i % 3 === 0) console.error("e" + i); }');
  const expected = [];
  for (let i = 0; i < 300; i++) { expected.push(['stdout', `o${i}\n`]); if (i % 3 === 0) expected.push(['stderr', `e${i}\n`]); }
  const merged = [];
  for (const c of made) {
    const last = merged.at(-1);
    if (last && last[0] === c.op) last[1] += c.text; else merged.push([c.op, c.text]);
  }
  const grouped = [];
  for (const [op, text] of expected) {
    const last = grouped.at(-1);
    if (last && last[0] === op) last[1] += text; else grouped.push([op, text]);
  }
  assert.deepEqual(merged, grouped, 'stdout and stderr out of the order they were written in');
  contiguous(made);
}

{
  // A fatal report comes after every write before it, though they are still in a batch on its way.
  const { result, calls: made } = await run('for (let i = 0; i < 500; i++) console.log(i); throw new Error("boom");', 5);
  assert.notEqual(result.exitCode, 0);
  const sequence = made.map((c) => c.text).join('');
  const last = sequence.indexOf('499\n');
  const fatal = sequence.indexOf('Error: boom');
  assert.ok(last !== -1 && fatal !== -1, sequence.slice(-400));
  assert.ok(last < fatal, 'the fatal report came before what was written ahead of it');
  const report = made.findIndex((c) => c.text.includes('Error: boom'));
  assert.ok(made.slice(report).every((c) => c.op === 'stderr' && !/^\d+\n/.test(c.text)), 'a write made before the fatal report was sent after it');
}

console.log('ok - node-output-batching (writes made while a relay call is out go in one call, in order, at their offsets)');
