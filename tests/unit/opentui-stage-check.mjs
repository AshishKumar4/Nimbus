#!/usr/bin/env bun
// The staged OpenTUI wasm against this tree's recipe (packages/worker/
// scripts/opentui/stage.mjs, every bundle's check): the committed stage
// passes and its loader is the committed one; a patch changed without a
// rebuild, a pin changed without one, and a wasm that is not its manifest's
// are refused, each named. Run on a scratch copy of the stage and patches.

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPENTUI_PATCHES, opentuiAssetDir, stageOpentui } from '../../packages/worker/scripts/opentui/stage.mjs';

const worker = new URL('../../packages/worker/', import.meta.url).pathname;

/** A scratch worker root holding the committed stage and patches, `change(root)` applied; what stageOpentui made of it. */
async function check(change = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'opentui-stage-'));
  try {
    cpSync(opentuiAssetDir(worker), opentuiAssetDir(root), { recursive: true });
    mkdirSync(join(root, 'scripts', 'opentui'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    for (const patch of OPENTUI_PATCHES) cpSync(join(worker, 'scripts', 'opentui', patch), join(root, 'scripts', 'opentui', patch));
    change(root);
    const error = await stageOpentui(root).then(() => null, (e) => e);
    let loader = null;
    try { loader = readFileSync(join(root, 'src', 'opentui-wasm-artifact.generated.ts'), 'utf8'); } catch { /* not written */ }
    return { error, loader };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const committed = await check();
assert.equal(committed.error, null);
assert.equal(committed.loader, readFileSync(join(worker, 'src', 'opentui-wasm-artifact.generated.ts'), 'utf8'), 'the loader is the committed one');

// The audit's case: zero-initializing nimbusAlloc in the patch, and no rebuild.
const patched = await check((root) => {
  const file = join(root, 'scripts', 'opentui', 'nimbus-wasm-ffi-abi.patch');
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n`);
});
assert.match(patched.error?.message ?? '', /other inputs than this tree's:\n {2}nimbus-wasm-ffi-abi\.patch/);
assert.equal(patched.loader, null, 'no loader for a stage the tree does not describe');

const pinned = await check((root) => {
  const file = join(opentuiAssetDir(root), 'manifest.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), zigVersion: '0.15.1' }));
});
assert.match(pinned.error?.message ?? '', /zigVersion "0\.15\.1", recipe "0\.15\.2"/);

const swapped = await check((root) => {
  const file = join(opentuiAssetDir(root), 'opentui.wasm');
  writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from([0])]));
});
assert.match(swapped.error?.message ?? '', /opentui\.wasm has sha256 [0-9a-f]{64}, its manifest names/);

console.log('opentui-stage-check: the committed stage passes; a patch, a pin or the wasm changed without a rebuild is refused');
