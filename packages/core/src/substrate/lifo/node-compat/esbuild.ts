/**
 * esbuild shim that uses esbuild-wasm loaded from CDN.
 *
 * When code inside Lifo does `require('esbuild')`, this shim is returned
 * instead of the native esbuild package (which can't run in the browser).
 *
 * The WASM binary is lazy-loaded on first transform/build call.
 */

const ESBUILD_WASM_VERSION = '0.24.2';
const ESBUILD_WASM_URL = `https://unpkg.com/esbuild-wasm@${ESBUILD_WASM_VERSION}/esbuild.wasm`;
const ESBUILD_ESM_URL = `https://unpkg.com/esbuild-wasm@${ESBUILD_WASM_VERSION}/esm/browser.min.js`;

/** The esbuild-wasm surface this shim forwards to. */
interface EsbuildWasm {
  initialize(options: { wasmURL: string }): Promise<void>;
  transform(code: string, options?: unknown): Promise<unknown>;
  build(options?: unknown): Promise<unknown>;
  formatMessages(messages: unknown, options?: unknown): Promise<unknown>;
  analyzeMetafile(metafile: unknown, options?: unknown): Promise<unknown>;
  context(options?: unknown): Promise<unknown>;
}

let esbuildModule: EsbuildWasm | null = null;
let initPromise: Promise<EsbuildWasm> | null = null;

async function ensureInitialized(): Promise<EsbuildWasm> {
  if (esbuildModule) return esbuildModule;

  if (!initPromise) {
    initPromise = (async () => {
      // Use dynamic import from CDN
      // This works in browsers natively
      const mod: EsbuildWasm = await import(/* @vite-ignore */ ESBUILD_ESM_URL);
      await mod.initialize({
        wasmURL: ESBUILD_WASM_URL,
      });
      esbuildModule = mod;
      return mod;
    })();
  }

  return await initPromise;
}

export function createEsbuild(): Record<string, unknown> {
  const mod: Record<string, unknown> = {
    version: ESBUILD_WASM_VERSION,

    initialize: async (_options?: unknown): Promise<void> => {
      await ensureInitialized();
    },

    transform: async (code: string, options?: unknown): Promise<unknown> => {
      const esb = await ensureInitialized();
      return esb.transform(code, options);
    },

    transformSync: (_code: string, _options?: unknown): never => {
      throw new Error('[lifo] esbuild.transformSync() is not available in browser. Use transform() instead.');
    },

    build: async (options?: unknown): Promise<unknown> => {
      const esb = await ensureInitialized();
      return esb.build(options);
    },

    buildSync: (_options?: unknown): never => {
      throw new Error('[lifo] esbuild.buildSync() is not available in browser. Use build() instead.');
    },

    formatMessages: async (messages: unknown, options?: unknown): Promise<unknown> => {
      const esb = await ensureInitialized();
      return esb.formatMessages(messages, options);
    },

    analyzeMetafile: async (metafile: unknown, options?: unknown): Promise<unknown> => {
      const esb = await ensureInitialized();
      return esb.analyzeMetafile(metafile, options);
    },

    context: async (options?: unknown): Promise<unknown> => {
      const esb = await ensureInitialized();
      return esb.context(options);
    },

    stop: (): void => {
      // No-op in browser
    },
  };

  return mod;
}
