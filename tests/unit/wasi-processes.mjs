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
 *   - a spawn the session refuses fails as execvp does (ENOENT), and what the
 *     session cannot deliver is EIO, not a short read.
 */

import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WASI_INSTANCE_PREAMBLE_SRC } from '../../packages/core/src/runtime/wasi-instance.ts';
import { makeImportsWithoutJSPI } from './lib/wasi-imports.mjs';
import { acrossRpc } from './lib/rpc-error.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const E = { SUCCESS: 0, ACCES: 2, AGAIN: 6, BADF: 8, CHILD: 12, INTR: 27, IO: 29, NOENT: 44, PIPE: 64 };
const NONBLOCK = 4;
const GUEST_PID = 7;

/** The session's side: children whose output, exit and stdin the test drives. */
function session() {
  const children = new Map();
  let nextPid = 100;
  let waiters = [];
  const notify = () => { const now = waiters; waiters = []; for (const w of now) w(); };
  const until = (ready, ms) => new Promise((resolve) => {
    const check = () => { if (ready()) { clearTimeout(timer); resolve(); } else waiters.push(check); };
    const timer = setTimeout(resolve, ms);
    check();
  });
  const sup = {
    spawned: [],
    refuse: null,
    async cpSpawn(req) {
      if (sup.refuse) throw acrossRpc(Object.assign(new Error(`${sup.refuse}: ${req.command}`), { code: sup.refuse }));
      const pid = nextPid++;
      children.set(pid, { stdin: [], stdinEnded: false, out: { 1: [], 2: [] }, closed: { 1: false, 2: false }, exit: null, seq: 0 });
      sup.spawned.push({ pid, ...req });
      return { childPid: pid };
    },
    async cpStdinWrite(pid, data) {
      const child = children.get(pid);
      if (child.lost) throw acrossRpc(new Error('session reset'));
      if (child.exit || child.stdinEnded) return { ok: false };
      child.stdin.push(dec.decode(data));
      return { ok: true };
    },
    async cpStdinEnd(pid) { children.get(pid).stdinEnded = true; },
    async cpReadOutput(pid, fd, since, waitMs) {
      const child = children.get(pid);
      await until(() => child.lost || child.closed[fd] || child.out[fd].some((c) => c.seq > since), waitMs);
      if (child.lost) throw acrossRpc(new Error('session reset'));
      return { chunks: child.out[fd].filter((c) => c.seq > since), closed: child.closed[fd], maxSeq: child.seq };
    },
    async cpWait(pid, waitMs) {
      const child = children.get(pid);
      await until(() => child.lost || child.exit !== null, waitMs);
      if (child.lost) throw acrossRpc(new Error('session reset'));
      return child.exit ? { done: true, ...child.exit } : { done: false };
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
    print(pid, fd, text) {
      const child = children.get(pid);
      child.out[fd].push({ seq: ++child.seq, data: enc.encode(text) });
      notify();
    },
    end(pid, exit) {
      const child = children.get(pid);
      child.closed[1] = child.closed[2] = true;
      child.exit = exit;
      notify();
    },
    exit(pid, exitCode) { control.end(pid, { exitCode, signal: null }); },
    lose(pid) { children.get(pid).lost = true; notify(); },
  };
  return { sup, control };
}

async function guest() {
  const modulePath = path.join(os.tmpdir(), `wasi-processes-${process.pid}-${Math.random().toString(16).slice(2)}.mjs`);
  writeFileSync(modulePath, `${WASI_INSTANCE_PREAMBLE_SRC}\nexport { __wasiInitFS, __wasiMakeImports, __wasiAdoptSupervisor };`);
  let P;
  try { P = await import(pathToFileURL(modulePath).href); } finally { rmSync(modulePath, { force: true }); }
  const { sup, control } = session();
  const memory = new WebAssembly.Memory({ initial: 4 });
  const stdout = [];
  P.__wasiInitFS({ root: '', preopens: [{ wasiPath: '/', vfsPath: '' }], pid: GUEST_PID });
  P.__wasiAdoptSupervisor(sup);
  const bundle = makeImportsWithoutJSPI(P, {
    argv: ['guest'], env: {}, getMemory: () => memory,
    stdoutBytes: (bytes) => stdout.push(dec.decode(bytes)), stderrBytes: () => {},
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
    sup, control, stdout,
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
    async read(fd) {
      const at = scratch();
      view().setUint32(at, at + 64, true);
      view().setUint32(at + 4, 1024, true);
      const errno = await wasi.fd_read(fd, at, 1, at + 8);
      return { errno, text: errno === E.SUCCESS ? dec.decode(bytesAt().slice(at + 64, at + 64 + view().getUint32(at + 8, true))) : null };
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
    /** posix_spawn as git's nimbus_spawnvpe makes it: { errno, pid }. */
    async spawn(argv, { env = [], dir = '/home/user', fdin = -1, fdout = -1, fderr = -1 } = {}) {
      const at = scratch();
      const argvLen = strings(at, argv);
      const envLen = strings(at + 1024, env);
      const dirLen = enc.encodeInto(dir, bytesAt().subarray(at + 2048)).written;
      const errno = await proc.spawn(at, argvLen, at + 1024, envLen, at + 2048, dirLen, fdin, fdout, fderr, at + 4000);
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

// ── a wait that gives up consumes nothing ───────────────────────────────
{
  const g = await guest();
  const [r, w] = g.pipe();
  const { errno, pid } = await g.spawn(['slow'], { fdout: w });
  assert.equal(errno, E.SUCCESS);
  assert.equal(await g.close(w), E.SUCCESS);
  const [idleR, idleW] = g.pipe();
  const started = Date.now();
  const [waited, read, polled] = await Promise.all([g.wait(pid), g.read(r), g.poll(idleR)]);
  const took = Date.now() - started;
  assert.equal(waited.errno, E.INTR, 'a wait on a child that runs on gives up');
  assert.equal(read.errno, E.INTR, 'so does a read of its output');
  assert.equal(polled.errno, E.INTR, 'and a poll of an idle pipe, before the watchdog');
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
  assert.deepEqual((await g.poll(w, 'write')).events, [{ error: 0, nbytes: 0xFFFF_FFFF, hangup: false }]);
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

  const [r3, w3] = g.pipe();
  await g.close(r3);
  assert.equal(await g.write(w3, 'x'), E.PIPE, 'EPIPE once every reader is gone');
  assert.equal(await g.write(r, 'x'), E.BADF, 'a read end is not written');
  checks++;
}

// ── a child: what it is started with, its streams, how it ends ──────────
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
  checks++;
}

console.log(`wasi-processes: ${checks} groups passed`);
