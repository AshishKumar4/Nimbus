#!/usr/bin/env bun
// The staged Oxc wasm was built from this tree: its provenance records a
// digest of every input (scripts/oxc-wasm/inputs.mjs: the crate's sources,
// manifest, lockfile, toolchain pin, the recipe and its compiler wrapper), and
// they must be the tree's. bundle-oxc-wasm.mjs refuses to stage otherwise; this
// says so before a deploy would.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { changedInputs, oxcWasmInputs } from '../../packages/worker/scripts/oxc-wasm/inputs.mjs';
import { OXC_WASM_ASSET_PATH, OXC_WASM_SHA256 } from '../../packages/worker/src/oxc-wasm-artifact.generated.ts';

const staged = (path) => readFile(new URL(`../../packages/worker/public${path}`, import.meta.url), 'utf8');
const provenance = JSON.parse(await staged(OXC_WASM_ASSET_PATH.replace(/\.wasm$/, '.provenance.json')));
assert.equal(provenance.outputs['nimbus-oxc.wasm'].sha256, OXC_WASM_SHA256);

const current = await oxcWasmInputs();
for (const input of ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'build.mjs', 'inputs.mjs', '../napi-wasm/rustc-remap.sh', 'src/lib.rs', 'src/module.rs']) {
  assert.ok(input in current, `${input} is an input`);
}
assert.deepEqual(changedInputs(provenance.source.inputs, current), [],
  'the staged wasm was built from other sources: rebuild it (scripts/oxc-wasm/build.mjs) and stage it (scripts/bundle-oxc-wasm.mjs)');
console.log(`  ok  the staged wasm's ${Object.keys(current).length} recorded inputs are the tree's`);

// One changed byte anywhere is a different build.
const edited = { ...current, 'src/module.rs': '0'.repeat(64) };
assert.deepEqual(changedInputs(provenance.source.inputs, edited), ['src/module.rs']);
const added = { ...current, 'src/new.rs': '0'.repeat(64) };
assert.deepEqual(changedInputs(provenance.source.inputs, added), ['src/new.rs']);
console.log('  ok  an edited or added input reads as a stale build');
console.log('oxc-wasm-inputs OK');
