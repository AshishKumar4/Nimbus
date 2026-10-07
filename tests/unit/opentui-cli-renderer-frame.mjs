#!/usr/bin/env bun
// Stage D rung 1 — drive opencode's REAL high-level renderer path
// (createCliRenderer → CliRenderer → setupTerminal → loop) over the
// Nimbus-patched @opentui/core bundle + the wasm FFI backend, render frames with
// drawn content, and assert that real ANSI escape sequences carrying that
// content reach the terminal output seam.
//
// This is the authoritative resolution of the inherited "bare
// FFIRenderLib.createRenderer OOB" lead AND of how OpenTUI output actually
// surfaces on the wasm build:
//
//   1. The OOB did NOT reproduce: raw symbols.createRenderer(w,h,buf,remote,feed)
//      works for every remoteMode (0/1/2) under the Stage-B arena fixes. The bare
//      call OOB'd because it skipped the full high-level setup
//      (setupTerminal/setUseThread/getNextBuffer/the Renderable tree); driving
//      createCliRenderer — the API opencode uses (app.tsx tuiRendererConfig) —
//      exercises all of it and constructs cleanly.
//
//   2. OUTPUT MODEL: the wasm32-wasi reactor performs NO terminal syscalls of its
//      own (build-wasm README) — it never writes fd 1. ANSI frames surface ONLY
//      through the native span feed (NativeSpanFeed) or the memory backend. So
//      opencode's default `stdout === process.stdout` path (no feed) yields ZERO
//      output on wasm; the facet must run the renderer with a custom stdout so
//      OpenTUI takes the span-feed path, whose onData forwards ANSI to the facet
//      terminal. This test drives exactly that path.
//
// Three backend correctness fixes this exercises (all in
// opentui-wasm-backend.ts / bundle-patches.ts):
//   - ptr() OUT-buffer copy-back: streamDrainSpans(ptr(drainBuffer)) and every
//     FFIRenderLib ptr(outBuffer) getter must reflect Zig's writes.
//   - pointerSize=4 (seam 5): @opentui/core derives FFI struct pointer width from
//     process.arch (8 on x64); the wasm32 core writes 4-byte pointers, so every
//     pointer-bearing OUT-struct (SpanInfoStruct) must lay out at 4.
//   - live span-feed chunk reads (seam 6): the chunk ring-buffer must be read
//     live at drain time, not snapshotted at ChunkAdded (before Zig writes it).
//
// Needs the @opentui/core source from the opencode build clone (same as
// opentui-bundle-wiring.mjs); SKIPS with a clear message when absent.

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

// ── locate the @opentui/core source dir carrying the FFI chunk ────────────────
const coreDir = openTUICoreDirOrSkip('opentui-cli-renderer-frame');

// ── a synthetic terminal mirroring the facet TTY-shim contract ───────────────
// stdin: setRawMode/resume/pause/on (the StdinParser surface);
// stdout: a CUSTOM stream (≠ process.stdout) so OpenTUI takes the span-feed
//   output path; write(bytes, cb) must invoke cb so the feed can idle.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'opentui-cli-frame-'));
let backend;
let renderer;
try {
  cpSync(coreDir, tmp, { recursive: true });

  // patch every FFI chunk (fail-loud, exactly-once anchors)
  let patchedChunks = 0;
  for (const f of readdirSync(tmp).filter((f) => /^index(-[a-z0-9]+)?\.js$/.test(f))) {
    const p = path.join(tmp, f);
    const src = readFileSync(p, 'utf8');
    if (!src.includes(OPENTUI_FFI_CHUNK_MARKER)) continue;
    const out = nimbusPatchOpenTUI(src, f);
    // seams: loadBackend, loadBackend2, resolveNativePackage, pointerSize,
    // span-feed chunk read, ensureRawBufferViews — all registry-gated.
    assert.ok(out.split('__nimbusOpenTUIBackend').length - 1 >= 6, `expected ≥6 registry seams in ${f}`);
    writeFileSync(p, out);
    patchedChunks++;
  }
  assert.equal(patchedChunks, 1, `expected exactly one @opentui FFI chunk, patched ${patchedChunks}`);

  // ── build the wasm backend over the staged Stage A artifact + real WASI host ──
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
  assert.equal(typeof otui.createCliRenderer, 'function', 'createCliRenderer not exported by the bundle');
  assert.equal(typeof otui.RGBA, 'function', 'RGBA not exported by the bundle');

  const WIDTH = 80;
  const HEIGHT = 24;
  const sink = [];
  const stdin = makeSyntheticStdin();
  const stdout = makeSyntheticStdout(WIDTH, HEIGHT, sink);

  // ── the REAL high-level entry opencode uses (app.tsx createTuiRenderer →
  //    createCliRenderer). injected stdin/stdout = the facet TTY seams; the
  //    custom stdout makes OpenTUI take the span-feed output path. ──
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
  assert.ok(renderer, 'createCliRenderer returned nullish');
  assert.equal(renderer.constructor?.name, 'CliRenderer', `expected CliRenderer, got ${renderer.constructor?.name}`);
  assert.ok(renderer._feed, 'expected the span-feed output path (custom stdout) to be active');
  assert.equal(stdin.isRaw, true, 'renderer setupTerminal did not put stdin into raw mode');
  console.log('  [1] createCliRenderer() built a CliRenderer over the wasm backend (no OOB; span-feed output path; raw mode engaged)');

  // ── attached-TTY editing: the high-level Textarea path OpenCode uses ──────
  // OpenTUI's getters pass bare ArrayBuffers through backend.ptr(), and an
  // empty selection is a u64 all-ones sentinel. Losing copy-back or treating
  // that u64 as signed leaves the cursor at column zero: text appends, but
  // arrows jump to the start and backspace deletes nothing.
  const textarea = new otui.TextareaRenderable(renderer, {
    id: 'cursor-probe',
    width: 60,
    height: 3,
  });
  renderer.root.add(textarea);
  textarea.focus();
  for (const char of 'abcd') {
    stdin.emit('data', Buffer.from(char));
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(textarea.plainText, 'abcd');
  assert.equal(textarea.cursorOffset, 4);
  stdin.emit('data', Buffer.from('\x1b[D'));
  await new Promise((r) => setTimeout(r, 25));
  stdin.emit('data', Buffer.from('\x1b[D'));
  await new Promise((r) => setTimeout(r, 25));
  stdin.emit('data', Buffer.from('X'));
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(textarea.plainText, 'abXcd', 'left-arrow keys did not move the OpenTUI cursor');
  assert.equal(textarea.cursorOffset, 3);
  stdin.emit('data', Buffer.from('\x7f'));
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(textarea.plainText, 'abcd', 'backspace did not delete before the OpenTUI cursor');
  assert.equal(textarea.cursorOffset, 2);
  console.log('  [2] Textarea cursor, arrow keys, and backspace match vanilla OpenTUI');

  // ── draw known content onto the frame buffer and drive frames. loop() runs
  //    the render pipeline → lib.render → the Zig core emits the frame ANSI into
  //    the span feed → feed.onData → our stdout sink. ──
  const MARKER = 'NIMBUS_OPENTUI_FRAME_OK';
  const white = otui.RGBA.fromValues(1, 1, 1, 1);
  for (let i = 0; i < 3; i++) {
    renderer.forceFullRepaintRequested = true;
    renderer.nextRenderBuffer.drawText(MARKER, 5, 3, white);
    await renderer.loop();
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 40));

  const out = sink.join('');

  // ── assert real ANSI escape sequences were emitted ──
  assert.ok(/\x1b\[/.test(out), 'no CSI escape sequences in renderer output');
  console.log(`  [3] renderer emitted ${out.length} bytes through the span-feed → stdout seam — real ANSI present`);

  // ── assert the drawn content reached the frame ──
  assert.ok(out.includes(MARKER), `drawn content "${MARKER}" not found in the rendered frame (${out.length}B)`);
  // and that it sits in a real cell row (printable frame text, not an escape arg)
  const printable = out
    .replace(/\x1b\[[0-9;:?<>=]*[A-Za-z@]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b./g, '');
  assert.ok(printable.includes(MARKER), `"${MARKER}" appeared only inside escape sequences, not as drawn frame content`);
  console.log(`  [4] drawn content "${MARKER}" rendered into the frame grid — the high-level renderer drew through the backend`);

  // ── clean teardown (destroy restores terminal state through the backend) ──
  renderer.destroy();
  renderer = null;
  console.log('  [5] renderer.destroy() completed cleanly (terminal-restore path ran through the backend)');

  console.log("opentui-cli-renderer-frame OK: opencode's real createCliRenderer path renders ANSI frames with content through the Nimbus wasm backend's span feed");
} finally {
  try { renderer?.destroy(); } catch { /* already torn down */ }
  delete globalThis.__nimbusOpenTUIBackend;
  rmSync(tmp, { recursive: true, force: true });
}
