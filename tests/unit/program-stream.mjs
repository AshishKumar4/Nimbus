#!/usr/bin/env bun
// A started program across a session's RPC or HTTP body (Kinu ask 67):
// encodeProgramStream / decodeProgramStream carry the start's answer (its
// pid, or Node's spawn error with its own properties), its output as its
// reader takes it, and its exit (waitpid's code or signal); cancelling the
// stream before the start cancels the start, after it kills the program,
// read or not. A caller that gives up on the start (its AbortSignal) cancels
// the stream. Round-tripped here over a workspace's startProgram, the frames
// split at every byte boundary on the way.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { decodeProgramStream, encodeProgramStream } from '../../packages/core/src/runtime/program-stream.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions });
const program = (argv, extra = {}) => ({ argv, env: { PATH: '/usr/bin:/bin' }, cwd: '/home/user', stdin: null, ...extra });

/** `wire` re-chunked a byte at a time: frames arrive split anywhere. */
function byteByByte(wire) {
  const reader = wire.getReader();
  let held = new Uint8Array(0);
  return new ReadableStream({
    async pull(controller) {
      if (held.length === 0) {
        const next = await reader.read();
        if (next.done) return controller.close();
        held = next.value;
      }
      controller.enqueue(held.subarray(0, 1));
      held = held.subarray(1);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}
const signals = [];
const across = (argv, extra) => decodeProgramStream(
  byteByByte(encodeProgramStream((cancel) => ws.startProgram(program(argv, extra), cancel))),
  (pid, signal) => { signals.push(signal); ws.children.kill(pid, signal); },
);
async function finish(started) {
  const out = [];
  for await (const chunk of started.output) out.push(...chunk.data);
  return { out: new TextDecoder().decode(new Uint8Array(out)), exit: await started.exit };
}

try {
  let started = await across(['sh', '-c', 'echo out; echo err >&2; exit 4']);
  assert.equal(typeof started.pid, 'number');
  assert.deepEqual(await finish(started), { out: 'out\nerr\n', exit: { code: 4, signal: null } });

  await assert.rejects(across(['no-such-program', '-x']), (error) => {
    assert.deepEqual([error.message, error.code, error.errno, error.syscall, error.path, error.spawnargs],
      ['spawn no-such-program ENOENT', 'ENOENT', -2, 'spawn no-such-program', 'no-such-program', ['-x']]);
    return true;
  });

  const input = new Uint8Array(256).map((_, i) => i);
  started = await across(['cat'], { stdin: new ReadableStream({ start(c) { c.enqueue(input); c.close(); } }) });
  const echoed = [];
  for await (const chunk of started.output) echoed.push(...chunk.data);
  assert.deepEqual(echoed, [...input], 'bytes, every value');

  started = await across(['sleep', '600']);
  started.kill('SIGINT');
  assert.deepEqual((await finish(started)).exit, { code: null, signal: 'SIGINT' });
  assert.deepEqual(signals, ['SIGINT']);

  // A reader that goes away after the start: the program is killed.
  const wire = encodeProgramStream((cancel) => ws.startProgram(program(['sleep', '600']), cancel));
  const reader = wire.getReader();
  await reader.read();
  await reader.cancel();
  let killed = false;
  for (let i = 0; i < 200 && !killed; i++) {
    killed = ws.processes.getAll().every((entry) => !(entry.command === 'sleep 600' && entry.state === 'running'));
    if (!killed) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(killed, 'its program ends with its reader');

  const sleeping = () => ws.processes.getAll().some((entry) => entry.command === 'sleep 600' && entry.state === 'running');
  /** Waits, up to two seconds, for `holds()`. */
  const until = async (holds) => {
    for (let i = 0; i < 200 && !holds(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    return holds();
  };
  // Each of what follows is checked on its own, so a run shows every one's verdict.
  const failures = [];
  const check = async (name, body) => {
    try {
      await body();
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    }
  };

  await check('cancelled unread, after its start', async () => {
    const unread = encodeProgramStream((cancel) => ws.startProgram(program(['sleep', '600']), cancel));
    // Its broker child is under the parent the start made; a local sleep is running well within the pause after.
    const child = () => {
      const parents = new Set(ws.processes.getAll().filter((entry) => entry.command === 'sleep 600').map((entry) => entry.pid));
      return ws.processes.getAll().some((entry) => parents.has(entry.parentPid));
    };
    assert.ok(await until(child), 'it runs before anyone reads');
    await new Promise((resolve) => setTimeout(resolve, 200));
    await unread.cancel();
    assert.ok(await until(() => !sleeping()), 'an unread stream cancelled kills what it started');
  });

  await check('given up before the answer', async () => {
    const gaveUp = new AbortController();
    gaveUp.abort();
    await assert.rejects(decodeProgramStream(
      encodeProgramStream((cancel) => ws.startProgram(program(['sleep', '600']), cancel)),
      () => {},
      gaveUp.signal,
    ), { code: 'ECANCELED' });
    assert.ok(await until(() => !sleeping()), 'nothing of it runs on');
  });

  assert.deepEqual(failures, []);
} finally {
  await ws.close();
}
console.log('program-stream: a started program crosses a byte stream of frames whole');
