#!/usr/bin/env bun

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { BUN_SHIM_PREAMBLE } from '../../packages/worker/src/runtime/bun-runner.ts';

const context = vm.createContext({
  require: () => ({}),
  console,
  URL,
  TextEncoder,
  Uint8Array,
  ArrayBuffer,
  Blob,
  Response,
  crypto,
  performance,
  setTimeout,
});

vm.runInContext(BUN_SHIM_PREAMBLE, context);
assert.throws(
  () => vm.runInContext('Bun.serve({ port: 3000, fetch() {} })', context),
  /Bun\.serve: not implemented on Cloudflare Workers; use node:http or a Worker fetch handler/,
);
assert.equal(vm.runInContext("'__nimbus_bun_serve' in globalThis", context), false);

console.log('bun-serve-honesty: ok');
