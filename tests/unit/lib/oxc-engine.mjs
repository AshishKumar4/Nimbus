// The transform engine production runs (the transform facet's: Nimbus's Oxc
// build over the staged wasm, core runtime/oxc-transform.ts driving it), for
// tests that drive EsbuildService's transform pipeline in-process. It has
// esbuild's transform() contract, so a test hands it to the service as its
// in-isolate engine:
//
//   new EsbuildService(undefined, { engine: async () => oxcEngine })

import { readFile } from 'node:fs/promises';
import { createOxcTransform } from '../../../packages/core/src/runtime/oxc-transform.ts';
import { stripTypeScript } from '../../../packages/core/src/runtime/typescript-strip.ts';
import { OXC_WASM_ASSET_PATH } from '../../../packages/worker/src/oxc-wasm-artifact.generated.ts';

const bytes = await readFile(new URL(`../../../packages/worker/public${OXC_WASM_ASSET_PATH}`, import.meta.url));
export const oxcEngine = createOxcTransform(await WebAssembly.compile(bytes));
// The type strip the transform facet installs beside its engine (oxc-facet/preamble.ts), here over amaro's own package.
globalThis.__nimbusStripTypeScript ??= stripTypeScript;
