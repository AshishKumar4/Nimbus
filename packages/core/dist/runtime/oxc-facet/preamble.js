/**
 * oxc-facet/preamble.ts — what the transform facet runs besides the Oxc wasm.
 *
 * scripts/bundle-facet-workers.mjs bundles this file as an IIFE and stages it
 * as a static asset (public/_assets/runtime/oxc-facet-<buildId>.js in
 * @nimbus-sh/worker); the facet's builder fetches it, verified, and puts it in
 * front of the facet's class. It installs:
 *
 *   globalThis.__nimbusCreateOxcTransform   oxc-transform.ts, the wasm's driver
 *   globalThis.__nimbusTransformRuntime     what a transform request runs
 *                                           besides its engine (esbuild-service.ts
 *                                           TransformRuntime)
 *
 * The runtime parses with Acorn, which is why this is a bundle rather than
 * serialized functions. Keep this analysis out of the session's isolate.
 */
import { createOxcTransform } from '../oxc-transform.js';
import { rewriteDynamicImports } from '../dynamic-import-rewrite.js';
import { lowerAsyncModule, lowerEsModule } from '../async-module-lowering.js';
import { rewriteProvidedCommonJsModules } from '../provided-packages.js';
import { stripTypeScript } from '../typescript-strip.js';
const runtime = { rewriteDynamicImports, lowerAsyncModule, lowerEsModule, rewriteProvidedCommonJsModules, stripTypeScript };
Object.assign(globalThis, {
    __nimbusCreateOxcTransform: createOxcTransform,
    __nimbusTransformRuntime: runtime,
});
