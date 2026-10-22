#!/usr/bin/env bun
/**
 * wasi-processes — a WASI guest's children and pipes (core runtime/wasi/
 * processes.ts), through the real WASI body, over a session that answers the
 * child-process calls (cpSpawn and the rest) as session/rpc.ts does.
 *
 *   - a wait on a child or a pipe that gives up (EINTR at PROCESS_PARK_MS)
 *     consumes nothing: the retry reaps the child and reads the bytes, and a
 *     poll of a pipe gives up the same way;
 *   - pipes: bytes in order, EOF once every writer is gone, EPIPE once every
 *     reader is, O_NONBLOCK's EAGAIN, poll readiness and hangup;
 *   - a child: its argv, env, cwd and parent; its stdin from a pipe (ended
 *     when the last writer closes); its output into a pipe or the guest's own
 *     stdout; its exit status and signal; waitpid only after its output;
 *   - a spawn the session refuses fails as execvp does (ENOENT), whether
 *     cpSpawn throws it or the child's start reports it (spawnError), and
 *     what the session cannot deliver is EIO, not a short read;
 *   - the ledger's news: the guest says it is blocked while it only waits on
 *     its children, and running once answered, at the frontier of the news
 *     it applied (worker runtime/child-news.ts);
 *   - a process's own output relayed live (__wasiSupervisorOutput): in
 *     order, byte for byte, a writer held past 1 MiB in flight, and output
 *     the session refused reported;
 *   - a dup of stdout writes to stdout;
 *   - a guest that takes its signals (git-runner@2): a signal sent to its
 *     process (cpNextSignal) ends a wait on a pipe, a child or a poll at
 *     once, answered NIMBUS_ESIGNAL + its number and taken by that answer,
 *     consuming nothing; one that came while it ran ends its next wait at
 *     once; a child's start it does not end; a stdin read the session
 *     interrupted answers it too, and so does a poll on a clock alone and
 *     a write to a child whose stdin is full (withdrawn, writing nothing);
 *     a pump holding a child's output asks for none. A guest that does not
 *     take them is never asked for them, and a stdin signal is EINTR to it.
 */

import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WASI_INSTANCE_PREAMBLE_SRC } from '../../packages/core/src/runtime/wasi-instance.ts';
import { makeParkingImports } from './lib/wasi-imports.mjs';
import { acrossRpc } from './lib/rpc-error.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const E = { SUCCESS: 0, ACCES: 2, AGAIN: 6, BADF: 8, CHILD: 12, INTR: 27, IO: 29, NOENT: 44, PIPE: 64 };
/** NIMBUS_ESIGNAL + SIGINT's number, and SIGTERM's. */
const ESIGINT = 1026;
const ESIGTERM = 1039;
const NONBLOCK = 4;
const GUEST_PID = 7;

/**
 * The session's side, as facets/process.ts answers it: children whose start,
 * output, exit and stdin the test drives, each event numbered as news.
 */
function session() {
  const children = new Map();
  let nextPid = 100;
  let newsCount = 0;
  const news = () => ++newsCount;
  let waiters = [];
  const notify = () => { const now = waiters; waiters = []; for (const w of now) w(); };
  const until = (ready, ms) => new Promise((resolve) => {
    const check = () => { if (ready()) { clearTimeout(timer); resolve(); } else waiters.push(check); };
    const timer = setTimeout(resolve, ms);
    check();
  });
  const sup = {
    spawned: [],
    outputReads: [],
    refuse: null,
    async cpSpawn(req) {
      if (sup.refuse) throw acrossRpc(Object.assign(new Error(`${sup.refuse}: ${req.command}`), { code: sup.refuse }));
      const pid = nextPid++;
      children.set(pid, {
        stdin: [], stdinEnded: false, out: { 1: [], 2: [] }, closed: { 1: false, 2: false }, exit: null, seq: 0,
        started: false, startNews: 0, exitNews: 0, closedNews: { 1: 0, 2: 0 }, spawnError: null,
      });
      sup.spawned.push({ pid, ...req });
      if (!sup.holdStart) control.start(pid);
      return { childPid: pid };
    },
    /** While set, the child's stdin has no room: a write waits, and a signal sent to the guest withdraws it and answers it, as the session does for a writer that takes its signals. */
    stdinFull: false,
    async cpStdinWrite(pid, data) {
      const child = children.get(pid);
      if (child.lost) throw acrossRpc(new Error('session reset'));
      if (child.exit || child.stdinEnded) return { ok: false };
      await until(() => !sup.stdinFull || sup.signals.length > 0, 60_000);
      if (sup.stdinFull) return { ok: false, signal: sup.signals.shift() };
      child.stdin.push(dec.decode(data));
      return { ok: true };
    },
    async cpStdinEnd(pid) { children.get(pid).stdinEnded = true; },
    async cpReadOutput(pid, fd, since, waitMs) {
      sup.outputReads.push({ pid, fd, since });
      const child = children.get(pid);
      await until(() => child.lost || child.closed[fd] || child.out[fd].some((c) => c.seq > since), waitMs);
      if (child.lost) throw acrossRpc(new Error('session reset'));
      const fresh = child.out[fd].filter((c) => c.seq > since);
      const numbers = fresh.map((c) => c.news);
      if (fresh.length > 0) numbers.push(child.startNews);
      if (child.closed[fd]) numbers.push(child.closedNews[fd]);
      return { chunks: fresh.map(({ seq, data }) => ({ seq, data })), closed: child.closed[fd], maxSeq: child.seq, news: numbers.filter((n) => n > 0) };
    },
    async cpWait(pid, waitMs, acquire, knownStarted = true) {
      const child = children.get(pid);
      await until(() => child.lost || child.exit !== null || (!knownStarted && child.started), waitMs);
      if (child.lost) throw acrossRpc(new Error('session reset'));
      const numbers = [child.startNews, child.exitNews].filter((n) => n > 0);
      if (child.exit) return child.spawnError
        ? { done: true, exitCode: child.exit.exitCode, signal: null, spawnError: child.spawnError, news: numbers }
        : { done: true, ...child.exit, news: numbers };
      if (!knownStarted && child.started) return { done: false, exitCode: null, signal: null, started: true, news: numbers };
      return { done: false, exitCode: null, signal: null };
    },
    blocked: [],
    async cpBlocked(report) { sup.blocked.push(report); },
    /** Signals sent to the guest's process, and how often it asked for one. */
    signals: [],
    signalWaits: 0,
    async cpNextSignal(waitMs) {
      sup.signalWaits++;
      await until(() => sup.signals.length > 0, waitMs);
      return sup.signals.shift() ?? null;
    },
    async cpKill(pid, signal) {
      const child = children.get(pid);
      if (!child || child.exit) return false;
      control.end(pid, { exitCode: null, signal });
      return true;
    },
  };
  const control = {
    child: (pid) => children.get(pid),
    issued: () => newsCount,
    start(pid) {
      const child = children.get(pid);
      child.started = true;
      child.startNews = news();
      notify();
    },
    /** Its spawn failed with `code` (as the session's preflight or ledger refuses one): it never ran. */
    refuse(pid, code, errno) {
      const child = children.get(pid);
      child.spawnError = code;
      child.exit = { exitCode: errno, signal: null };
      child.exitNews = news();
      child.closed[1] = child.closed[2] = true;
      notify();
    },
    print(pid, fd, text) {
      const child = children.get(pid);
      child.out[fd].push({ seq: ++child.seq, data: enc.encode(text), news: news() });
      notify();
    },
    end(pid, exit) {
      const child = children.get(pid);
      child.exitNews = news();
      child.closedNews[1] = news();
      child.closedNews[2] = news();
      child.closed[1] = child.closed[2] = true;
      child.exit = exit;
      notify();
    },
    exit(pid, exitCode) { control.end(pid, { exitCode, signal: null }); },
    /** A signal sent to the guest's own process (SessionProcessSupervisor.takeSignals). */
    signal(name) { sup.signals.push(name); notify(); },
    lose(pid) { children.get(pid).lost = true; notify(); },
  };
  return { sup, control };
}

/** A guest; `stdin` answers its process's input channel, as the session's cpReadStdin does; `takesSignals`, git-runner@2's contract. */
async function guest({ stdin, takesSignals = false } = {}) {
  const modulePath = path.join(os.tmpdir(), `wasi-processes-${process.pid}-${Math.random().toString(16).slice(2)}.mjs`);
  writeFileSync(modulePath, `${WASI_INSTANCE_PREAMBLE_SRC}\nexport { __wasiInitFS, __wasiMakeImports, __wasiAdoptSupervisor, __wasiSupervisorOutput, fdTable };`);
  let P;
  try { P = await import(pathToFileURL(modulePath).href); } finally { rmSync(modulePath, { force: true }); }
  const { sup, control } = session();
  // The layer reads fd 0 through the supervisor it adopted, for the pid it was given.
  if (stdin) sup.cpReadStdin = (pid, _waitMs, _acquire, maxBytes) => { assert.equal(pid, GUEST_PID, 'the guest reads its own channel'); return stdin(maxBytes); };
  const memory = new WebAssembly.Memory({ initial: 4 });
  const stdout = [];
  P.__wasiInitFS({ root: '', preopens: [{ wasiPath: '/', vfsPath: '' }], pid: GUEST_PID });
  P.__wasiAdoptSupervisor(sup);
  const bundle = makeParkingImports(P, {
    argv: ['guest'], env: {}, getMemory: () => memory,
    stdoutBytes: (bytes) => stdout.push(dec.decode(bytes)), stderrBytes: () => {},
    takesSignals,
  });
  const wasi = bundle.wasiImport;
  const proc = bundle.procImport;
  const view = () => new DataView(memory.buffer);
  const bytesAt = () => new Uint8Array(memory.buffer);
  // Each call gets its own scratch region, so calls in flight together do not share memory.
  let region = 0;
  const scratch = () => 16384 + ((region++ % 32) * 4096);
  const strings = (at, list) => {
    const b = enc.encode(list.map((s) => `${s}\0`).join(''));
    bytesAt().set(b, at);
    return b.length;
  };
  return {
    P, sup, control, stdout,
    /** CPython's periodic check for its signals (nimbus_proc.signal_check). */
    check: () => proc.signal_check(),
    buffered: (fd) => P.fdTable.get(fd)?.pipe?.buffered,
    pipe() {
      const at = scratch();
      assert.equal(proc.pipe(at), E.SUCCESS);
      return [view().getInt32(at, true), view().getInt32(at + 4, true)];
    },
    async write(fd, text) {
      const at = scratch();
      const b = enc.encode(text);
      bytesAt().set(b, at + 64);
      view().setUint32(at, at + 64, true);
      view().setUint32(at + 4, b.length, true);
      return wasi.fd_write(fd, at, 1, at + 8);
    },
    /** fd_read of up to 1 KiB: { errno, text }. */
    async read(fd, maxBytes = 1024, raw = false) {
      const at = scratch();
      view().setUint32(at, at + 64, true);
      view().setUint32(at + 4, maxBytes, true);
      const errno = await wasi.fd_read(fd, at, 1, at + 8);
      const bytes = errno === E.SUCCESS ? bytesAt().slice(at + 64, at + 64 + view().getUint32(at + 8, true)) : null;
      return raw ? { errno, bytes: bytes === null ? null : [...bytes] } : { errno, text: bytes === null ? null : dec.decode(bytes) };
    },
    close: (fd) => wasi.fd_close(fd),
    dup(fd) {
      const at = scratch();
      assert.equal(proc.dup(fd, at), E.SUCCESS);
      return view().getInt32(at, true);
    },
    async setFlags(fd, flags) { return wasi.fd_fdstat_set_flags(fd, flags); },
    async fdflags(fd) {
      const at = scratch();
      assert.equal(await wasi.fd_fdstat_get(fd, at), E.SUCCESS);
      return view().getUint16(at + 2, true);
    },
    /** posix_spawn as git's nimbus_spawnvpe makes it, the spawn and then its start: { errno, pid }. */
    async spawn(argv, { env = [], dir = '/home/user', fdin = -1, fdout = -1, fderr = -1 } = {}) {
      const at = scratch();
      const argvLen = strings(at, argv);
      const envLen = strings(at + 1024, env);
      const dirLen = enc.encodeInto(dir, bytesAt().subarray(at + 2048)).written;
      let errno = await proc.spawn(at, argvLen, at + 1024, envLen, at + 2048, dirLen, fdin, fdout, fderr, at + 4000);
      if (errno !== E.SUCCESS) return { errno, pid: null };
      const pid = view().getInt32(at + 4000, true);
      do errno = await proc.start(pid); while (errno === E.INTR);
      return { errno, pid: errno === E.SUCCESS ? pid : null };
    },
    start: (pid) => proc.start(pid),
    /** The spawn alone, as nimbus_spawnvpe's first call: { errno, pid }. */
    async spawnOnly(argv) {
      const at = scratch();
      const argvLen = strings(at, argv);
      const errno = await proc.spawn(at, argvLen, at + 1024, 0, at + 2048, 0, -1, -1, -1, at + 4000);
      return { errno, pid: errno === E.SUCCESS ? view().getInt32(at + 4000, true) : null };
    },
    /** waitpid: { errno, status, waited }. */
    async wait(pid, options = 0) {
      const at = scratch();
      view().setInt32(at, -1, true);
      view().setInt32(at + 4, -1, true);
      const errno = await proc.wait(pid, options, at, at + 4);
      return { errno, status: view().getInt32(at, true), waited: view().getInt32(at + 4, true) };
    },
    kill: (pid, signal) => proc.kill(pid, signal),
    /** The extension's fstat of `fd`: its st_mode. */
    async fdStatMode(fd) {
      const at = scratch();
      assert.equal(await bundle.fsImport.fd_stat(fd, at), E.SUCCESS);
      return view().getUint32(at + 64, true);
    },
    /** A stat of `name` beneath the root preopen (fd 3), through the extension and through preview1: { errno, mode, filetype }. */
    async pathStat(name) {
      const at = scratch();
      const b = enc.encode(name);
      bytesAt().set(b, at + 2048);
      const errno = await bundle.fsImport.path_stat(3, 1, at + 2048, b.length, at);
      const filestat = await wasi.path_filestat_get(3, 1, at + 2048, b.length, at + 1024);
      return { errno, mode: errno === E.SUCCESS ? view().getUint32(at + 64, true) : null, filestat, filetype: filestat === E.SUCCESS ? view().getUint8(at + 1024 + 16) : null };
    },
    /** preview1's fstat of `fd`: its filetype. */
    async fdFiletype(fd) {
      const at = scratch();
      assert.equal(await wasi.fd_filestat_get(fd, at), E.SUCCESS);
      return view().getUint8(at + 16);
    },
    /** The guest exited: its host stops following its children. */
    dispose: () => bundle.procDispose(),
    /** poll_oneoff on one relative monotonic clock of `ms`: its errno. */
    async sleep(ms) {
      const at = scratch();
      const v = view();
      v.setBigUint64(at, 7n, true);
      v.setUint8(at + 8, 0);
      v.setUint32(at + 16, 1, true);
      v.setBigUint64(at + 24, BigInt(ms) * 1_000_000n, true);
      v.setBigUint64(at + 32, 0n, true);
      v.setUint16(at + 40, 0, true);
      return wasi.poll_oneoff(at, at + 64, 1, at + 128);
    },
    /** poll_oneoff on one descriptor: { errno, events: [{ error, nbytes, hangup }] }. */
    async poll(fd, want = 'read') {
      const at = scratch();
      const v = view();
      v.setBigUint64(at, 9n, true);
      v.setUint8(at + 8, want === 'read' ? 1 : 2);
      v.setUint32(at + 16, fd, true);
      const errno = await wasi.poll_oneoff(at, at + 64, 1, at + 128);
      const n = view().getUint32(at + 128, true);
      const events = [];
      for (let i = 0; i < (errno === E.SUCCESS ? n : 0); i++) {
        const e = at + 64 + i * 32;
        events.push({ error: view().getUint16(e + 8, true), nbytes: Number(view().getBigUint64(e + 16, true)), hangup: (view().getUint16(e + 24, true) & 1) === 1 });
      }
      return { errno, events };
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
let checks = 0;

// A broker-bounded fd-0 read leaves the tail in the channel, not the guest.
{
  let queued = Uint8Array.of(0, 255, 195, 169, 65);
  const requested = [];
  let closed = false;
  const g = await guest({ stdin: async (maxBytes) => {
    requested.push(maxBytes);
    const data = queued.slice(0, maxBytes);
    queued = queued.slice(maxBytes);
    return { data, ended: closed && queued.length === 0 };
  } });
  assert.deepEqual(await g.read(0, 3, true), { errno: E.SUCCESS, bytes: [0, 255, 195] });
  assert.deepEqual([...queued], [169, 65], 'no hidden guest read-ahead to lose on inheritance');
  assert.deepEqual(await g.read(g.dup(0), 2, true), { errno: E.SUCCESS, bytes: [169, 65] });
  assert.equal((await g.read(0, 4)).errno, E.INTR, 'empty long-poll is not EOF');
  closed = true;
  assert.deepEqual(await g.read(0, 4), { errno: E.SUCCESS, text: '' });
  assert.deepEqual(await g.read(0, 0), { errno: E.SUCCESS, text: '' });
  assert.deepEqual(requested, [3, 2, 4, 4], 'zero-length reads take nothing');
  const child = await g.spawn(['reader'], { fdin: 0 });
  assert.equal(child.errno, E.SUCCESS);
  assert.equal(g.sup.spawned.at(-1).stdio[0], 'inherit', 'the broker attaches the same channel');
  assert.equal(g.control.child(child.pid).stdinEnded, false, 'inherited fd0 does not synthesize EOF');
  g.control.exit(child.pid, 0);
  await g.wait(child.pid);
  g.dispose();
  checks++;
}

// ── a wait that gives up consumes nothing ───────────────────────────────
{
  const g = await guest();
  const [r, w] = g.pipe();
  const { errno, pid } = await g.spawn(['slow'], { fdout: w });
  assert.equal(errno, E.SUCCESS);
  assert.equal(await g.close(w), E.SUCCESS);
  const [idleR, idleW] = g.pipe();
  g.sup.holdStart = true;
  const queued = await g.spawnOnly(['queued']);
  assert.equal(queued.errno, E.SUCCESS);
  const started = Date.now();
  const [waited, read, polled, start] = await Promise.all([g.wait(pid), g.read(r), g.poll(idleR), g.start(queued.pid)]);
  const took = Date.now() - started;
  assert.equal(waited.errno, E.INTR, 'a wait on a child that runs on gives up');
  assert.equal(read.errno, E.INTR, 'so does a read of its output');
  assert.equal(polled.errno, E.INTR, 'and a poll of an idle pipe, before the watchdog');
  assert.equal(start, E.INTR, 'and a start the session has not let in yet');
  g.control.start(queued.pid);
  await settle();
  assert.equal(await g.start(queued.pid), E.SUCCESS, 'the retried start finds it started');
  assert.ok(took < 9_500, `gave up before the watchdog's 10 s (${took} ms)`);
  g.control.print(pid, 1, 'late');
  g.control.exit(pid, 3);
  await settle();
  const again = await g.wait(pid);
  assert.equal(again.errno, E.SUCCESS, 'the retried wait reaps the child: the one that gave up did not');
  assert.equal(again.status, 3 << 8);
  assert.equal(again.waited, pid);
  assert.deepEqual(await g.read(r), { errno: E.SUCCESS, text: 'late' }, 'the retried read gets the bytes');
  assert.deepEqual(await g.read(r), { errno: E.SUCCESS, text: '' });
  assert.equal((await g.wait(pid)).errno, E.CHILD, 'reaped once');
  await g.close(idleW);
  g.dispose();
  checks++;
}

// ── pipes ───────────────────────────────────────────────────────────────
{
  const g = await guest();
  const [r, w] = g.pipe();
  assert.equal(await g.write(w, 'one '), E.SUCCESS);
  assert.equal(await g.write(w, 'two'), E.SUCCESS);
  assert.deepEqual(await g.read(r), { errno: E.SUCCESS, text: 'one two' });

  const ready = g.poll(r);
  await settle();
  await g.write(w, 'xyz');
  assert.deepEqual(await ready, { errno: E.SUCCESS, events: [{ error: 0, nbytes: 3, hangup: false }] }, 'a poll wakes when bytes arrive');
  assert.deepEqual((await g.poll(w, 'write')).events, [{ error: 0, nbytes: 65533, hangup: false }]);
  assert.equal((await g.read(r)).text, 'xyz');

  assert.equal(await g.setFlags(r, NONBLOCK), E.SUCCESS);
  assert.equal(await g.fdflags(r), NONBLOCK, 'O_NONBLOCK reads back');
  assert.equal((await g.read(r)).errno, E.AGAIN, 'an empty non-blocking pipe is EAGAIN');
  await g.setFlags(r, 0);

  const w2 = g.dup(w);
  await g.close(w);
  await g.write(w2, 'still');
  assert.equal((await g.read(r)).text, 'still', 'a dup keeps the write end open');
  await g.close(w2);
  assert.deepEqual(await g.read(r), { errno: E.SUCCESS, text: '' }, 'EOF once every writer is gone');
  assert.deepEqual((await g.poll(r)).events, [{ error: 0, nbytes: 0, hangup: true }], 'and a poll sees the hangup');

  assert.equal(await g.fdStatMode(r), 0o010600, 'fstat of a pipe: a FIFO');
  // A path naming the pipe's descriptor is its stat, through either table.
  assert.deepEqual(await g.pathStat(`dev/fd/${r}`), { errno: E.SUCCESS, mode: 0o010600, filestat: E.SUCCESS, filetype: await g.fdFiletype(r) }, '/dev/fd/N of a pipe: its fstat');
  assert.deepEqual(await g.pathStat('dev/fd/99'), { errno: E.NOENT, mode: null, filestat: E.NOENT, filetype: null }, '/dev/fd/N of no descriptor: ENOENT');
  const [r3, w3] = g.pipe();
  await g.close(r3);
  assert.equal(await g.write(w3, 'x'), E.PIPE, 'EPIPE once every reader is gone');
  assert.equal(await g.write(r, 'x'), E.BADF, 'a read end is not written');
  g.dispose();
  checks++;
}

// ── a child: what it is started with, its streams, how it ends ──────────
{
  const g = await guest();
  const [r, w] = g.pipe();
  assert.equal(await g.write(w, 'x'.repeat(65536)), E.SUCCESS);
  let done = false;
  const waiting = g.write(w, 'y').then((errno) => { done = true; return errno; });
  await settle();
  assert.equal(done, false, 'a standalone guest pipe blocks at the shared named capacity');
  assert.equal((await g.read(r, 4)).text, 'xxxx');
  assert.equal(await waiting, E.SUCCESS, 'reading makes room for the blocked writer');
  await g.close(r); await g.close(w);
  g.dispose();
  checks++;
}

// A broker reader cannot acknowledge its way into an unbounded guest pipe.
{
  const g = await guest();
  const [r, w] = g.pipe();
  const child = await g.spawn(['producer'], { fdout: w });
  await g.close(w);
  g.control.print(child.pid, 1, 'q'.repeat(3 * 65536));
  await settle();
  assert.equal(g.buffered(r), 65536);
  assert.equal(g.sup.outputReads.some((call) => call.pid === child.pid && call.fd === 1 && call.since > 0), false, 'no broker cursor advance before the chunk fits');
  let received = 0;
  while (received < 3 * 65536) {
    received += (await g.read(r)).text.length;
    assert.ok(g.buffered(r) <= 65536);
  }
  g.control.exit(child.pid, 0);
  assert.equal((await g.wait(child.pid)).status, 0);
  g.dispose();
  checks++;
}

{
  const g = await guest();
  const [inR, inW] = g.pipe();
  const [outR, outW] = g.pipe();
  const { errno, pid } = await g.spawn(['sh', '-c', 'cat'], { env: ['A=1', 'B=two=2'], dir: '/home/user/repo', fdin: inR, fdout: outW, fderr: 1 });
  assert.equal(errno, E.SUCCESS);
  await g.close(inR);
  await g.close(outW);
  assert.deepEqual(g.sup.spawned[0], {
    pid, command: 'sh', args: ['-c', 'cat'], env: { A: '1', B: 'two=2' }, cwd: '/home/user/repo',
    stdio: ['pipe', 'pipe', 'pipe'], parentPid: GUEST_PID,
  });
  assert.equal(await g.write(inW, 'to the child'), E.SUCCESS);
  assert.deepEqual(g.control.child(pid).stdin, ['to the child'], 'what the guest writes reaches its stdin');
  assert.equal(g.control.child(pid).stdinEnded, false);
  await g.close(inW);
  assert.equal(g.control.child(pid).stdinEnded, true, 'its stdin ends with the last writer');

  g.control.print(pid, 1, 'from the child');
  g.control.print(pid, 2, 'to the guest stdout');
  assert.deepEqual(await g.read(outR), { errno: E.SUCCESS, text: 'from the child' });
  g.control.print(pid, 1, ' and its last words');
  g.control.exit(pid, 0);
  assert.deepEqual(await g.wait(pid), { errno: E.SUCCESS, status: 0, waited: pid });
  assert.deepEqual(await g.read(outR), { errno: E.SUCCESS, text: ' and its last words' }, 'its output arrived before waitpid answered');
  assert.equal((await g.read(outR)).text, '');
  assert.deepEqual(g.stdout, ['to the guest stdout'], 'output named for the guest stdout joins it');

  // A child that ended: its stdin's reader is gone.
  const [in2R, in2W] = g.pipe();
  const second = await g.spawn(['true'], { fdin: in2R });
  await g.close(in2R);
  g.control.exit(second.pid, 0);
  await g.wait(second.pid);
  assert.equal(await g.write(in2W, 'late'), E.PIPE, 'writing to an ended child is EPIPE');

  // Killed: its status is the signal.
  const third = await g.spawn(['sleep', '100']);
  assert.equal(await g.kill(third.pid, 15), E.SUCCESS);
  assert.deepEqual(await g.wait(third.pid), { errno: E.SUCCESS, status: 15, waited: third.pid });
  assert.equal(await g.kill(third.pid, 15), 71 /* ESRCH */, 'not a child any more');

  // WNOHANG answers at once, and waitpid(-1) reaps whichever ended.
  const fourth = await g.spawn(['a']);
  const fifth = await g.spawn(['b']);
  assert.deepEqual(await g.wait(-1, 1), { errno: E.SUCCESS, status: -1, waited: 0 });
  g.control.exit(fifth.pid, 4);
  assert.deepEqual(await g.wait(-1), { errno: E.SUCCESS, status: 4 << 8, waited: fifth.pid });
  g.control.exit(fourth.pid, 0);
  assert.deepEqual(await g.wait(-1), { errno: E.SUCCESS, status: 0, waited: fourth.pid });
  g.dispose();
  checks++;
}

// ── what the session refuses or cannot deliver ──────────────────────────
{
  const g = await guest();
  const [outR, outW] = g.pipe();
  g.sup.refuse = 'ENOENT';
  assert.deepEqual(await g.spawn(['git-hi'], { fdout: outW }), { errno: E.NOENT, pid: null }, 'a program that is not there is ENOENT, as execvp has it');
  g.sup.refuse = 'EACCES';
  assert.equal((await g.spawn(['./x'])).errno, E.ACCES);
  g.sup.refuse = null;
  await g.close(outW);
  assert.deepEqual(await g.read(outR), { errno: E.SUCCESS, text: '' }, 'a spawn that failed holds no write end');

  const [lostR, lostW] = g.pipe();
  const [lostInR, lostInW] = g.pipe();
  const lost = await g.spawn(['far'], { fdin: lostInR, fdout: lostW });
  await g.close(lostW);
  await g.close(lostInR);
  g.control.print(lost.pid, 1, 'half');
  assert.equal((await g.read(lostR)).text, 'half');
  g.control.lose(lost.pid);
  assert.equal((await g.read(lostR)).errno, E.IO, 'output the session lost is EIO, not EOF');
  assert.equal(await g.write(lostInW, 'more'), E.PIPE, 'input it cannot take is EPIPE');
  assert.equal(await g.close(lostInW), E.SUCCESS);
  assert.equal((await g.wait(lost.pid)).errno, E.IO, 'and an end it cannot report is EIO');
  g.dispose();
  checks++;
}

// ── a spawn refused once the session looked (spawnError) ────────────────
{
  const g = await guest();
  g.sup.holdStart = true;
  const [outR, outW] = g.pipe();
  const at = await g.spawnOnly(['git-hi']);
  assert.equal(at.errno, E.SUCCESS, 'the spawn itself is taken');
  g.control.refuse(at.pid, 'ENOENT', -2);
  assert.equal(await g.start(at.pid), E.NOENT, 'its start reports the refusal, as execvp would have');
  assert.equal((await g.wait(at.pid)).errno, E.CHILD, 'and it is no child of the guest');
  g.control.refuse((await g.spawnOnly(['busy'])).pid, 'EAGAIN', -11);
  await g.close(outW);
  assert.deepEqual(await g.read(outR), { errno: E.SUCCESS, text: '' });
  g.dispose();
  checks++;
}

// ── the ledger's news ───────────────────────────────────────────────────
{
  const g = await guest();
  const [r, w] = g.pipe();
  const { pid } = await g.spawn(['child'], { fdout: w });
  await g.close(w);
  const waiting = g.wait(pid);
  await settle();
  // (Its start was a wait on the child too: blocked, then running.)
  assert.deepEqual(g.sup.blocked.map((b) => b.blocked), [true, false, true], 'waiting on its child, the guest says it is blocked');
  g.control.print(pid, 1, 'out');
  g.control.exit(pid, 0);
  assert.equal((await waiting).errno, E.SUCCESS);
  assert.equal((await g.read(r)).text, 'out');
  await settle();
  const last = g.sup.blocked.at(-1);
  assert.equal(last.blocked, false, 'answered, it runs again');
  assert.equal(last.frontier, g.control.issued(), 'having applied every piece of news the session issued');
  assert.deepEqual(g.sup.blocked.map((b) => b.seq), g.sup.blocked.map((_, i) => i + 1), 'numbered in order');
  g.dispose();
  checks++;
}

// ── a process's own output, live ────────────────────────────────────────
{
  const g = await guest();
  const got = [];
  let hold = null;
  const target = {
    async stdout(d) { if (hold) await hold.promise; got.push(`1:${dec.decode(d)}`); },
    async stderr(d) { got.push(`2:${dec.decode(d)}`); },
  };
  const out = g.P.__wasiSupervisorOutput(target);
  assert.equal(out.stdoutBytes(enc.encode('a')), undefined, 'a write within the window does not wait');
  out.stderrBytes(enc.encode('b'));
  out.stdoutBytes(enc.encode('c'));
  assert.equal(await out.drain(), null);
  assert.deepEqual(got, ['1:a', '2:b', '1:c'], 'in the order written, across both streams');

  let release;
  hold = { promise: new Promise((resolve) => { release = resolve; }) };
  assert.equal(out.stdoutBytes(new Uint8Array(600 * 1024)), undefined);
  const held = out.stdoutBytes(new Uint8Array(600 * 1024));
  assert.ok(held instanceof Promise, 'past 1 MiB in flight a writer waits');
  let settled = false;
  void held.then(() => { settled = true; });
  await settle();
  assert.equal(settled, false);
  await new Promise((resolve) => setTimeout(resolve, 5500));
  assert.equal(settled, false, 'a timeout cannot release a writer into a full output window');
  release();
  await held;
  hold = null;
  assert.equal(await out.drain(), null);

  const sizes = [];
  const split = g.P.__wasiSupervisorOutput({ async stdout(bytes) { sizes.push(bytes.length); }, async stderr() {} });
  await split.stdoutBytes(new Uint8Array(3 * 1024 * 1024 + 1));
  assert.equal(await split.drain(), null);
  assert.ok(sizes.every((size) => size <= 1024 * 1024), 'large writes are admitted in bounded pieces');
  assert.equal(sizes.reduce((sum, size) => sum + size, 0), 3 * 1024 * 1024 + 1);

  const refused = g.P.__wasiSupervisorOutput({ async stdout() { throw new Error('session reset'); }, async stderr() {} });
  refused.stdoutBytes(enc.encode('lost'));
  assert.equal(await refused.drain(), 'session reset', 'output the session refused is reported');

  const d = g.dup(1);
  assert.equal(await g.write(d, 'via a dup'), E.SUCCESS);
  assert.deepEqual(g.stdout, ['via a dup'], 'a dup of stdout writes to stdout');
  g.dispose();
  checks++;
}

// Cloudflare RpcPromise is thenable but is not a native Promise. Resolve
// its packet before touching RpcProperty fields, and retain output pressure.
{
  const packet = { data: Uint8Array.of(255), ended: false };
  const g = await guest({ stdin: () => ({ then(resolve) { resolve(packet); } }) });
  assert.deepEqual(await g.read(0,1,true), { errno:E.SUCCESS,bytes:[255] });
  let release;
  const gate = new Promise(resolve=>{release=resolve;});
  const out = g.P.__wasiSupervisorOutput({ stdout:()=>({then(resolve,reject){return gate.then(resolve,reject);}}),stderr(){} });
  out.stdoutBytes(Uint8Array.of(1));
  let done=false;const drain=out.drain().then(()=>{done=true;});
  for(let i=0;i<20;i++)await null;
  assert.equal(done,false,'an RPC thenable is not a completed delivery');
  release();await drain;g.dispose();checks++;
}
// ── signals, to a guest that takes them ─────────────────────────────────
{
  const g = await guest({ takesSignals: true });
  const [r, w] = g.pipe();
  const started = Date.now();
  const reading = g.read(r);
  await settle();
  g.control.signal('SIGINT');
  assert.deepEqual(await reading, { errno: ESIGINT, text: null }, 'a signal ends a read of an empty pipe, answered with it');
  assert.ok(Date.now() - started < 2_000, 'at once, not at the wait\'s bound');
  // Taken by that answer: the next read waits again, and gets what is written.
  const next = g.read(r);
  await settle();
  assert.equal(await g.write(w, 'after'), E.SUCCESS);
  assert.deepEqual(await next, { errno: E.SUCCESS, text: 'after' }, 'the read it ended consumed nothing, and it is taken');

  // A child's wait, then a poll: each a signal ends.
  const child = await g.spawn(['sleep', '100']);
  const waiting = g.wait(child.pid);
  await settle();
  g.control.signal('SIGTERM');
  assert.equal((await waiting).errno, ESIGTERM, 'a signal ends a wait for a child');
  const polling = g.poll(r);
  await settle();
  g.control.signal('SIGINT');
  assert.equal((await polling).errno, ESIGINT, 'and a poll of a pipe');
  g.control.exit(child.pid, 0);
  assert.equal((await g.wait(child.pid)).status, 0, 'the child is reaped after');

  // One that came while the guest ran: its next wait ends at once.
  g.control.signal('SIGINT');
  const waiter = g.read(r);
  await settle();
  // (The host asks for one only while the guest waits: this one is taken when the read starts waiting.)
  assert.equal((await waiter).errno, ESIGINT);

  // A child's start is not ended by one: the spawn's start answers, and the signal is the next wait's.
  g.sup.holdStart = true;
  const spawned = g.spawnOnly(['sleep', '1']);
  const { pid } = await spawned;
  const starting = g.start(pid);
  await settle();
  g.control.signal('SIGINT');
  await settle();
  g.control.start(pid);
  assert.equal(await starting, E.SUCCESS, 'the start answered as the child started');
  assert.equal((await g.read(r)).errno, ESIGINT, 'and the signal ends the next wait');
  g.sup.holdStart = false;
  g.control.exit(pid, 0);
  await g.wait(pid);
  g.dispose();
  checks++;
}

// A poll on a clock alone, a write to a child whose stdin is full: each a signal ends, the write withdrawn.
{
  const g = await guest({ takesSignals: true });
  const started = Date.now();
  const sleeping = g.sleep(10_000);
  await settle();
  g.control.signal('SIGINT');
  assert.equal(await sleeping, ESIGINT, 'a signal ends a poll on a clock alone, answered with it');
  assert.ok(Date.now() - started < 2_000, 'at once');

  const [r, w] = g.pipe();
  const child = await g.spawn(['cat'], { fdin: r });
  g.close(r);
  g.sup.stdinFull = true;
  const writing = g.write(w, 'held');
  await settle();
  g.control.signal('SIGTERM');
  assert.equal(await writing, ESIGTERM, 'a signal ends a write to a child whose stdin is full, answered with it');
  assert.deepEqual(g.control.child(child.pid).stdin, [], 'and nothing of it was written');
  g.sup.stdinFull = false;
  assert.equal(await g.write(w, 'after'), E.SUCCESS);
  assert.deepEqual(g.control.child(child.pid).stdin, ['after'], 'the next write is made');
  g.control.exit(child.pid, 0);
  await g.wait(child.pid);
  g.dispose();
  checks++;
}

// A poll the park deadline answered (EAGAIN) waits for no signal after it: the session is asked for none, and the next wait takes the one that comes.
{
  const g = await guest({ takesSignals: true });
  assert.equal(await g.sleep(15_000), E.AGAIN, 'the deadline answers a long poll');
  const asked = g.sup.signalWaits;
  await new Promise((resolve) => setTimeout(resolve, 5_500));
  assert.equal(g.sup.signalWaits, asked, 'nothing waits for a signal for it any more');
  const [r] = g.pipe();
  const reading = g.read(r);
  await settle();
  g.control.signal('SIGINT');
  assert.deepEqual(await reading, { errno: ESIGINT, text: null }, 'the guest\'s next wait takes the signal');
  g.dispose();
  checks++;
}

// Only the guest's own waits are a signal's: a child's output held in a full pipe asks the session for none.
{
  const g = await guest({ takesSignals: true });
  const [r, w] = g.pipe();
  const child = await g.spawn(['yes'], { fdout: w });
  g.close(w);
  g.control.print(child.pid, 1, 'y'.repeat(100_000));
  await settle();
  assert.equal(g.buffered(r), 65536, 'its output fills the pipe');
  await settle();
  assert.equal(g.sup.signalWaits, 0, 'and the pump that holds the rest waits without asking for a signal');
  g.close(r);
  g.control.exit(child.pid, 0);
  await g.wait(child.pid);
  g.dispose();
  checks++;
}

// A stdin read the session interrupted answers the signal to a guest that takes them, EINTR to one that does not.
for (const takesSignals of [true, false]) {
  const g = await guest({ takesSignals, stdin: async () => ({ data: new Uint8Array(0), ended: false, signal: 'SIGINT' }) });
  assert.equal((await g.read(0)).errno, takesSignals ? ESIGINT : E.INTR);
  g.dispose();
  checks++;
}

// A computing guest asks for its signals (CPython's periodic check,
// nimbus_proc.signal_check): each check yields a turn and answers the signal
// held for its process, taken, or SUCCESS; from its first check, its signals
// are watched for the rest of its run, not only while it waits.
{
  const g = await guest({ takesSignals: true });
  assert.equal(await g.check(), E.SUCCESS, 'none sent: SUCCESS');
  g.control.signal('SIGINT');
  let answer = E.SUCCESS;
  for (let i = 0; i < 100 && answer === E.SUCCESS; i++) answer = await g.check();
  assert.equal(answer, ESIGINT, 'one sent while the guest computes reaches a check');
  assert.equal(await g.check(), E.SUCCESS, 'taken: the next check answers SUCCESS');
  g.control.signal('SIGTERM');
  answer = E.SUCCESS;
  for (let i = 0; i < 100 && answer === E.SUCCESS; i++) answer = await g.check();
  assert.equal(answer, ESIGTERM, 'and so does the next one sent');
  g.dispose();
  checks++;
}

// A guest that does not take them is never asked for them.
{
  const g = await guest();
  const [r, w] = g.pipe();
  const reading = g.read(r);
  await settle();
  g.control.signal('SIGINT');
  await settle();
  assert.equal(await g.write(w, 'x'), E.SUCCESS);
  assert.deepEqual(await reading, { errno: E.SUCCESS, text: 'x' }, 'its wait goes on');
  assert.equal(await g.sleep(30), E.SUCCESS, 'and its poll on a clock');
  assert.equal(g.check(), E.SUCCESS, 'its check answers SUCCESS at once, yielding nothing');
  assert.equal(g.sup.signalWaits, 0, 'nothing asked the session for a signal');
  g.dispose();
  checks++;
}

console.log(`wasi-processes: ${checks} groups passed`);
