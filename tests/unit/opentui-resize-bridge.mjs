#!/usr/bin/env bun
// Regression test for the attached-TTY resize reflow.
//
// The bug: a terminal resize reached the facet intact (WS frame →
// ProcessInputStore → cpReadStdin → node-shims updated __nimbusTtyColumns/Rows
// and emitted SIGWINCH) and the opencode TUI never reflowed. OpenTUI's
// CliRenderer registers its own SIGWINCH handler only when its stdout IS
// process.stdout (`_usesProcessStdout`) — and bundle seam 7 deliberately hands
// it a DISTINCT stdout so the NativeSpanFeed gets allocated, which is the only
// way ANSI frames surface on the wasm build. So nothing was listening, and
// `[rung3] frame reflow on resize` timed out while keystrokes kept working.
//
// The fix is the runner's SIGWINCH → renderer.resize() bridge
// (OPENTUI_RESIZE_BRIDGE_SRC). This test covers both halves:
//   1. the bridge behaves — it resizes every live renderer with the geometry
//      the shim recorded, resolving the registry at SIGWINCH time (the renderer
//      mounts long after the bridge installs);
//   2. the staged bundle still has the shape the bridge depends on — upstream's
//      `_usesProcessStdout` SIGWINCH gate (why the bridge is needed) and the
//      public singleton registry + resize() API (how it reaches the renderer).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OPENTUI_RESIZE_BRIDGE_SRC,
  OPENTUI_RENDERER_TRACKER,
  OPENTUI_SINGLETON_SYMBOL,
} from '../../packages/worker/src/runtime/opencode-facet-runner.ts';
import { OPENCODE_ATTACH_BUNDLE_FILE } from '../../packages/worker/src/runtime/opencode-artifact.ts';
import {
  OPENCODE_ARTIFACT_PRESENT,
  OPENCODE_ARTIFACT_VERSION,
} from '../../packages/worker/src/opencode-artifact.generated.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SINGLETON_KEY = Symbol.for(OPENTUI_SINGLETON_SYMBOL);

/**
 * Install the bridge over a fake facet scope. Returns the SIGWINCH emitter, the
 * stderr sink, and a setter for the shim's live terminal geometry — the bridge
 * closes over the same bindings the shim mutates before it emits SIGWINCH.
 */
function installBridge({ columns = 80, rows = 24 } = {}) {
  const events = new EventEmitter();
  const stderr = [];
  const proc = {
    on: (name, listener) => { events.on(name, listener); return proc; },
    stderr: { write: (s) => { stderr.push(s); return true; } },
  };
  const setSize = new Function(
    'process',
    '__nimbusTtyColumns',
    '__nimbusTtyRows',
    `${OPENTUI_RESIZE_BRIDGE_SRC}\n` +
      'return (cols, rows) => { __nimbusTtyColumns = cols; __nimbusTtyRows = rows; };',
  )(proc, columns, rows);
  return { sigwinch: () => events.emit('SIGWINCH'), setSize, stderr };
}

function fakeRenderer() {
  return { calls: [], resize(columns, rows) { this.calls.push([columns, rows]); } };
}

function withTracker(renderers, fn) {
  const previous = globalThis[SINGLETON_KEY];
  globalThis[SINGLETON_KEY] = {
    [OPENTUI_RENDERER_TRACKER]: { renderers: new Set(renderers) },
  };
  try {
    return fn();
  } finally {
    if (previous === undefined) delete globalThis[SINGLETON_KEY];
    else globalThis[SINGLETON_KEY] = previous;
  }
}

// ── 1. a resize reflows the live renderer at the shim's new geometry ─────────
{
  const bridge = installBridge();
  const renderer = fakeRenderer();
  withTracker([renderer], () => {
    bridge.setSize(120, 40);
    bridge.sigwinch();
  });
  assert.deepEqual(renderer.calls, [[120, 40]],
    'SIGWINCH must resize the live renderer with the shim terminal geometry');
  assert.deepEqual(bridge.stderr, [], 'a clean resize writes nothing to stderr');
}

// ── 2. the registry is resolved at SIGWINCH time, not at install time ────────
// The bridge installs at module init; @opentui/core's registry and the renderer
// only exist once the TUI mounts, and a resize can arrive on either side of that.
{
  const bridge = installBridge();
  assert.doesNotThrow(() => bridge.sigwinch(),
    'a resize before the TUI mounts must be a no-op, not a throw');

  const renderer = fakeRenderer();
  withTracker([renderer], () => {
    bridge.setSize(100, 30);
    bridge.sigwinch();
  });
  assert.deepEqual(renderer.calls, [[100, 30]],
    'a renderer registered after install must still receive the resize');
}

// ── 3. every live renderer resizes; one failure never strands the others ─────
{
  const bridge = installBridge();
  const failing = {
    calls: [],
    resize() { this.calls.push('called'); throw new Error('renderer is wedged'); },
  };
  const healthy = fakeRenderer();
  withTracker([failing, healthy], () => {
    bridge.setSize(160, 50);
    bridge.sigwinch();
  });
  assert.deepEqual(healthy.calls, [[160, 50]],
    'a throwing renderer must not strand the remaining renderers');
  assert.equal(bridge.stderr.length, 1, 'the failure is reported, not swallowed');
  assert.match(bridge.stderr[0], /OpenTUI resize failed/);
  assert.match(bridge.stderr[0], /renderer is wedged/);
}

// ── 4. the staged bundle still has the shape the bridge depends on ───────────
const bundlePath = path.join(
  REPO,
  'packages/worker/public/_assets/opencode',
  OPENCODE_ARTIFACT_VERSION,
  OPENCODE_ATTACH_BUNDLE_FILE,
);
if (!OPENCODE_ARTIFACT_PRESENT || !existsSync(bundlePath)) {
  console.log(`SKIP staged attach bundle absent (${bundlePath})`);
} else {
  const bundle = readFileSync(bundlePath, 'utf8');

  // Why the bridge exists: upstream registers SIGWINCH only for a
  // process.stdout renderer, and seam 7 hands ours a distinct stdout.
  assert.ok(
    bundle.includes('this._usesProcessStdout&&process.on("SIGWINCH",this.sigwinchHandler)'),
    'CliRenderer no longer gates its SIGWINCH handler on _usesProcessStdout — ' +
      're-derive whether the Nimbus resize bridge is still required',
  );
  assert.ok(
    bundle.includes('this._usesProcessStdout=r===process.stdout'),
    '_usesProcessStdout is no longer "stdout === process.stdout" — re-derive the seam',
  );

  // How the bridge reaches the renderer: the public singleton registry, the
  // tracker's renderer set, and CliRenderer's public resize(width, height).
  assert.ok(
    bundle.includes(`Symbol.for("${OPENTUI_SINGLETON_SYMBOL}")`),
    'the @opentui/core singleton registry key changed — the resize bridge cannot find renderers',
  );
  assert.ok(
    bundle.includes(`X5("${OPENTUI_RENDERER_TRACKER}"`) ||
      bundle.includes(`("${OPENTUI_RENDERER_TRACKER}",`),
    `the "${OPENTUI_RENDERER_TRACKER}" registry entry changed — the resize bridge cannot find renderers`,
  );
  assert.ok(
    bundle.includes('renderers:new Set,streamOwners:new WeakMap'),
    'the RendererTracker shape changed — the resize bridge iterates tracker.renderers',
  );
  assert.ok(
    bundle.includes('resize(t,r){this._isDestroyed||this.processResize(t,r)}'),
    'CliRenderer.resize(width, height) changed — the resize bridge calls it',
  );
}

console.log('opentui-resize-bridge: OK');
