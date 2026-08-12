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
import { EventEmitter } from 'node:events';
import {
  readFileSync,
  writeFileSync,
  rmSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  nimbusPatchOpenTUI,
  OPENTUI_FFI_CHUNK_MARKER,
} from '../../packages/worker/scripts/opencode/bundle-patches.ts';
import { WASI_INSTANCE_PREAMBLE_SRC } from '../../packages/core/src/runtime/wasi-instance.ts';
import { OpenTUIWasmBackend } from '../../packages/core/src/runtime/opentui-wasm-backend.ts';
import { OPENTUI_WASM_ENTRY } from '../../packages/worker/src/opentui-wasm-artifact.generated.ts';

// ── locate the @opentui/core source dir carrying the FFI chunk ────────────────
function findOpenTUICoreDir() {
  if (process.env.NIMBUS_OPENTUI_CORE_DIR) return process.env.NIMBUS_OPENTUI_CORE_DIR;
  for (const root of ['/tmp/opencode-research/opencode', process.env.NIMBUS_OPENCODE_CLONE].filter(Boolean)) {
    if (!existsSync(root)) continue;
    let out = '';
    try {
      out = execSync(
        `find ${root} -path '*@opentui/core/index.js' -not -path '*core-*' 2>/dev/null | head -5`,
      ).toString();
    } catch {
      /* find may exit non-zero; ignore */
    }
    for (const main of out.split('\n').filter(Boolean)) {
      const dir = path.dirname(main);
      if (readdirSync(dir).some((f) => /^index(-[a-z0-9]+)?\.js$/.test(f) &&
        readFileSync(path.join(dir, f), 'utf8').includes(OPENTUI_FFI_CHUNK_MARKER))) {
        return dir;
      }
    }
  }
  return null;
}

const coreDir = findOpenTUICoreDir();
if (!coreDir) {
  console.log('opentui-cli-renderer-frame SKIP: no @opentui/core source found ' +
    '(needs the opencode build clone; set NIMBUS_OPENTUI_CORE_DIR to run)');
  process.exit(0);
}
console.log(`opentui-cli-renderer-frame — @opentui/core source: ${coreDir}`);

// ── a synthetic terminal mirroring the facet TTY-shim contract ───────────────
// stdin: setRawMode/resume/pause/on (the StdinParser surface);
// stdout: a CUSTOM stream (≠ process.stdout) so OpenTUI takes the span-feed
//   output path; write(bytes, cb) must invoke cb so the feed can idle.
function makeSyntheticStdin() {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (mode) => { stdin.isRaw = !!mode; return stdin; };
  stdin.resume = () => stdin;
  stdin.pause = () => stdin;
  stdin.setEncoding = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  stdin.read = () => null;
  return stdin;
}

function makeSyntheticStdout(width, height, sink) {
  const stdout = new EventEmitter();
  stdout.isTTY = true;
  stdout.columns = width;
  stdout.rows = height;
  stdout.write = (chunk, enc, cb) => {
    sink.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('latin1'));
    const done = typeof enc === 'function' ? enc : cb;
    if (typeof done === 'function') done();
    return true;
  };
  stdout.getColorDepth = () => 24;
  stdout.hasColors = () => true;
  return stdout;
}

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
  const prePath = path.join(tmp, '__wasi-preamble.mjs');
  writeFileSync(prePath, `${WASI_INSTANCE_PREAMBLE_SRC}\nexport { __wasiInitFS, __wasiMakeImports };`);
  const { __wasiInitFS, __wasiMakeImports } = await import(pathToFileURL(prePath).href);
  const workerPublic = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../../packages/worker/public',
  );
  const module = new WebAssembly.Module(readFileSync(workerPublic + OPENTUI_WASM_ENTRY));
  backend = OpenTUIWasmBackend.create({
    module,
    wasi: { makeImports: __wasiMakeImports, initFS: __wasiInitFS },
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
  console.log(`  [2] renderer emitted ${out.length} bytes through the span-feed → stdout seam — real ANSI present`);

  // ── assert the drawn content reached the frame ──
  assert.ok(out.includes(MARKER), `drawn content "${MARKER}" not found in the rendered frame (${out.length}B)`);
  // and that it sits in a real cell row (printable frame text, not an escape arg)
  const printable = out
    .replace(/\x1b\[[0-9;:?<>=]*[A-Za-z@]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b./g, '');
  assert.ok(printable.includes(MARKER), `"${MARKER}" appeared only inside escape sequences, not as drawn frame content`);
  console.log(`  [3] drawn content "${MARKER}" rendered into the frame grid — the high-level renderer drew through the backend`);

  // ── clean teardown (destroy restores terminal state through the backend) ──
  renderer.destroy();
  renderer = null;
  console.log('  [4] renderer.destroy() completed cleanly (terminal-restore path ran through the backend)');

  console.log("opentui-cli-renderer-frame OK: opencode's real createCliRenderer path renders ANSI frames with content through the Nimbus wasm backend's span feed");
} finally {
  try { renderer?.destroy(); } catch { /* already torn down */ }
  delete globalThis.__nimbusOpenTUIBackend;
  rmSync(tmp, { recursive: true, force: true });
}
