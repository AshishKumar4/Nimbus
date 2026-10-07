#!/usr/bin/env bun
// isolate-pool-wasm-identity — a warm loader slot answers only for the wasm
// bytes it was built from. Two images of one length whose first and last
// bytes agree are still two programs (clang's ./a and ./b differed at one
// offset), so they get two loader ids, whether the pool takes them at
// construction or per call. The same bytes in another ArrayBuffer reuse the
// slot.

import assert from 'node:assert/strict';
import { IsolatePool } from '../../packages/fabric/src/isolate-pool.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';

const ctx = {
  id: { toString: () => 'wasm-identity-test-do' },
  waitUntil() {},
};

/** The loader id one dispatch of `pool` uses. */
async function loaderId(constructorWasm, perCallWasm) {
  const ids = [];
  const env = {
    LOADER: {
      get(id) {
        ids.push(id);
        return { getEntrypoint: () => ({ fetch: async () => new Response('ok') }) };
      },
    },
  };
  const pool = new IsolatePool(env, ctx, {
    network: ISOLATE_NETWORK,
    omitSupervisor: true,
    timeoutMs: 0,
    wasmModules: constructorWasm,
  });
  const response = await pool.submitRequest(
    async () => new Response('ok'),
    new Request('https://facet.internal/run'),
    perCallWasm ? { wasmModules: perCallWasm } : undefined,
  );
  assert.equal(await response.text(), 'ok');
  assert.equal(ids.length, 1);
  return ids[0];
}

/** `length` bytes that start and end with the same values, differing only at `at`. */
function image(length, at, value) {
  const bytes = new Uint8Array(length).fill(7);
  bytes[0] = 0;
  bytes[length - 1] = 11;
  bytes[at] = value;
  return bytes.buffer;
}

const a = image(7572, 651, 1);
const b = image(7572, 651, 2);
const aAgain = image(7572, 651, 1);

// At construction: an interpreter image the host reads from the filesystem.
{
  const idA = await loaderId({ 'interp.wasm': a });
  const idB = await loaderId({ 'interp.wasm': b });
  const idAAgain = await loaderId({ 'interp.wasm': aAgain });
  assert.notEqual(idA, idB, 'two images of one length and the same end bytes are two programs');
  assert.equal(idA, idAAgain, 'the same bytes in another buffer reuse the slot');
}

// Per call: a program the user compiled.
{
  const idA = await loaderId(undefined, { 'user.wasm': a });
  const idB = await loaderId(undefined, { 'user.wasm': b });
  const idAAgain = await loaderId(undefined, { 'user.wasm': aAgain });
  assert.notEqual(idA, idB);
  assert.equal(idA, idAAgain);
}

console.log('isolate-pool-wasm-identity: ok');
