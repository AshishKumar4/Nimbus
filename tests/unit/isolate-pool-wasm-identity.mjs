#!/usr/bin/env bun
import { facetTaskSource } from '../../packages/core/src/runtime/facet-task.ts';
// isolate-pool-wasm-identity — a warm loader slot answers only for the wasm
// image it was built from, and an image is read only when a worker is built
// from it. Two files of one length whose first and last bytes agree are
// still two programs (clang's ./a and ./b differed at one offset), so they
// get two loader ids, whether the pool takes them at construction or per
// call. The same image reuses the slot, and a warm slot is answered without
// the image being read.

import assert from 'node:assert/strict';
import { IsolatePool } from '../../packages/fabric/src/isolate-pool.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { sha256Hex } from '../../packages/core/src/_shared/crypto.ts';

const ctx = {
  id: { toString: () => 'wasm-identity-test-do' },
  waitUntil() {},
};

const harness = createSqliteVfsTestHarness();
const engine = new SqliteVFS(harness.sql, harness.ctx);
const view = new ProcessFiles(engine).view({ pid: 10, cred: CRED_KERNEL });

/** A loader that builds a worker the first time it sees an id, and answers warm after: the ids asked for, and the code of each it built. */
const loader = { ids: [], built: new Map() };
const env = {
  LOADER: {
    get(id, load) {
      loader.ids.push(id);
      return {
        getEntrypoint: () => ({
          async fetch() {
            if (!loader.built.has(id)) loader.built.set(id, await load());
            return new Response('ok');
          },
        }),
      };
    },
  },
};

/** The loader id one dispatch uses, and how many reads of its images it made. */
async function dispatch(constructorWasm, perCallWasm) {
  let reads = 0;
  const counted = (images) => images && Object.fromEntries(Object.entries(images).map(([name, image]) => [name, { ...image, read: () => { reads++; return image.read(); } }]));
  const pool = new IsolatePool(env, ctx, { network: ISOLATE_NETWORK, omitSupervisor: true, timeoutMs: 0, wasmModules: counted(constructorWasm) });
  const response = await pool.submitRequest(
    facetTaskSource("async () => new Response('ok')"),
    new Request('https://facet.internal/run'),
    perCallWasm ? { wasmModules: counted(perCallWasm) } : undefined,
  );
  assert.equal(await response.text(), 'ok');
  return { id: loader.ids.at(-1), reads };
}

/** `length` bytes that start and end with the same values, differing only at `at`. */
function program(length, at, value) {
  const bytes = new Uint8Array(length).fill(7);
  bytes[0] = 0;
  bytes[length - 1] = 11;
  bytes[at] = value;
  return bytes;
}

const a = program(7572, 651, 1);
const b = program(7572, 651, 2);
await view.writeFile('/a.wasm', a);
await view.writeFile('/b.wasm', b);
const digests = { '/a.wasm': { sha256: await sha256Hex(a), size: a.length }, '/b.wasm': { sha256: await sha256Hex(b), size: b.length } };
const image = (path) => view.image(path, digests[path]);

for (const [where, open] of [
  ['at construction', (image) => [{ 'interp.wasm': image }, undefined]],
  ['per call', (image) => [undefined, { 'user.wasm': image }]],
]) {
  const first = await dispatch(...open(await image('/a.wasm')));
  assert.equal(first.reads, 1, `${where}: a worker built from an image reads it once`);
  const name = where === 'per call' ? 'user.wasm' : 'interp.wasm';
  assert.deepEqual(new Uint8Array(loader.built.get(first.id).modules[name].wasm), a, `${where}: the worker carries the file's bytes`);
  const other = await dispatch(...open(await image('/b.wasm')));
  assert.notEqual(first.id, other.id, `${where}: two files of one length and the same end bytes are two programs`);
  const again = await dispatch(...open(await image('/a.wasm')));
  assert.equal(again.id, first.id, `${where}: the same file unchanged reuses the slot`);
  assert.equal(again.reads, 0, `${where}: a warm slot answers without the image being read`);
}

console.log('isolate-pool-wasm-identity: ok');
