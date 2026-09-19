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
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { generateOpencodeRunnerCode } from '../../packages/worker/src/runtime/opencode-facet-runner.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { _rpcStdout, _rpcReportExit } from '../../packages/worker/src/session/rpc.ts';
import { StreamTextDecoders, textSink } from '../../packages/core/src/_shared/bytes.ts';
import {
  generateEntrypointCode,
  generateLongRunningNodeCode,
} from '../../packages/worker/src/facets/manager.ts';

const { parse } = createRequire(new URL('../../packages/core/package.json', import.meta.url))('acorn');
// Captured before the shims install their timer barrier over the global.
const realSetTimeout = globalThis.setTimeout;
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));

// The wrapper declares the facet's reported result; the shims append to it.
const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsWrites', '__vfsDirs', '__vfsManifest',
  '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname', '__pendingIO',
  '"use strict"; let stdout = "", stderr = "";' + generateShimsCode()
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
const { cp, process: childProcess, fs: childFs, reported } = factory({}, {}, {}, {}, {}, supervisor,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  '/home/user', [], {}, '/home/user/main.mjs', '/home/user', []);

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

// ── the split-multibyte test at the log and terminal edges ───────────────
// Bytes of one character delivered in two chunks are decoded as one
// character, per (pid, stream), and a truncated tail is flushed at exit.
{
  const processes = new SessionProcessSupervisor();
  const entry = processes.spawn('node x.js', ['x.js'], '/home/user');
  const writes = [];
  const host = { processes, terminal: { write: (s) => writes.push(s) }, nimbusDebug: false, supervisorForgetBridge: undefined };
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
  const sink = textSink((t) => out.push(t));
  sink(euro.subarray(0, 1)); sink(euro.subarray(1));
  assert.deepEqual(out, ['€'], 'textSink delivers whole characters only');
}

// ── the generated wrappers still parse with the byte relay spliced in ────
// The override that carries a facet's stdout is in the two generated
// wrappers, outside the type checker; a template escape that survives
// typecheck can still produce an unparseable entry.
{
  const state = {
    bundle: {}, manifest: {}, metadata: {}, cursor: 0,
    serializedManifest: '{}', serializedMetadata: '{}',
  };
  const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
  const oneShot = (await generateEntrypointCode('', state, false, generateShimsCode())).code;
  const resident = (await generateLongRunningNodeCode('', state, { cred }, false, generateShimsCode())).code;
  const opencode = generateOpencodeRunnerCode({
    argv: [], env: {}, cred, cwd: '/home/user', stdin: '', mode: 'attached',
    shimsCode: generateShimsCode(), vfsBundle: '{}', vfsManifest: '{}', vfsMetadata: '{}',
  });
  for (const [label, code] of [['one-shot wrapper', oneShot], ['resident wrapper', resident], ['opencode wrapper', opencode]]) {
    assert.doesNotThrow(() => parse(code, { ecmaVersion: 'latest', sourceType: 'module' }), `${label} parses`);
    for (const sink of ['"stdout"', '"stderr"']) {
      assert.ok(code.includes(`__queueRpcWrite(${sink}, b)`), `${label} sends the stream's bytes, not a string`);
    }
  }
  console.log('  both generated wrappers parse and relay bytes');
}

console.log('cp-stdio-byte-relay OK');
process.exit(0);
