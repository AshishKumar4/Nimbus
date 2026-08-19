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
let esbuildModule = null;
let initPromise = null;
async function ensureInitialized() {
    if (esbuildModule)
        return esbuildModule;
    if (!initPromise) {
        initPromise = (async () => {
            // Use dynamic import from CDN
            // This works in browsers natively
            const mod = await import(/* @vite-ignore */ ESBUILD_ESM_URL);
            await mod.initialize({
                wasmURL: ESBUILD_WASM_URL,
            });
            esbuildModule = mod;
            return mod;
        })();
    }
    return await initPromise;
}
export function createEsbuild() {
    const mod = {
        version: ESBUILD_WASM_VERSION,
        initialize: async (_options) => {
            await ensureInitialized();
        },
        transform: async (code, options) => {
            const esb = await ensureInitialized();
            return esb.transform(code, options);
        },
        transformSync: (_code, _options) => {
            throw new Error('[lifo] esbuild.transformSync() is not available in browser. Use transform() instead.');
        },
        build: async (options) => {
            const esb = await ensureInitialized();
            return esb.build(options);
        },
        buildSync: (_options) => {
            throw new Error('[lifo] esbuild.buildSync() is not available in browser. Use build() instead.');
        },
        formatMessages: async (messages, options) => {
            const esb = await ensureInitialized();
            return esb.formatMessages(messages, options);
        },
        analyzeMetafile: async (metafile, options) => {
            const esb = await ensureInitialized();
            return esb.analyzeMetafile(metafile, options);
        },
        context: async (options) => {
            const esb = await ensureInitialized();
            return esb.context(options);
        },
        stop: () => {
            // No-op in browser
        },
    };
    return mod;
}
