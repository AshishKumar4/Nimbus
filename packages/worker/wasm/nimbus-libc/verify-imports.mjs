#!/usr/bin/env node
// Every runtime build reads the committed core contract; no copy of the
// allowed namespace list can drift from the host the runtime is built for.
import { readFileSync } from 'node:fs';
import { WASI_RUNTIME_IMPORT_MODULES } from '../../../core/dist/runtime/os-contracts.js';

if (process.argv.length < 3) {
  console.error('usage: verify-imports.mjs <runtime.wasm> [runtime.wasm ...]');
  process.exit(64);
}
for (const file of process.argv.slice(2)) {
  const module = new WebAssembly.Module(readFileSync(file));
  const namespaces = [...new Set(WebAssembly.Module.imports(module).map((entry) => entry.module))].sort();
  const unknown = namespaces.filter((name) => !WASI_RUNTIME_IMPORT_MODULES.includes(name));
  if (unknown.length || !namespaces.includes('nimbus_fs')) {
    console.error(`${file}: imports ${namespaces.join(',')}; `
      + (unknown.length ? `outside WASI_RUNTIME_IMPORT_MODULES: ${unknown.join(',')}` : 'missing nimbus_fs'));
    process.exitCode = 1;
  } else {
    console.log(`${file}: import namespaces ${namespaces.join(',')}`);
  }
}
