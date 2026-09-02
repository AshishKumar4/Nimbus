import { CF_COMPAT_DATE } from '@nimbus-sh/core/constants.js';
import {
  BUNDLER_VERSION,
  generateEsbuildTransformRuntimeSource,
  type EsbuildTransformOptions,
  type TransformResult,
} from '@nimbus-sh/core/runtime/esbuild-service.js';
import { ESBUILD_NAME_GLOBAL_SHIM } from '@nimbus-sh/core/_shared/esbuild-facet-shim.js';
import type { DurableObject } from 'cloudflare:workers';
import type { WorkerCode } from '@nimbus-sh/fabric/vendor/types.js';
import {
  ESBUILD_WASM_JS_FN_BODY,
  ESBUILD_WASM_VERSION,
} from '../esbuild-wasm-bundle.generated.js';

export const ESBUILD_TRANSFORM_WORKER_ID =
  `nimbus-esbuild-transform:${ESBUILD_WASM_VERSION}:${BUNDLER_VERSION}`;

export type EsbuildTransformFacetRpc = DurableObject & {
  transform(code: string, options: EsbuildTransformOptions): Promise<TransformResult>;
};

/** Slim Worker Loader module whose DO class owns the esbuild wasm heap. */
export function esbuildTransformWorkerCode(wasmBytes: ArrayBuffer): WorkerCode {
  const source = [
    'import { DurableObject } from "cloudflare:workers";',
    'import wasmModule from "esbuild.wasm";',
    `const esbuild = new Function(${JSON.stringify(ESBUILD_WASM_JS_FN_BODY)})();`,
    ESBUILD_NAME_GLOBAL_SHIM,
    generateEsbuildTransformRuntimeSource(),
    'let initialized;',
    'function ensureInitialized() {',
    '  initialized ||= esbuild.initialize({ wasmModule, worker: false });',
    '  return initialized;',
    '}',
    'export class EsbuildTransformFacet extends DurableObject {',
    '  async transform(code, options) {',
    '    await ensureInitialized();',
    '    return transformWithEsbuild(esbuild, code, options);',
    '  }',
    '}',
  ].join('\n');

  return {
    compatibilityDate: CF_COMPAT_DATE,
    compatibilityFlags: ['nodejs_compat'],
    mainModule: 'worker.js',
    modules: {
      'worker.js': source,
      'esbuild.wasm': { wasm: wasmBytes },
    },
    globalOutbound: null,
  };
}
