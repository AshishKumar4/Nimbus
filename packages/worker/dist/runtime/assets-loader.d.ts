/**
 * runtime/assets-loader.ts — Lazy fetch of large static blobs from the
 * ASSETS binding.
 *
 * Background: the Worker bundle ships ~9.8 MB of generated TypeScript
 * blobs (cirrus-npm-cjs, cirrus-plugin-react, real-vite-bundle, ...).
 * Inlining them at module-load doubles cold-start parse time and
 * inflates deploy uploads. The ASSETS binding lets us serve them as
 * static files (cached at the edge), fetched on first use, kept in a
 * per-isolate cache for subsequent calls.
 *
 * Same pattern as `esbuild-wasm-bytes.ts` (proven in production —
 * see esbuild-wasm-bundle.generated.ts header for history). We
 * generalize it here so future asset promotions are one-line.
 *
 * @example a bundle script writes the big string to
 * `public/_assets/cirrus-plugin-react.bundle.js` and emits a thin
 * `.generated.ts` that re-exports {@link loadAssetText} bound to that
 * path:
 *
 * ```ts
 * // src/cirrus-plugin-react.generated.ts (post-promotion)
 * import { loadAssetText } from './runtime/assets-loader.js';
 * export const CIRRUS_PLUGIN_REACT_VERSION = "4.3.4";
 * export const CIRRUS_PLUGIN_REACT_BUNDLE_PATH = '/_assets/cirrus-plugin-react.bundle.js';
 * export async function getCirrusPluginReactBundle(env: { ASSETS: Fetcher }): Promise<string> {
 *   return loadAssetText(env.ASSETS, CIRRUS_PLUGIN_REACT_BUNDLE_PATH);
 * }
 * ```
 *
 * Cache discipline: keyed by `${path}` (no env or origin in the key)
 * because ASSETS is content-addressed at the deploy level — a redeploy
 * generates new asset bundles and the new isolate sees no stale cache.
 * Within a single isolate's lifetime, the same path always returns the
 * same content.
 */
/**
 * Asset fetch error. Thrown when ASSETS binding is missing or returns
 * a non-200.
 */
export declare class NimbusAssetLoadError extends Error {
    readonly code: 'E_ASSETS_BINDING_MISSING' | 'E_ASSET_NOT_FOUND' | 'E_ASSET_FETCH_FAILED';
    readonly status?: number;
    readonly path: string;
    constructor(message: string, code: NimbusAssetLoadError['code'], path: string, status?: number);
}
/** Minimal fetcher shape so callers don't need to import a Cloudflare type. */
export interface AssetsFetcher {
    fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}
/**
 * Load an asset's bytes by path. Subsequent calls in the same isolate
 * return from cache.
 *
 * @param assets `env.ASSETS` binding.
 * @param path Asset path (e.g. `/_assets/foo.bin`). Leading `/`
 *             required.
 * @throws {NimbusAssetLoadError} on binding missing or non-2xx.
 */
export declare function loadAssetBytes(assets: AssetsFetcher | undefined, path: string): Promise<Uint8Array>;
/**
 * Load an asset as a UTF-8 string. Same caching discipline as
 * {@link loadAssetBytes}.
 */
export declare function loadAssetText(assets: AssetsFetcher | undefined, path: string): Promise<string>;
/**
 * Test-only: drop the per-isolate cache. Real isolates never call this;
 * the cache exists for the isolate's lifetime.
 */
export declare function _resetAssetsCacheForTests(): void;
//# sourceMappingURL=assets-loader.d.ts.map