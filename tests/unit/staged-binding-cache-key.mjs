#!/usr/bin/env bun
// A binding rebuilt at the same version keeps its asset path. Its colo-cache
// key must still change: the old key was the loader's build id, so a warm
// colo answered the new binding with the old bytes and the digest check
// refused them as a poisoned cache.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fetchStagedBindingAsset } from '../../packages/worker/src/runtime/staged-bindings.ts';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const path = '/_assets/napi-wasm/rolldown/1.2.11/rolldown.wasm';
const oldBytes = new Uint8Array([0, 97, 115, 109, 1]);
const newBytes = new Uint8Array([0, 97, 115, 109, 2]);

// One colo cache for both deploys: what the first deploy cached is there.
const rows = new Map();
globalThis.caches = {
  default: {
    async match(request) { const body = rows.get(request.url); return body ? new Response(body.slice()) : undefined; },
    async put(request, response) { rows.set(request.url, new Uint8Array(await response.arrayBuffer())); },
    async delete(request) { return rows.delete(request.url); },
  },
};
const deploy = (bytes) => ({ ASSETS: { async fetch() { return new Response(bytes.slice()); } } });

const first = await fetchStagedBindingAsset(deploy(oldBytes), { path, sha256: sha256(oldBytes), bytes: oldBytes.length });
assert.deepEqual(new Uint8Array(first), oldBytes);
const rebuilt = await fetchStagedBindingAsset(deploy(newBytes), { path, sha256: sha256(newBytes), bytes: newBytes.length });
assert.deepEqual(new Uint8Array(rebuilt), newBytes, 'the rebuilt binding is served, not refused against the old cache entry');
const again = await fetchStagedBindingAsset({ ASSETS: { async fetch() { throw new Error('served from the colo cache'); } } },
  { path, sha256: sha256(newBytes), bytes: newBytes.length });
assert.deepEqual(new Uint8Array(again), newBytes, 'and cached under its own key');
delete globalThis.caches;
console.log('staged-binding-cache-key: ok');
