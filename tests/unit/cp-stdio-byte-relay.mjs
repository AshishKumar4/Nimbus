#!/usr/bin/env bun
// cp-stdio-byte-relay — the child-process stdio relay must carry BYTES.
//
// A child's stdio is not text. esbuild's service protocol is binary packets,
// and so is anything piping an image or an archive through a child. The relay
// runs through the supervisor, and every hop that turns the payload into a
// JS string and back loses any byte sequence that is not valid UTF-8: it
// becomes U+FFFD, which is not reversible.
//
// This drives the shim's own child_process against a stub supervisor, which
// is where the conversions live. NOTE on the stub: its long-poll RPCs must
// honour waitMs. The shim's read and wait loops pass their backoff as the
// supervisor's wait, so a stub that resolves instantly turns them into a
// tight microtask loop that starves the macrotask queue and no timer in the
// test ever fires again.
//
// That the generated entries relay a program's output whole and once is
// opencode-output-capture's: it runs them.
import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { _rpcStdout, _rpcReportExit } from '../../packages/worker/src/session/rpc.ts';
import { StreamTextDecoders } from '../../packages/core/src/_shared/bytes.ts';
import { outputHooks } from '../../packages/core/src/_shared/byte-stream.ts';
import { SHIMS_STORE_PRELUDE } from './lib/shims-namespace.mjs';

// Captured before the shims install their timer barrier over the global.
const realSetTimeout = globalThis.setTimeout;
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));

// The wrapper declares the facet's reported result; the shims append to it.
const factory = new Function(
  '__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname', '__pendingIO',
  '"use strict"; let stdout = "", stderr = "";' + SHIMS_STORE_PRELUDE + generateShimsCode()
    + '\n;return { cp: __childProcessMod, process: __processMod, fs: __fsMod, reported: () => ({ stdout, stderr }) };',
);

// 64 KiB covering every byte value, so no encoding can survive by luck.
const payload = new Uint8Array(65536);
for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;

const stdinSeen = [];
// The child's output, as the supervisor queue would hand it back: the same
// payload in uneven chunks, so a chunk boundary can fall anywhere.
const outputChunks = [];
for (let at = 0, seq = 1; at < payload.length; seq++) {
  const size = 1 + ((seq * 7919) % 4096);
  outputChunks.push({ seq, data: payload.subarray(at, Math.min(at + size, payload.length)) });
  at += size;
}
let outputSent = 0;
const supervisor = {
  cpSpawn: async () => ({ childPid: 7 }),
  cpStdinWrite: async (_pid, data) => { stdinSeen.push(data); return { ok: true }; },
  cpStdinEnd: async () => undefined,
  cpKill: async () => true,
  cpWait: async (_pid, waitMs) => { await sleep(Math.min(waitMs || 50, 50)); return { exitCode: null }; },
  cpReadOutput: async (_pid, fd, since, waitMs) => {
    if (fd === 1 && outputSent < outputChunks.length) {
      const fresh = outputChunks.filter((c) => c.seq > since).slice(0, 3);
      outputSent += fresh.length;
      return { chunks: fresh, closed: false, maxSeq: fresh.at(-1)?.seq ?? since };
    }
    await sleep(Math.min(waitMs || 50, 50));
    return { chunks: [], closed: false, maxSeq: since };
  },
  cpDrainOutput: async () => ({ stdout: new Uint8Array(0), stderr: new Uint8Array(0), stdoutClosed: true, stderrClosed: true }),
};
const { cp, process: childProcess, fs: childFs, reported } = factory(
  {},
  {},
  {},
  supervisor,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  '/home/user',
  [],
  {},
  '/home/user/main.mjs',
  '/home/user',
  []
);

const child = cp.spawn('node', ['service.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
await sleep(40);

// ── parent → child ───────────────────────────────────────────────────────
child.stdin.write(Buffer.from(payload));
await sleep(120);
const sent = Buffer.concat(stdinSeen.map((d) => Buffer.from(d)));
assert.equal(sent.length, payload.length,
  `stdin relay changed the length: ${payload.length} bytes in, ${sent.length} out`);
const firstBadIn = sent.findIndex((b, i) => b !== payload[i]);
assert.equal(firstBadIn, -1,
  firstBadIn < 0 ? '' : `stdin relay changed byte ${firstBadIn}: 0x${payload[firstBadIn].toString(16)} -> 0x${sent[firstBadIn].toString(16)}`);
console.log('  stdin carries all 65536 bytes unmodified');

// ── child → parent ───────────────────────────────────────────────────────
// The parent's Readable must hand back the queue's bytes untouched.
const stdoutSeen = [];

child.stdout.on('data', (d) => stdoutSeen.push(Buffer.from(d)));
const outputDeadline = Date.now() + 5000;
while (Buffer.concat(stdoutSeen).length < payload.length && Date.now() < outputDeadline) await sleep(20);
const received = Buffer.concat(stdoutSeen);
assert.equal(received.length, payload.length,
  `stdout relay changed the length: ${payload.length} bytes out of the child, ${received.length} into the parent`);
const firstBadOut = received.findIndex((b, i) => b !== payload[i]);
assert.equal(firstBadOut, -1,
  firstBadOut < 0 ? '' : `stdout relay changed byte ${firstBadOut}: 0x${payload[firstBadOut].toString(16)} -> 0x${received[firstBadOut].toString(16)}`);
console.log('  stdout carries all 65536 bytes unmodified');

// ── the child's own edge: the reported result is text, decoded streaming ──
// `writeSync(1, bytes)` and `process.stdout.write(bytes)` are the child's
// own byte producers. One character split across the two must read as one.
const euro = new TextEncoder().encode('€'); // e2 82 ac
childFs.writeSync(1, euro.subarray(0, 1));
childProcess.stdout.write(euro.subarray(1));
childProcess.stdout.write('!', 'utf8');
childProcess.stderr.write(Buffer.from('é', 'utf8').subarray(0, 1));
childProcess.stderr.write(Buffer.from('é', 'utf8').subarray(1));
assert.deepEqual(reported(), { stdout: '€!', stderr: 'é' }, 'the reported result decodes a split character as one');
console.log('  the child\'s reported text decodes split characters as one');

// Async fd writes must share that same byte producer, not decode and then
// re-encode at an intermediate edge. Their callback observes delivery/errors.
{
  const raw = new Uint8Array([255, 254, 0, 195, 40]);
  const original = [childProcess.stdout.write, childProcess.stderr.write];
  try {
    for (const fd of [1, 2]) {
      const output = fd === 1 ? childProcess.stdout : childProcess.stderr;
      let received, ack;
      output.write = (bytes, cb) => { received = bytes; ack = cb; return false; };
      let finished = false;
      const written = new Promise((resolve, reject) => childFs.write(fd, raw, 0, raw.length, null, (error, length, buffer) => {
        finished = true;
        if (error) reject(error); else resolve({ length, buffer });
      }));
      await null;
      assert.ok(received instanceof Uint8Array, 'fs.write passes bytes to its stdout/stderr sink');
      assert.deepEqual(received, raw, 'invalid UTF-8 remains byte-exact');
      assert.equal(finished, false, 'the fd callback waits for the sink acknowledgement');
      ack(null);
      assert.deepEqual(await written, { length: raw.length, buffer: raw });
      output.write = (_bytes, cb) => { cb(Object.assign(new Error('closed'), { code: 'EPIPE' })); return false; };
      const failed = await new Promise(resolve => childFs.write(fd, raw, (error, length, buffer) => resolve({ error, length, buffer })));
      assert.equal(failed.error.code, 'EPIPE');
      assert.equal(failed.length, 0);
      assert.equal(failed.buffer, raw);
    }
  } finally {
    childProcess.stdout.write = original[0];
    childProcess.stderr.write = original[1];
  }
  console.log('  asynchronous fd writes carry bytes and acknowledge the actual sink');
}

// ── the split-multibyte test at the log and terminal edges ───────────────
// Bytes of one character delivered in two chunks are decoded as one
// character, per (pid, stream), and a truncated tail is flushed at exit.
{
  const processes = new SessionProcessSupervisor();
  const entry = processes.spawn('node x.js', ['x.js'], '/home/user');
  const writes = [];
  const host = { processes, terminal: { write: (s) => writes.push(s) }, nimbusDebug: false };
  const snowman = new TextEncoder().encode('☃\n'); // e2 98 83 0a
  await _rpcStdout(host, entry.pid, snowman.subarray(0, 2));
  await _rpcStdout(host, entry.pid, snowman.subarray(2));
  // stderr's decoder is its own: its partial character must not merge with stdout's.
  await _rpcStdout(host, entry.pid, snowman.subarray(0, 1));
  const ring = processes.allLogs(entry.pid).map((c) => [c.stream, c.data]);
  assert.deepEqual(ring, [['stdout', '☃\n']], 'the log ring holds the character whole, and nothing for the pending byte');
  assert.deepEqual(writes, ['☃\r\n'], 'the terminal tee paints the character whole, and nothing for the pending byte');
  await _rpcReportExit(host, entry.pid, 0, '');
  const flushed = processes.allLogs(entry.pid).map((c) => [c.stream, c.data]);
  assert.deepEqual(flushed, [['stdout', '☃\n'], ['stdout', '\ufffd']], 'exit flushes the truncated tail as U+FFFD rather than dropping it');
  console.log('  a character split across chunks decodes whole at the log and terminal edges');
}

// ── the same rule in the shared helpers every text consumer uses ─────────
{
  const decoders = new StreamTextDecoders();
  assert.equal(decoders.decode('a', euro.subarray(0, 2)), '');
  assert.equal(decoders.decode('b', euro.subarray(0, 2)), '');
  assert.equal(decoders.decode('a', euro.subarray(2)), '€', 'key a completes its own character');
  assert.equal(decoders.drop('b'), '\ufffd', 'key b flushes its truncated one');
  const out = [];
  const hooks = outputHooks({ stdout: { write: (t) => { out.push(t); } }, stderr: { write: () => {} } });
  await hooks.onStdout(euro.subarray(0, 1));
  await hooks.onStdout(euro.subarray(1));
  await hooks.onStdout(euro.subarray(0, 2));
  await hooks.end();
  assert.deepEqual(out, ['€', '\ufffd'], 'a text output gets whole characters, and its end writes what an unfinished one decodes to');
}


console.log('cp-stdio-byte-relay OK');
process.exit(0);
