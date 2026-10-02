/**
 * oxc-facet/preamble.ts — what the transform facet runs besides the Oxc wasm.
 *
 * scripts/bundle-facet-workers.mjs bundles this file as an IIFE and stages it
 * as a static asset (public/_assets/runtime/oxc-facet-<buildId>.js in
 * @nimbus-sh/worker); the facet's builder fetches it, verified, and puts it in
 * front of the facet's class. It installs the three things a transform request
 * needs (esbuild-service.ts's runTransformRequest takes them as arguments):
 *
 *   globalThis.__nimbusCreateOxcTransform   oxc-transform.ts, the wasm's driver
 *   globalThis.__nimbusRewriteDynamicImports  dynamic-import-rewrite.ts
 *   globalThis.__nimbusLowerAsyncModule     async-module-lowering.ts
 *
 * The last two parse with Acorn, which is why this is a bundle rather than
 * serialized functions. Keep this analysis out of the session's isolate.
 */
import { createOxcTransform } from '../oxc-transform.js';
import { rewriteDynamicImports } from '../dynamic-import-rewrite.js';
import { lowerAsyncModule } from '../async-module-lowering.js';

Object.assign(globalThis, {
  __nimbusCreateOxcTransform: createOxcTransform,
  __nimbusRewriteDynamicImports: rewriteDynamicImports,
  __nimbusLowerAsyncModule: lowerAsyncModule,
});
