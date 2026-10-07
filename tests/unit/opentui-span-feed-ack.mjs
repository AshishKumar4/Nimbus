#!/usr/bin/env bun
// Stage D rung 1b — span-feed consumption ack regression. Drives opencode's REAL
// renderer path (createCliRenderer → loop) over the Nimbus-patched @opentui/core
// bundle + wasm backend for many frames and proves the OOM leak is closed:
//
//   - the state_buffer length (one refcount slot per chunk → the chunk-ring
//     size) stays at initialChunks (2) — the Zig core reuses its chunk ring
//     instead of mallocing a fresh 64KiB chunk and re-emitting a larger
//     state_buffer every frame. (streamGetStats().chunks reads 0 under this
//     synthetic harness — the wasm build leaves those counters unpopulated — so
//     the ring size is observed through the live state_buffer the ack path uses.)
//   - backend.memory.buffer.byteLength is stable — wasm linear memory does not
//     climb monotonically toward the isolate cap.
//   - at idle the LIVE state_buffer refcounts are all zero — proof the
//     decrementRefcount ack was written into Zig's real shared memory, not a
//     detach-safe snapshot. On current HEAD without the bundle-patches seam 9
//     (event-8 snapshot + dead write-back) the ring grows (state_buffer len
//     2 → 4+) and wasm linear memory climbs monotonically (RED).
//
// Same source dependency as opentui-cli-renderer-frame.mjs: the @opentui/core
// source from the opencode build clone; SKIPS with a clear message when absent.

import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
  rmSync,
  cpSync,
  mkdtempSync,
  readdirSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  nimbusPatchOpenTUI,
  OPENTUI_FFI_CHUNK_MARKER,
} from '../../packages/worker/scripts/opencode/bundle-patches.ts';
import { OpenTUIWasmBackend } from '../../packages/core/src/runtime/opentui-wasm-backend.ts';
import { OPENTUI_WASM_ENTRY } from '../../packages/worker/src/opentui-wasm-artifact.generated.ts';
import { makeSyntheticStdin, makeSyntheticStdout, openTUICoreDirOrSkip, wasiHost } from './lib/opentui-harness.mjs';

const coreDir = openTUICoreDirOrSkip('opentui-span-feed-ack');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'opentui-span-ack-'));
let backend;
let renderer;
try {
  cpSync(coreDir, tmp, { recursive: true });

  let patchedChunks = 0;
  for (const f of readdirSync(tmp).filter((f) => /^index(-[a-z0-9]+)?\.js$/.test(f))) {
    const p = path.join(tmp, f);
    const src = readFileSync(p, 'utf8');
    if (!src.includes(OPENTUI_FFI_CHUNK_MARKER)) continue;
    writeFileSync(p, nimbusPatchOpenTUI(src, f));
    patchedChunks++;
  }
  assert.equal(patchedChunks, 1, `expected exactly one @opentui FFI chunk, patched ${patchedChunks}`);

  const wasi = await wasiHost();
  const workerPublic = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../../packages/worker/public',
  );
  const module = new WebAssembly.Module(readFileSync(workerPublic + OPENTUI_WASM_ENTRY));
  backend = OpenTUIWasmBackend.create({
    module,
    wasi,
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  globalThis.__nimbusOpenTUIBackend = backend;

  const otui = await import(pathToFileURL(path.join(tmp, 'index.js')).href);
  const WIDTH = 80;
  const HEIGHT = 24;
  const sink = [];
  const stdin = makeSyntheticStdin();
  const stdout = makeSyntheticStdout(WIDTH, HEIGHT, sink);

  renderer = await otui.createCliRenderer({
    stdin,
    stdout,
    targetFps: 60,
    exitOnCtrlC: false,
    useMouse: false,
    autoFocus: false,
    openConsoleOnError: false,
    useKittyKeyboard: {},
  });
  const feed = renderer._feed;
  assert.ok(feed, 'expected the span-feed output path (custom stdout) to be active');

  // The chunk-ring size == the state_buffer length (one refcount slot per chunk);
  // the backend-gated ack path stores it on the {ptr,len} state object. On Zig
  // ring growth emitStateBuffer re-fires with a larger len, so this tracks the
  // live chunk count without the (unpopulated) streamGetStats counters.
  const ringLen = () => (feed.stateBuffer && feed.stateBuffer.__nimbusStateLen) || 0;
  const wasmBytes = () => backend.memory.buffer.byteLength;

  const white = otui.RGBA.fromValues(1, 1, 1, 1);
  const FRAMES = 48;

  // Warm the ring: the first frames allocate initialChunks up front. Sample the
  // steady state after a short warmup so a legitimate one-time ring fill isn't
  // read as a leak.
  const WARMUP = 6;
  let baselineRing = 0;
  let baselineBytes = 0;
  let maxRing = 0;

  for (let i = 0; i < FRAMES; i++) {
    renderer.forceFullRepaintRequested = true;
    // Changing content every frame → fresh spans → real chunk-ring traffic; a
    // broken ack would grow the ring/linear-memory monotonically across these.
    renderer.nextRenderBuffer.drawText(`NIMBUS_FRAME_${i} ${'#'.repeat((i % 40) + 1)}`, 2, 2 + (i % 18), white);
    await renderer.loop();
    await new Promise((r) => setTimeout(r, 2));
    if (i === WARMUP) {
      baselineRing = ringLen();
      baselineBytes = wasmBytes();
    }
    if (i >= WARMUP) maxRing = Math.max(maxRing, ringLen());
  }
  await new Promise((r) => setTimeout(r, 40));

  const out = sink.join('');
  assert.ok(/\x1b\[/.test(out) && out.includes('NIMBUS_FRAME_'), 'renderer did not emit drawn frames through the span feed');
  console.log(`  [1] rendered ${FRAMES} frames of changing content through the span feed (${out.length}B ANSI)`);

  // ── chunk-ring bounded: no monotonic growth past the warmup baseline ──
  const finalRing = ringLen();
  assert.ok(baselineRing > 0, `expected a positive chunk-ring size after warmup, got ${baselineRing}`);
  assert.ok(
    maxRing <= baselineRing,
    `chunk ring grew after warmup: baseline=${baselineRing} max=${maxRing} final=${finalRing} — ack not reaching Zig (leak)`,
  );
  assert.ok(
    baselineRing <= 4,
    `chunk ring larger than the initialChunks ring (${baselineRing}) — unexpected allocation`,
  );
  console.log(`  [2] chunk ring (state_buffer len) stable across ${FRAMES} frames (baseline=${baselineRing}, max=${maxRing}, final=${finalRing} — ring reused at initialChunks)`);

  // ── wasm linear memory did not climb ──
  const finalBytes = wasmBytes();
  assert.equal(
    finalBytes,
    baselineBytes,
    `wasm linear memory grew ${baselineBytes} → ${finalBytes} across frames — chunks never freed (the OOM)`,
  );
  console.log(`  [3] backend.memory.buffer.byteLength stable at ${finalBytes} bytes (no monotonic growth)`);

  // ── the ack landed in LIVE shared memory: at idle every real refcount is 0 ──
  await feed.idle();
  assert.equal(feed.hasPinnedChunks(), false, 'feed still reports pinned chunks at idle — refcount ack did not land');
  assert.ok(feed.stateBuffer && feed.stateBuffer.__nimbusBackend, 'expected the backend-gated state view (facet mode)');
  const liveState = backend.liveView(
    Uint8Array,
    feed.stateBuffer.__nimbusStatePtr,
    feed.stateBuffer.__nimbusStateLen,
  );
  const pinned = [...liveState].reduce((a, b) => a + (b > 0 ? 1 : 0), 0);
  assert.equal(pinned, 0, `live Zig state_buffer has ${pinned} pinned refcounts at idle — decrement wrote a dead snapshot`);
  console.log(`  [4] live Zig state_buffer all-zero at idle over ${feed.stateBuffer.__nimbusStateLen} slots — decrement ack reached real memory`);

  renderer.destroy();
  renderer = null;
  console.log('opentui-span-feed-ack OK: span-feed consumption acks reach live wasm memory — chunk ring + linear memory bounded (TUI OOM closed)');
} finally {
  try { renderer?.destroy(); } catch { /* already torn down */ }
  delete globalThis.__nimbusOpenTUIBackend;
  rmSync(tmp, { recursive: true, force: true });
}
