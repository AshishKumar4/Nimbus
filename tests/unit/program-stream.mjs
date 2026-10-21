#!/usr/bin/env bun
// A started program across a session's RPC or HTTP body (Kinu ask 67):
// encodeProgramStream / decodeProgramStream carry the start's answer (its
// pid, or Node's spawn error with its own properties), its output as its
// reader takes it, and its exit (waitpid's code or signal); cancelling the
// stream before the start cancels the start, after it kills the program,
// read or not. A caller that gives up on the start (its AbortSignal) cancels
// the stream. Its exit is waited for apart from the stream (waitProgram),
// so it is seen with any of its output unread, a killed program's too. Its
// input is fed by one feeder on every transport: a source that fails ends
// the input, and a write that fails ends it too, or says it could not.
// A wait that fails kills the program rather than leave it running unseen.
// Round-tripped here over a workspace's startProgram, the frames split at
// every byte boundary on the way, and through the SDK over the remote API.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { decodeProgramStream, encodeProgramStream } from '../../packages/core/src/runtime/program-stream.ts';
import * as programStart from '../../packages/core/src/runtime/program-start.ts';
import * as programmatic from '../../packages/worker/src/session/programmatic.ts';
import { handleNimbusRemoteApi } from '../../packages/worker/src/router/remote-api.ts';
import { Nimbus } from '../../packages/sdk/src/index.ts';
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
const control = {
  signal: (pid, signal) => { signals.push(signal); ws.children.kill(pid, signal); },
  wait: (pid) => ws.waitProgram(pid, 1000),
};
const across = (argv, extra) => decodeProgramStream(byteByByte(encodeProgramStream((cancel) => ws.startProgram(program(argv, extra), cancel))), control);
/** `promise`, or a rejection once `ms` have passed. */
async function within(promise, ms) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`not settled within ${ms} ms`)), ms); });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}
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
      control,
      gaveUp.signal,
    ), { code: 'ECANCELED' });
    assert.ok(await until(() => !sleeping()), 'nothing of it runs on');
  });

  await check('an exit with its output unread', async () => {
    const quiet = await across(['true']);
    assert.deepEqual(await within(quiet.exit, 5000), { code: 0, signal: null });
  });

  await check('an exit after exactly a pipe\'s worth, unread', async () => {
    // One chunk that fills what is read ahead, then the exit.
    const ended = Promise.resolve({ code: 0, signal: null });
    const full = encodeProgramStream(async () => ({
      pid: 9,
      output: new ReadableStream({ start(c) { c.enqueue({ stream: 'stdout', data: new Uint8Array(64 * 1024) }); c.close(); } }),
      exit: ended,
      kill() {},
    }));
    const started = await decodeProgramStream(full, { signal() {}, wait: () => ended });
    assert.deepEqual(await within(started.exit, 5000), { code: 0, signal: null });
  });

  await check('a killed program, its output unread', async () => {
    // More output than any read-ahead holds, then a wait: only the kill ends it.
    await ws.filesystem.vfs.writeFile('/home/user/big.bin', new Uint8Array(1024 * 1024).fill(0x61));
    const loud = await across(['sh', '-c', 'cat /home/user/big.bin; sleep 600']);
    await new Promise((resolve) => setTimeout(resolve, 200));
    loud.kill('SIGKILL');
    assert.deepEqual(await within(loud.exit, 5000), { code: null, signal: 'SIGKILL' });
    await loud.output.cancel();
  });

  await check('a cancel as the start is answered', async () => {
    // The start answers just after the reader has gone, while a read of the stream waits on it.
    let answer;
    const kills = [];
    let outputCancelled = false;
    const unhandled = [];
    const note = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', note);
    try {
      const wire = encodeProgramStream(() => new Promise((resolve) => { answer = resolve; }));
      const reader = wire.getReader();
      const reading = reader.read();
      // Its read waiting on the start.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const cancelled = reader.cancel();
      answer({ pid: 1, output: new ReadableStream({ cancel() { outputCancelled = true; } }), exit: new Promise(() => {}), kill: (signal) => kills.push(signal) });
      await cancelled;
      await reading;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', note);
    }
    assert.deepEqual([kills, outputCancelled, unhandled.map(String)], [['SIGKILL'], true, []]);
  });

  await check('a wait that fails', async () => {
    const sent = [];
    const running = encodeProgramStream(async () => ({ pid: 5, output: new ReadableStream({ pull() { return new Promise(() => {}); } }), exit: new Promise(() => {}), kill() {} }));
    const started = await decodeProgramStream(running, { signal: (pid, signal) => sent.push([pid, signal]), wait: async () => { throw new Error('wait failed'); } });
    await assert.rejects(within(started.exit, 5000), /wait failed/);
    assert.deepEqual(sent, [[5, 'SIGKILL']], 'its program is killed, not left running unseen');
    await started.output.cancel();
  });

  await check('the SDK across the remote API', async () => {
    const host = { async ensureRuntimeReady() {}, runtimeWorkspace: ws, processes: ws.processes, _ensureChildProcessManager: () => ws.children };
    const waits = [];
    const session = {
      _rpcReady: async () => ({ ok: true, preinstalled: [] }),
      _rpcStartProgram: (argv, options) => programmatic.rpcStartProgram(host, argv, options),
      _rpcWaitProgram: (pid, waitMs) => { waits.push(waitMs); return programmatic.rpcWaitProgram(host, pid, waitMs); },
      _rpcSignalProcess: (pid, signal) => programmatic.rpcSignalProcess(host, pid, signal),
      _rpcWriteProcessInput: (pid, data) => programmatic.rpcWriteProcessInput(host, pid, data),
      _rpcWriteProcessInputStream: (pid, data) => programmatic.rpcWriteProcessInputStream(host, pid, data),
      _rpcEndProcessInput: (pid) => programmatic.rpcEndProcessInput(host, pid),
    };
    const env = { NIMBUS_SESSION: { idFromName: (name) => ({ name }), get: () => session } };
    const box = Nimbus.connect({
      endpoint: 'https://nimbus.test',
      fetch: async (url, init) => (await handleNimbusRemoteApi(new Request(url, init), env, { remote: { enabled: true, allowLegacy: true } }))
        ?? new Response('not found', { status: 404 }),
    }).sandbox('remote-start');
    // Bytes in through writeProcessInput, every value, then its end.
    const input = new Uint8Array(256).map((_, i) => i);
    const cat = await box.startProgram(['cat'], { stdin: new ReadableStream({ start(c) { c.enqueue(input); c.close(); } }) });
    const echoed = [];
    for await (const chunk of cat.output) echoed.push(...chunk.data);
    assert.deepEqual(echoed, [...input], 'its input, byte for byte');
    assert.deepEqual(await within(cat.exit, 5000), { code: 0, signal: null });
    // Its exit is a long wait, not a stream of quick ones.
    waits.length = 0;
    const sleeper = await box.startProgram(['sleep', '600']);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const polls = waits.length;
    sleeper.kill('SIGKILL');
    assert.deepEqual(await within(sleeper.exit, 5000), { code: null, signal: 'SIGKILL' });
    await sleeper.output.cancel();
    assert.ok(polls <= 2 && waits.every((ms) => ms === undefined), `one long wait at a time, its bound the session's: ${polls} waits, ${JSON.stringify(waits.slice(0, 5))}`);
  });

  await check('a write that fails', async () => {
    const calls = [];
    let cancelledWith = null;
    const source = () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); }, cancel(reason) { cancelledWith = reason; } });
    const refusing = { write: async () => { throw new Error('write failed'); }, end: async () => { calls.push('end'); } };
    await programStart.feedProgramInput(source(), refusing, new Promise(() => {}));
    assert.deepEqual([calls, cancelledWith?.message], [['end'], 'write failed'], 'its source hears why; the input is ended');
    const dead = { write: async () => { throw new Error('write failed'); }, end: async () => { throw new Error('end failed'); } };
    await assert.rejects(programStart.feedProgramInput(source(), dead, new Promise(() => {})), /end failed/, 'and when that fails too, its caller hears it');
  });

  assert.deepEqual(failures, []);
} finally {
  await ws.close();
}
console.log('program-stream: a started program crosses a byte stream of frames whole');
