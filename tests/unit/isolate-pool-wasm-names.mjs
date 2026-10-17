#!/usr/bin/env bun
// isolate-pool-wasm-names — a wasm module's name reaches the worker the
// pool builds as it was given. The worker imports each module by its name
// and binds it under an identifier made from that name; a name holding a
// quote or a backslash is still one module, imported from the member the
// module map ships it as. Two names whose identifiers agree are refused, at
// construction or per call, rather than binding one import twice.

import assert from 'node:assert/strict';
import { IsolatePool } from '../../packages/fabric/src/isolate-pool.ts';
import { BindingError } from '../../packages/fabric/src/vendor/errors.ts';
import { facetTaskSource } from '../../packages/core/src/runtime/facet-task.ts';
import { parseJavaScriptModule } from '../../packages/core/src/runtime/javascript-ast.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { heldImage } from './lib/held-image.mjs';

const ctx = {
  id: { toString: () => 'wasm-names-test-do' },
  waitUntil() {},
};

/** The smallest valid module: the magic number and version 1. */
const image = () => heldImage(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));

function pool(constructorWasm, built) {
  const env = {
    LOADER: {
      get(_id, load) {
        return {
          getEntrypoint: () => ({
            async fetch() {
              built.push(await load());
              return new Response('ok');
            },
          }),
        };
      },
    },
  };
  return new IsolatePool(env, ctx, {
    network: ISOLATE_NETWORK,
    omitSupervisor: true,
    timeoutMs: 0,
    wasmModules: constructorWasm,
  });
}

/** The WorkerCode one dispatch of a pool hands its loader. */
async function workerCode(constructorWasm, perCallWasm) {
  const built = [];
  const response = await pool(constructorWasm, built).submitRequest(
    facetTaskSource("async () => new Response('ok')"),
    new Request('https://facet.internal/run'),
    perCallWasm ? { wasmModules: perCallWasm } : undefined,
  );
  assert.equal(await response.text(), 'ok');
  assert.equal(built.length, 1);
  return built[0];
}

/** Each static import of the worker's main module: its specifier and its binding. */
function imports(code) {
  const program = parseJavaScriptModule(code.modules[code.mainModule]);
  return program.body
    .filter((node) => node.type === 'ImportDeclaration')
    .map((node) => ({ specifier: node.source.value, binding: node.specifiers[0]?.local.name }));
}

// ── names with a quote or a backslash, at construction and per call ─────────
{
  const names = ["it's.wasm", 'a\\b.wasm'];
  const perCall = ["per'call.wasm", 'c\\d.wasm'];
  const code = await workerCode(
    Object.fromEntries(names.map((name) => [name, image()])),
    Object.fromEntries(perCall.map((name) => [name, image()])),
  );
  let parsed;
  assert.doesNotThrow(() => { parsed = imports(code); }, 'the worker the pool builds is one valid module');
  const wasmImports = parsed.filter(({ specifier }) => specifier !== 'cloudflare:workers');
  assert.deepEqual(
    wasmImports.map(({ specifier }) => specifier),
    [...names, ...perCall].map((name) => `./${name}`),
    'each module is imported by its own name, in order',
  );
  for (const name of [...names, ...perCall]) {
    assert.ok(code.modules[name]?.wasm instanceof ArrayBuffer, `the module map ships ${JSON.stringify(name)}`);
  }
  assert.equal(new Set(wasmImports.map(({ binding }) => binding)).size, wasmImports.length, 'each import binds its own name');
  console.log('  ✓ a name with a quote or a backslash is imported from its own member');
}

// ── two names that make one identifier are refused ───────────────────────────
{
  assert.throws(
    () => pool({ 'esbuild.wasm': image(), esbuild_wasm: image() }, []),
    (error) => error instanceof BindingError && error.message.includes('esbuild_wasm'),
    'at construction',
  );
  await assert.rejects(
    workerCode({ 'esbuild.wasm': image() }, { esbuild_wasm: image() }),
    (error) => error instanceof BindingError && error.message.includes('esbuild_wasm'),
    'a per-call name cannot take a constructor-time one\'s identifier',
  );
  await assert.rejects(
    workerCode(undefined, { 'user.wasm': image(), user_wasm: image() }),
    (error) => error instanceof BindingError && error.message.includes('user_wasm'),
    'nor another per-call name\'s',
  );
  console.log('  ✓ names whose identifiers agree are refused');
}

console.log('isolate-pool wasm names: ok');
