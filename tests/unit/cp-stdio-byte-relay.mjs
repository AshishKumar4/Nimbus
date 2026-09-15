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
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

// Captured before the shims install their timer barrier over the global.
const realSetTimeout = globalThis.setTimeout;
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));

const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsWrites', '__vfsDirs', '__vfsManifest',
  '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname', '__pendingIO',
  '"use strict";' + generateShimsCode() + '\n;return __childProcessMod;',
);

// 64 KiB covering every byte value, so no encoding can survive by luck.
const payload = new Uint8Array(65536);
for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;

const stdinSeen = [];
const supervisor = {
  cpSpawn: async () => ({ childPid: 7 }),
  cpStdinWrite: async (_pid, data) => { stdinSeen.push(data); return { ok: true }; },
  cpStdinEnd: async () => undefined,
  cpKill: async () => true,
  cpWait: async (_pid, waitMs) => { await sleep(Math.min(waitMs || 50, 50)); return { exitCode: null }; },
  cpReadOutput: async (_pid, _fd, _since, waitMs) => {
    await sleep(Math.min(waitMs || 50, 50));
    return { chunks: [], closed: false, maxSeq: 0 };
  },
};
const cp = factory({}, {}, {}, {}, {}, supervisor,
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

// The child → parent direction is the next commit: the child's own
// process.stdout.write stringifies at node-shims.ts:5752, upstream of this
// relay, so byte-exact output needs that and the lifo sandbox/shell
// interfaces changed too.

console.log('cp-stdio-byte-relay OK');
process.exit(0);
