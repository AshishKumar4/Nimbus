// The transform engine production runs (the transform facet's: Nimbus's Oxc
// build over the staged wasm, core runtime/oxc-transform.ts driving it), for
// tests that drive EsbuildService's transform pipeline in-process. It has
// esbuild's transform() contract, so a test sets it as the service's engine:
//
//   service.ensureInit = async () => {};
//   service._esbuild = oxcEngine;

import { readFile } from 'node:fs/promises';
import { createOxcTransform } from '../../../packages/core/src/runtime/oxc-transform.ts';
import { OXC_WASM_ASSET_PATH } from '../../../packages/worker/src/oxc-wasm-artifact.generated.ts';

const bytes = await readFile(new URL(`../../../packages/worker/public${OXC_WASM_ASSET_PATH}`, import.meta.url));
export const oxcEngine = createOxcTransform(await WebAssembly.compile(bytes));
