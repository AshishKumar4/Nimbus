#!/usr/bin/env bun
// Smoke test for the staged OpenTUI wasm32-wasi reactor artifact
// (packages/worker/scripts/opentui/build-wasm.mjs). Instantiates the BUILT
// artifact under the real wasi-instance.ts preamble host and proves:
//   - the artifact on disk matches the generated constants and manifest
//   - its WASI import set is a subset of what wasi-instance.ts implements
//   - _initialize → createRenderer → bufferDrawText → render(force) == 0
//   - ANSI frame bytes are produced (memory backend and span-feed backend)
//   - all three host-token callback imports fire (log / event sink / stream)
//   - the nimbus_alloc / nimbus_free copy-in arena exports work

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  OPENTUI_WASM_VERSION,
  OPENTUI_WASM_ENTRY,
  OPENTUI_WASM_BUILD_ID,
  OPENTUI_WASM_SHA256,
} from '../../packages/worker/src/opentui-wasm-artifact.generated.ts';
import {
  WASI_IMPLEMENTED_FNS,
  WASI_INSTANCE_PREAMBLE_SRC,
} from '../../packages/worker/src/runtime/wasi-instance.ts';

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../packages/worker',
);
const assetDir = path.join(workerRoot, 'public', OPENTUI_WASM_ENTRY.replace(/^\/_assets/, '_assets').replace(/\/opentui\.wasm$/, ''));
const bytes = readFileSync(path.join(workerRoot, 'public', OPENTUI_WASM_ENTRY.slice(1)));
const manifest = JSON.parse(readFileSync(path.join(assetDir, 'manifest.json'), 'utf8'));

// ── Artifact ↔ constants ↔ manifest integrity ───────────────────────────────
const sha = createHash('sha256').update(bytes).digest('hex');
assert.equal(sha, OPENTUI_WASM_SHA256, 'staged artifact drifted from generated constants — rerun build-wasm.mjs');
assert.equal(OPENTUI_WASM_BUILD_ID, sha.slice(0, 16));
assert.equal(manifest.version, OPENTUI_WASM_VERSION);
assert.equal(manifest.artifact.sha256, sha);
assert.equal(manifest.artifact.size, bytes.length);

// ── Import surface ───────────────────────────────────────────────────────────
const module = new WebAssembly.Module(bytes);
const imports = WebAssembly.Module.imports(module);
const implemented = new Set(WASI_IMPLEMENTED_FNS);
const wasiImports = imports.filter((i) => i.module === 'wasi_snapshot_preview1').map((i) => i.name);
for (const name of wasiImports) {
  assert.ok(implemented.has(name), `WASI import '${name}' is not implemented by wasi-instance.ts`);
}
assert.deepEqual(wasiImports.sort(), [...manifest.imports.wasi_snapshot_preview1]);
const callbackImports = imports.filter((i) => i.module === 'opentui').map((i) => i.name).sort();
assert.deepEqual(callbackImports, ['eventSinkCallback', 'logCallback', 'streamCallback']);
assert.equal(imports.length, wasiImports.length + callbackImports.length, 'unexpected extra import module');
assert.equal(WebAssembly.Module.exports(module).length, manifest.exportCount);

// ── Host: the real wasi-instance.ts preamble + the opentui callback shims ────
// The preamble is module-shaped (it uses top-level await), so evaluate it as
// an ES module from a temp file (bun cannot import data: URLs).
const preambleSrc = `${WASI_INSTANCE_PREAMBLE_SRC}\nexport { __wasiInitFS, __wasiMakeImports };`;
const preamblePath = path.join(os.tmpdir(), `opentui-smoke-wasi-preamble-${process.pid}.mjs`);
writeFileSync(preamblePath, preambleSrc);
let preamble;
try {
  preamble = await import(pathToFileURL(preamblePath).href);
} finally {
  rmSync(preamblePath, { force: true });
}
preamble.__wasiInitFS({ root: 'wasi-root', preopens: [{ wasiPath: '/', vfsPath: 'wasi-root' }], files: {}, dirs: [] });

let memory;
const wasi = preamble.__wasiMakeImports({ argv: ['opentui'], env: {}, getMemory: () => memory });

const decoder = new TextDecoder();
const readBytes = (ptr, len) => new Uint8Array(memory.buffer).slice(ptr, ptr + len);
const readStr = (ptr, len) => decoder.decode(readBytes(ptr, len));

const TOKENS = { log: 11, sink: 22, stream: 33 };
const logCalls = [];
const sinkCalls = [];
const streamCalls = [];
const instance = new WebAssembly.Instance(module, {
  wasi_snapshot_preview1: wasi.wasiImport,
  opentui: {
    logCallback: (token, level, msgPtr, msgLen) => logCalls.push({ token, level, msg: readStr(msgPtr, msgLen) }),
    eventSinkCallback: (token, namePtr, nameLen, dataPtr, dataLen) =>
      sinkCalls.push({ token, name: readStr(namePtr, nameLen), dataLen }),
    streamCallback: (token, streamPtr, eventId, arg0, arg1) =>
      streamCalls.push({ token, streamPtr, eventId, arg0, arg1 }),
  },
});
const e = instance.exports;
memory = e.memory;
e._initialize();

// ── Arena protocol ───────────────────────────────────────────────────────────
const encoder = new TextEncoder();
function arenaWrite(data) {
  const ptr = e.nimbus_alloc(data.byteLength);
  assert.notEqual(ptr, 0, 'nimbus_alloc returned null');
  assert.equal(ptr % 16, 0, 'nimbus_alloc result is not 16-byte aligned');
  new Uint8Array(memory.buffer).set(new Uint8Array(data.buffer ?? data), ptr);
  return ptr;
}
const whiteFg = new Uint16Array([65535, 65535, 65535, 65535]);

// ── Log callback: invalid renderer dims produce a warn through the token ─────
e.setLogCallback(TOKENS.log);
assert.equal(e.createRenderer(0, 0, 1, 1, 0), 0);
assert.equal(logCalls.length, 1);
assert.deepEqual(logCalls[0], { token: TOKENS.log, level: 1, msg: 'Invalid renderer dimensions: 0x0' });

// ── Memory backend: createRenderer → drawText → render(force) == 0 ───────────
const renderer = e.createRenderer(80, 24, 1 /* memory */, 1 /* local */, 0);
assert.notEqual(renderer, 0, 'createRenderer(memory backend) failed');
const frame = e.getNextBuffer(renderer);
assert.equal(e.getBufferWidth(frame), 80);
assert.equal(e.getBufferHeight(frame), 24);
const text = encoder.encode('hello wasm');
const textPtr = arenaWrite(text);
const fgPtr = arenaWrite(whiteFg);
e.bufferDrawText(frame, textPtr, text.length, 2, 1, fgPtr, 0, 0);
assert.equal(e.render(renderer, 1), 0, 'render(force) should return 0');
e.nimbus_free(textPtr, text.length);
e.nimbus_free(fgPtr, whiteFg.byteLength);

// ── Event sink callback: EditBuffer insert emits through the token ───────────
const sink = e.createEventSink(TOKENS.sink);
assert.notEqual(sink, 0);
const editBuffer = e.createEditBuffer(1, sink);
assert.notEqual(editBuffer, 0);
const insert = encoder.encode('abc');
const insertPtr = arenaWrite(insert);
e.editBufferInsertText(editBuffer, insertPtr, insert.length);
e.nimbus_free(insertPtr, insert.length);
assert.ok(sinkCalls.length >= 1, 'event sink callback never fired');
assert.ok(sinkCalls.every((c) => c.token === TOKENS.sink));
assert.ok(sinkCalls.some((c) => c.name === 'eb_content-changed'), `missing content-changed event: ${JSON.stringify(sinkCalls)}`);

// ── Span feed: stream callback fires and the chunk carries ANSI frame bytes ──
const STREAM_EVENT = { ChunkAdded: 2, DataAvailable: 7, StateBuffer: 8 };
const feed = e.createNativeSpanFeed(0);
assert.notEqual(feed, 0);
e.streamSetCallback(feed, TOKENS.stream);
assert.equal(e.attachNativeSpanFeed(feed), 0);
const feedRenderer = e.createRenderer(40, 10, 0, 1, feed);
assert.notEqual(feedRenderer, 0);
const feedFrame = e.getNextBuffer(feedRenderer);
const feedTextPtr = arenaWrite(text);
const feedFgPtr = arenaWrite(whiteFg);
e.bufferDrawText(feedFrame, feedTextPtr, text.length, 0, 0, feedFgPtr, 0, 0);
assert.equal(e.render(feedRenderer, 1), 0);
e.nimbus_free(feedTextPtr, text.length);
e.nimbus_free(feedFgPtr, whiteFg.byteLength);

assert.ok(streamCalls.every((c) => c.token === TOKENS.stream && c.streamPtr !== 0));
assert.ok(streamCalls.some((c) => c.eventId === STREAM_EVENT.StateBuffer), 'no StateBuffer stream event');
assert.ok(streamCalls.some((c) => c.eventId === STREAM_EVENT.DataAvailable), 'no DataAvailable stream event');
const chunks = streamCalls.filter((c) => c.eventId === STREAM_EVENT.ChunkAdded);
assert.ok(chunks.length >= 1, 'no ChunkAdded stream event');
const feedBytes = chunks
  .map((c) => decoder.decode(readBytes(c.arg0, Number(c.arg1))))
  .join('');
assert.ok(feedBytes.includes('\u001b['), 'span-feed chunk contains no ANSI escape sequences');
assert.ok(feedBytes.includes('hello wasm'), 'span-feed chunk does not contain the drawn text');

console.log(
  `opentui-wasm-smoke OK: ${OPENTUI_WASM_VERSION} build ${OPENTUI_WASM_BUILD_ID}, ` +
    `${wasiImports.length} WASI imports ⊆ wasi-instance.ts, ` +
    `log/sink/stream callbacks fired (${logCalls.length}/${sinkCalls.length}/${streamCalls.length}), ` +
    `${feedBytes.length} ANSI feed bytes`,
);
