#!/usr/bin/env bun
// Stage B backend test for the OpenTUI wasm FFI backend
// (packages/worker/src/runtime/opentui-wasm-backend.ts). Loads the backend over
// the staged Stage A artifact under the REAL wasi-instance.ts host, then proves
// the @opentui/core backend contract end-to-end:
//   1. dlopen resolves EVERY symbol zig.ts requests to a callable
//   2. arena round-trip: UTF-8 string + packed RGBA Uint16Array copy-in; out-param copy-back
//   3. live cell views survive a forced memory.grow (re-derived; stale handled)
//   4. all 3 callbacks via createCallback decode token→fn with UTF-8 + BigInt
//   5. a full render cycle THROUGH the backend interface yields real ANSI + text
//
// Driven off zig.ts's actual symbol table so symbol drift fails loudly.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { OPENTUI_WASM_ENTRY } from '../../packages/worker/src/opentui-wasm-artifact.generated.ts';
import { WASI_INSTANCE_PREAMBLE_SRC } from '../../packages/worker/src/runtime/wasi-instance.ts';
import { OpenTUIWasmBackend } from '../../packages/worker/src/runtime/opentui-wasm-backend.ts';
import { ZIG_FFI_SYMBOLS } from './opentui-zig-symbols.mjs';

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../packages/worker',
);
const bytes = readFileSync(path.join(workerRoot, 'public', OPENTUI_WASM_ENTRY.slice(1)));
const module = new WebAssembly.Module(bytes);

// ── WASI host: evaluate the real wasi-instance.ts preamble (reuse, not fork) ──
const preambleSrc = `${WASI_INSTANCE_PREAMBLE_SRC}\nexport { __wasiInitFS, __wasiMakeImports };`;
const preamblePath = path.join(os.tmpdir(), `opentui-backend-wasi-preamble-${process.pid}.mjs`);
writeFileSync(preamblePath, preambleSrc);
let preamble;
try {
  preamble = await import(pathToFileURL(preamblePath).href);
} finally {
  rmSync(preamblePath, { force: true });
}
const wasiHost = {
  makeImports: (opts) => preamble.__wasiMakeImports(opts),
  initFS: (opts) => preamble.__wasiInitFS(opts),
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const backend = OpenTUIWasmBackend.create({ module, wasi: wasiHost, env: {} });

// ── Check 1: dlopen resolves every zig.ts symbol to a callable ───────────────
const lib = backend.dlopen('opentui.wasm', ZIG_FFI_SYMBOLS);
const names = Object.keys(ZIG_FFI_SYMBOLS);
assert.ok(names.length >= 270, `expected the full bound surface, got ${names.length}`);
for (const name of names) {
  assert.equal(typeof lib.symbols[name], 'function', `symbol '${name}' did not resolve to a callable`);
}
const s = lib.symbols;
console.log(`  [1] dlopen resolved all ${names.length} zig.ts symbols to callables`);

// ── Check 4 (callbacks): register via createCallback, trigger from Zig ────────
const logEvents = [];
const sinkEvents = [];
const streamEvents = [];

const logCb = lib.createCallback(
  (level, msgPtr, msgLen) => logEvents.push({ level, msg: decoder.decode(backend.toArrayBuffer(msgPtr, 0, Number(msgLen))) }),
  { args: ['u8', 'ptr', 'usize'], returns: 'void' },
);
assert.notEqual(logCb.ptr, 0);
assert.equal(logCb.threadsafe, false);
s.setLogCallback(logCb.ptr);

// Invalid dims → a warn line through the log token.
assert.equal(s.createRenderer(0, 0, 1, 1, null), 0);
assert.equal(logEvents.length, 1);
assert.deepEqual(logEvents[0], { level: 1, msg: 'Invalid renderer dimensions: 0x0' });

// Event sink: EditBuffer insert emits a named event with data through the token.
const eventCb = lib.createCallback(
  (namePtr, nameLen, dataPtr, dataLen) =>
    sinkEvents.push({
      name: decoder.decode(backend.toArrayBuffer(namePtr, 0, Number(nameLen))),
      dataLen: Number(dataLen),
    }),
  { args: ['ptr', 'usize', 'ptr', 'usize'], returns: 'void' },
);
const sink = s.createEventSink(eventCb.ptr);
assert.notEqual(sink, 0);
const editBuffer = s.createEditBuffer(1, sink);
assert.notEqual(editBuffer, 0);
const insert = encoder.encode('abc');
s.editBufferInsertText(editBuffer, insert, insert.length);
assert.ok(sinkEvents.some((e) => e.name === 'eb_content-changed'), `missing content-changed: ${JSON.stringify(sinkEvents)}`);
console.log(`  [4] createCallback token→fn dispatch decoded log + event-sink (UTF-8) callbacks`);

// ── Check 2: arena round-trip — UTF-8 + RGBA Uint16Array copy-in; out-param ──
// Copy-in path is exercised by passing raw Uint8Array/Uint16Array as `ptr` args.
const whiteFg = new Uint16Array([65535, 65535, 65535, 65535]);
const renderer = s.createRenderer(80, 24, 1 /* memory */, 1 /* local */, null);
assert.notEqual(renderer, 0, 'createRenderer(memory) failed');
const frame = s.getNextBuffer(renderer);
assert.equal(s.getBufferWidth(frame), 80);
assert.equal(s.getBufferHeight(frame), 24);
const text = encoder.encode('hello wasm');
// bufferDrawText: textBytes (UTF-8 copy-in), fg (RGBA Uint16Array copy-in via ptr()).
s.bufferDrawText(frame, text, text.length, 2, 1, backend.ptr(whiteFg.buffer), 0, 0);

// Out-param copy-back: bufferGetId writes the buffer id into a JS-owned out buffer.
const idOut = new Uint8Array(64);
const idLen = Number(s.bufferGetId(frame, idOut, idOut.length));
assert.ok(idLen > 0 && idLen <= idOut.length, `bufferGetId returned bad length ${idLen}`);
const idStr = decoder.decode(idOut.subarray(0, idLen));
assert.ok(idStr.length === idLen && /\S/.test(idStr), `bufferGetId out-buffer not copied back: ${JSON.stringify(idStr)}`);
console.log(`  [2] arena copy-in (UTF-8 + RGBA u16) drew text; out-param copy-back read id '${idStr}'`);

// ── Check 3: live cell views survive a forced memory.grow ────────────────────
// `frame` (the back buffer) holds the draw until render swaps it. The five
// cell-array symbols return offsets the caller reads as LIVE windows over linear
// memory via backend.liveView — the path buffer.ts's ensureRawBufferViews uses.
const size = 80 * 24;
const drawnChars = (view) => {
  let out = '';
  for (let i = 0; i < size; i++) {
    const cp = view[i] & 0x1fffff;
    if (cp >= 32) out += String.fromCodePoint(cp);
  }
  return out.replace(/ +/g, ' ').trim();
};
const charPtr = s.bufferGetCharPtr(frame);
const fgPtr = s.bufferGetFgPtr(frame);
assert.notEqual(charPtr, 0);
assert.notEqual(fgPtr, 0);
// The live view tracks Zig's write: the drawn text is visible in the char cells.
const charView0 = backend.liveView(Uint32Array, charPtr, size);
assert.ok(drawnChars(charView0).includes('hello wasm'), `drawn text missing from live cell view: ${JSON.stringify(drawnChars(charView0))}`);
// fg view is a 4×u16 RGBA quad per cell; the drawn cells carry the white fg.
const fgView0 = backend.liveView(Uint16Array, fgPtr, size * 4);
assert.ok([...fgView0].some((v) => v === 65535), 'fg RGBA live view missing the drawn white channel');

const bytesBefore = backend.memory.buffer.byteLength;
// Force a real memory.grow through a LEGITIMATE large FFI allocation — big
// renderer cell buffers — not by abusing ptr() as a manual allocator (ptr()
// scratch is transient and reclaimed by the next symbol call).
let grew = false;
for (let i = 0; i < 16 && !grew; i++) {
  const ballast = s.createRenderer(1024, 512, 1 /* memory */, 1 /* local */, null);
  assert.notEqual(ballast, 0, 'ballast renderer alloc failed');
  if (backend.memory.buffer.byteLength > bytesBefore) grew = true;
}
assert.ok(grew, 'failed to force a memory.grow via large renderer allocation');

// The pre-grow view is now over a DETACHED ArrayBuffer — proving the staleness
// footgun is real. A detached buffer reports byteLength 0 and its elements read
// back as undefined (engine-agnostic; some engines throw, bun yields undefined).
assert.equal(charView0.buffer.byteLength, 0, 'expected the pre-grow buffer to be detached after memory.grow');
assert.equal(charView0[0], undefined, 'a detached view must not surface live data');

// Re-derive after the grow: liveView rebuilds over the CURRENT buffer and the
// cell data is intact — no detached-buffer throw leaks to the caller.
const charView1 = backend.liveView(Uint32Array, s.bufferGetCharPtr(frame), size);
const recovered = drawnChars(charView1);
assert.ok(recovered.includes('hello wasm'), `re-derived live view lost cell data: ${JSON.stringify(recovered)}`);
// toArrayBuffer (the copy path) must also be detach-safe after a grow.
assert.equal(backend.toArrayBuffer(s.bufferGetCharPtr(frame), 0, size * 4).byteLength, size * 4);
console.log(`  [3] memory.grow detached the stale view; re-derived live view valid ('${recovered}')`);

// Render swaps the back buffer to current; subsequent checks use the span feed.
assert.equal(s.render(renderer, 1), 0, 'render(force) should return 0');

// ── Check 5: full cycle through the backend → span-feed ANSI + drawn text ────
const STREAM_EVENT = { ChunkAdded: 2, DataAvailable: 7, StateBuffer: 8 };
const streamCb = lib.createCallback(
  (streamPtr, eventId, arg0, arg1) => streamEvents.push({ streamPtr, eventId, arg0, arg1 }),
  { args: ['ptr', 'u32', 'ptr', 'u64'], returns: 'void' },
);
const feed = s.createNativeSpanFeed(null);
assert.notEqual(feed, 0);
s.streamSetCallback(feed, streamCb.ptr);
assert.equal(s.attachNativeSpanFeed(feed), 0);
const feedRenderer = s.createRenderer(40, 10, 0 /* span-feed */, 1, feed);
assert.notEqual(feedRenderer, 0);
const feedFrame = s.getNextBuffer(feedRenderer);
s.bufferDrawText(feedFrame, text, text.length, 0, 0, backend.ptr(whiteFg.buffer), 0, 0);
assert.equal(s.render(feedRenderer, 1), 0);

assert.ok(streamEvents.length > 0, 'no stream callback events');
assert.ok(streamEvents.every((e) => e.streamPtr !== 0), 'stream callback got a null stream');
assert.ok(streamEvents.some((e) => e.eventId === STREAM_EVENT.StateBuffer), 'no StateBuffer event');
assert.ok(streamEvents.some((e) => e.eventId === STREAM_EVENT.DataAvailable), 'no DataAvailable event');
const chunks = streamEvents.filter((e) => e.eventId === STREAM_EVENT.ChunkAdded);
assert.ok(chunks.length >= 1, 'no ChunkAdded event');
const feedBytes = chunks
  .map((c) => decoder.decode(backend.toArrayBuffer(c.arg0, 0, Number(c.arg1))))
  .join('');
assert.ok(feedBytes.includes('['), 'span-feed chunk has no ANSI escape sequences');
assert.ok(feedBytes.includes('hello wasm'), 'span-feed chunk does not contain the drawn text');
console.log(`  [5] full cycle through backend → span-feed produced ${feedBytes.length} ANSI bytes with the drawn text`);

// ── Check 6: sustained ptr() scratch is reclaimed (no per-frame leak) ─────────
// zig.ts calls ptr() (rgbaPtr) inline on every draw and never frees — native FFI
// pointers into JS memory are transient. The backend must reclaim each ptr()
// allocation on the consuming symbol call, or a render loop leaks linear memory.
// Allocate a large transient block per iteration and immediately consume it with
// a symbol call; if reclaimed, the same arena slot is reused and memory stays
// flat — a leak would force 256×1MB of growth.
{
  const block = new Uint8Array(1024 * 1024);
  backend.ptr(block);
  s.getBufferWidth(feedFrame); // warmup: absorbs any one-time growth for this size
  const baseBytes = backend.memory.buffer.byteLength;
  for (let i = 0; i < 256; i++) {
    backend.ptr(block); // transient 1MB scratch...
    s.getBufferWidth(feedFrame); // ...reclaimed by this consuming call
  }
  assert.equal(
    backend.memory.buffer.byteLength,
    baseBytes,
    `transient ptr() scratch leaked: memory grew ${baseBytes} → ${backend.memory.buffer.byteLength} over 256×1MB allocations`,
  );
  console.log(`  [6] 256×1MB transient ptr() allocations reclaimed — linear memory flat (no leak)`);
}

lib.close();
console.log(
  `opentui-wasm-backend OK: ${names.length} symbols, ` +
    `arena copy-in/out, grow-safe live views, 3 token callbacks, full render cycle, leak-free ptr()`,
);
