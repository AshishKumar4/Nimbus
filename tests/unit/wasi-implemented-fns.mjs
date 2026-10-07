#!/usr/bin/env bun
// wasi-implemented-fns — the advertised WASI surface is the implemented one.
//
// `wasm-runner --help` and `formatWasmRunnerWasiInfo()` print
// WASI_IMPLEMENTED_FNS to users as "implemented imports". That list is written
// by hand because the shim itself is a source string the Worker cannot eval at
// runtime, so nothing inside the Worker can check it. This does: it builds the
// real imports object out of the preamble and compares.
//
// Under-reporting is a real defect, not a nit - a caller who reads the list
// concludes a syscall is missing and works around a function that is right
// there.

import { WASI_IMPLEMENTED_FNS } from '../../packages/core/src/runtime/wasi-instance.ts';
import { loadWasiPreamble } from './lib/wasi-authority.mjs';

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
};

const memory = new WebAssembly.Memory({ initial: 1 });
// The preamble's top-level `import('cloudflare:sockets')` fails here, and its
// own catch disables socket dialling, which changes nothing about which
// imports exist.
const { __wasiMakeImports } = await loadWasiPreamble();
const { wasiImport } = __wasiMakeImports({ argv: [], env: {}, getMemory: () => memory });
const implemented = Object.keys(wasiImport).sort();
const advertised = [...WASI_IMPLEMENTED_FNS].sort();

const missing = implemented.filter((fn) => !advertised.includes(fn));
const phantom = advertised.filter((fn) => !implemented.includes(fn));

check('every implemented WASI import is advertised', missing.length === 0,
  `implemented but unlisted: ${missing.join(', ')}`);
check('every advertised WASI import is implemented', phantom.length === 0,
  `listed but absent: ${phantom.join(', ')}`);
check('the advertised list has no duplicates',
  new Set(advertised).size === advertised.length,
  `${advertised.length} entries, ${new Set(advertised).size} distinct`);

console.log(`(${implemented.length} imports)`);
process.exit(failures > 0 ? 1 : 0);
