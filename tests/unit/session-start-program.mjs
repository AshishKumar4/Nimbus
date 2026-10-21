#!/usr/bin/env bun
// A session starts a program by its argv (Kinu ask 67, the facade's exec):
// workspace.startProgram(program, cancel) is the start contract a mount's
// exec delegate meets (ask 66), so a session is one too. It resolves once
// the program runs, and only then; a start that cannot run rejects with
// the errno Node's spawn gives (`code`, `syscall: 'spawn <file>'`, `path`);
// its exit is waitpid's code or signal; kill(signal) is the program's
// signal; its stdin is bytes, to their end, with backpressure. Programs are
// placed by their cwd as every start is: under a delegating mount it is the
// mount's machine that starts them. Before, a session ran only command
// lines (exec), whose answer is a shell's status. A cancel is heard however
// early it comes; stdout and stderr are merged fairly; an input source is let
// go when the program ends; what it ran leaves the process table once read;
// and only such a program's signals are the broker's (a node child's still
// reach its handlers through its input).
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { rpcSignalProcess } from '../../packages/worker/src/session/programmatic.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions });

/** A started program's output, read to its end, and its exit. */
async function finish(started) {
  const out = [];
  const err = [];
  for await (const chunk of started.output) (chunk.stream === 'stdout' ? out : err).push(...chunk.data);
  return { stdout: new Uint8Array(out), stderr: new TextDecoder().decode(new Uint8Array(err)), exit: await started.exit };
}
const text = (bytes) => new TextDecoder().decode(bytes);
const never = new AbortController().signal;
const program = (argv, extra = {}) => ({ argv, env: { PATH: '/usr/bin:/bin', HOME: '/home/user' }, cwd: '/home/user', stdin: null, ...extra });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** `promise`, or a rejection once `ms` have passed. */
function within(promise, ms) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`not settled within ${ms} ms`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
/** Waits, up to two seconds, for `holds()`. */
async function until(holds, message) {
  for (let i = 0; i < 200 && !holds(); i++) await sleep(10);
  assert.ok(holds(), message);
}

try {
  let started = await ws.startProgram(program(['echo', 'hi']), never);
  assert.equal(typeof started.pid, 'number', 'started: its pid');
  let ran = await finish(started);
  assert.deepEqual([text(ran.stdout), ran.exit], ['hi\n', { code: 0, signal: null }]);

  ran = await finish(await ws.startProgram(program(['sh', '-c', 'echo err >&2; exit 3']), never));
  assert.deepEqual([ran.stderr, ran.exit], ['err\n', { code: 3, signal: null }]);

  await assert.rejects(ws.startProgram(program(['no-such-program']), never), (error) => {
    assert.deepEqual([error.code, error.errno, error.syscall, error.path], ['ENOENT', -2, 'spawn no-such-program', 'no-such-program']);
    return true;
  }, 'a start that cannot run: Node\'s spawn error');

  // Bytes in, to their end, every value, and more than a pipe holds, to a reader slower than the writer.
  const bytes = new Uint8Array(1024 * 1024 + 256);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
  const stdin = new ReadableStream({
    start(controller) {
      for (let at = 0; at < bytes.length; at += 64 * 1024) controller.enqueue(bytes.subarray(at, at + 64 * 1024));
      controller.close();
    },
  });
  started = await ws.startProgram(program(['cat'], { stdin }), never);
  const echoed = [];
  for await (const chunk of started.output) {
    echoed.push(chunk.data);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const joined = new Uint8Array(echoed.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of echoed) { joined.set(c, at); at += c.length; }
  assert.equal(joined.length, bytes.length, 'every byte back');
  assert.ok(joined.every((b, i) => b === bytes[i]), 'in order, byte for byte');
  assert.deepEqual(await started.exit, { code: 0, signal: null });

  // Its input left open, written afterwards (as a caller across HTTP writes it), then ended.
  started = await ws.startProgram(program(['cat'], { stdin: 'written' }), never);
  await ws.children.stdinWrite(started.pid, new Uint8Array([0, 0xff, 0x41]));
  await ws.children.stdinEnd(started.pid);
  ran = await finish(started);
  assert.deepEqual([[...ran.stdout], ran.exit], [[0, 0xff, 0x41], { code: 0, signal: null }]);

  // kill(signal) is the program's: ended by it, waitpid says which.
  started = await ws.startProgram(program(['sleep', '600']), never);
  started.kill('SIGTERM');
  ran = await finish(started);
  assert.deepEqual(ran.exit, { code: null, signal: 'SIGTERM' });

  // Placed by its cwd, as every start is: under a delegating mount, the mount's machine starts it.
  const starts = [];
  const delegate = {
    async start(spec, cancel) {
      starts.push([...spec.argv]);
      if (spec.argv[0] === 'hold') {
        await new Promise((resolve) => cancel.addEventListener('abort', resolve, { once: true }));
        throw Object.assign(new Error('operation canceled'), { code: 'ECANCELED' });
      }
      return {
        output: new ReadableStream({ start(c) { c.enqueue({ stream: 'stdout', data: new TextEncoder().encode('remote\n') }); c.close(); } }),
        exit: Promise.resolve({ code: 0, signal: null }),
        kill() {},
      };
    },
    async locate() { return null; },
  };
  const files = new MemoryVFS({ uid: 1000, gid: 1000 });
  files.mkdir('/x', { recursive: true });
  ws.filesystem.vfs.mount('/m', files, { exec: delegate });
  ran = await finish(await ws.startProgram(program(['uname', '-a'], { cwd: '/m/x' }), never));
  assert.deepEqual([starts, text(ran.stdout), ran.exit], [[['uname', '-a']], 'remote\n', { code: 0, signal: null }]);

  // Cancelled while its start is pending: ECANCELED, nothing run.
  const cancel = new AbortController();
  const pending = ws.startProgram(program(['hold'], { cwd: '/m' }), cancel.signal);
  for (let i = 0; i < 100 && starts.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  cancel.abort();
  await assert.rejects(pending, { code: 'ECANCELED' });

  // Each of what follows is checked on its own, so a run shows every one's verdict.
  const failures = [];
  const check = async (name, body) => {
    try {
      await body();
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    }
  };

  await check('a cancel while the broker places it', async () => {
    const early = new AbortController();
    const placing = ws.startProgram(program(['hold'], { cwd: '/m' }), early.signal);
    early.abort();
    await assert.rejects(within(placing, 5000), { code: 'ECANCELED' });
  });

  await check('stderr beside a stdout always ready', async () => {
    // The broker's reads answered at once: stdout always has more; stderr has one line, then nothing.
    const readOutput = ws.children.readOutput;
    let stderrRead = false;
    ws.children.readOutput = async (_pid, fd, since) => {
      if (fd === 1) return { chunks: [{ data: new TextEncoder().encode('out\n') }], closed: false, maxSeq: since + 1 };
      if (stderrRead) return new Promise(() => {});
      stderrRead = true;
      return { chunks: [{ data: new TextEncoder().encode('err\n') }], closed: false, maxSeq: 1 };
    };
    const sleeper = await ws.startProgram(program(['sleep', '600']), never);
    const order = [];
    try {
      for await (const chunk of sleeper.output) {
        order.push(chunk.stream);
        if (chunk.stream === 'stderr' || order.length >= 50) break;
        await sleep(1);
      }
    } finally {
      ws.children.readOutput = readOutput;
      sleeper.kill('SIGKILL');
      await sleeper.exit;
    }
    assert.ok(order.includes('stderr'), `stderr surfaces while stdout runs on: ${order.join(',')}`);
  });

  await check('an input source open at exit', async () => {
    let released = false;
    const idle = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { released = true; } });
    const ended = await finish(await ws.startProgram(program(['true'], { stdin: idle }), never));
    assert.deepEqual(ended.exit, { code: 0, signal: null });
    await until(() => released, 'its input source is cancelled once it has ended');
  });

  await check('a cancelled output', async () => {
    const silent = await ws.startProgram(program(['sleep', '600']), never);
    const readOutput = ws.children.readOutput;
    let reads = 0;
    ws.children.readOutput = (...args) => { reads++; return readOutput.apply(ws.children, args); };
    try {
      const output = silent.output.getReader();
      const first = output.read();
      await sleep(20);
      await output.cancel();
      await first;
      const after = reads;
      await sleep(100);
      assert.ok(reads <= after, `no poll after its cancel (${reads - after} more)`);
    } finally {
      ws.children.readOutput = readOutput;
      silent.kill('SIGKILL');
      await silent.exit;
    }
  });

  await check('its rows once read', async () => {
    const pids = [];
    for (let i = 0; i < 5; i++) {
      const done = await ws.startProgram(program(['true']), never);
      const { pid } = done;
      pids.push(pid, ws.processes.getAll().find((entry) => entry.pid === pid)?.parentPid);
      await finish(done);
    }
    assert.ok(pids.every((pid) => typeof pid === 'number'), 'each ran under a parent of its own');
    const left = ws.processes.getAll().filter((entry) => pids.includes(entry.pid));
    assert.deepEqual(left.map((entry) => entry.command), [], 'no row of what it ran is left');
  });

  // Across the session a program started by its argv takes the broker's signals; another child of the broker
  // (a node child) is signalled through its input channel, where its handlers hear it.
  const host = { async ensureRuntimeReady() {}, runtimeWorkspace: ws, processes: ws.processes };
  await check('a started program\'s signal', async () => {
    const sleeper = await ws.startProgram(program(['sleep', '600']), never);
    assert.equal(ws.isStartedProgram(sleeper.pid), true);
    assert.deepEqual(await rpcSignalProcess(host, sleeper.pid, 'SIGTERM'), { ok: true, pid: sleeper.pid });
    assert.deepEqual(await within(sleeper.exit, 5000), { code: null, signal: 'SIGTERM' });
    await until(() => !ws.isStartedProgram(sleeper.pid), 'it is forgotten once it has ended');
  });

  await check('a node child\'s signal', async () => {
    const parent = ws.processes.spawn('node', ['node'], '/home/user', {});
    const { childPid } = await ws.children.spawn({ command: 'sleep', args: ['600'], env: {}, cwd: '/home/user', stdio: ['pipe', 'pipe', 'pipe'], parentPid: parent.pid });
    try {
      await rpcSignalProcess(host, childPid, 'SIGUSR1');
      await sleep(50);
      assert.equal(ws.children.isRunning(childPid), true, 'a signal its handler may take does not end it from outside');
    } finally {
      ws.children.kill(childPid, 'SIGKILL');
    }
  });

  assert.deepEqual(failures, []);
} finally {
  await ws.close();
}
console.log('session-start-program: a session starts a program by its argv, as a mount\'s delegate does');
