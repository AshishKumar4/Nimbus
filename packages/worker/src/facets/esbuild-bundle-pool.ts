/**
 * EsbuildBundlePool — the session's single esbuild facet pool.
 *
 * Install-time pre-bundling and on-demand /@modules/ bundling dispatch the
 * same worker (the pre-bundle preamble + esbuild.wasm, one slot). One pool,
 * owned by the session, warms one loader slot for as long as the installer
 * and dev server live, and is disposed with them.
 *
 * The wasm is the host Worker's own compiled esbuild module
 * (runtime/host-wasm.ts), shared with the facet. The pool keeps no copy of
 * the bytes, so it holds no supervisor allocation credit: it used to fetch
 * and retain the ~12 MiB wasm for its whole life, leased from the shared
 * supervisor budget as a resident owner.
 *
 * Construction is lazy and everything heavy is imported on first use so
 * the fabric/preamble subgraph stays out of the cold script-eval graph of
 * sessions that never bundle.
 */
import type { IsolatePool } from '@nimbus-sh/fabric/isolate-pool.js';
import { PRE_BUNDLE_CONCURRENCY } from '@nimbus-sh/platform/limits.js';
import type { EsbuildWasmFetchEnv } from '../runtime/esbuild-wasm-bytes.js';

/** The pool surface both bundling pipelines dispatch through. */
export type BundlePool = Pick<IsolatePool, 'submit'>;

/** What a bundling pipeline receives from its host. */
export interface BundlePoolProvider {
  /** The session's pool, constructed on first call. */
  acquire(): Promise<BundlePool>;
}

function hasAssetsFetcher(env: unknown): env is EsbuildWasmFetchEnv {
  if (typeof env !== 'object' || env === null) return false;
  const assets = Reflect.get(env, 'ASSETS');
  return typeof assets === 'object' && assets !== null && typeof Reflect.get(assets, 'fetch') === 'function';
}

export class EsbuildBundlePool implements BundlePoolProvider {
  private pool: IsolatePool | null = null;
  private pending: Promise<IsolatePool> | null = null;
  /** Bumped by dispose() so a construction it interrupted tears itself down. */
  private generation = 0;

  constructor(
    private readonly env: unknown,
    private readonly ctx: DurableObjectState,
  ) {}

  acquire(): Promise<IsolatePool> {
    if (this.pool) return Promise.resolve(this.pool);
    if (this.pending) return this.pending;
    const generation = this.generation;
    const pending = this.construct().then((pool) => {
      if (this.generation !== generation) {
        // dispose() ran while the adapter was in flight.
        try { pool.dispose(); } catch { /* best-effort */ }
        throw new Error('EsbuildBundlePool: disposed during construction');
      }
      this.pool = pool;
      return pool;
    }).finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }

  private async construct(): Promise<IsolatePool> {
    if (!hasAssetsFetcher(this.env)) {
      throw new Error('EsbuildBundlePool: env.ASSETS binding missing — the esbuild JS adapter cannot be fetched');
    }
    const env = this.env;
    const [{ IsolatePool }, { preBundlePreamble }, { fetchEsbuildJsFnBody }, { esbuildWasmModule }] = await Promise.all([
      import('@nimbus-sh/fabric/isolate-pool.js'),
      import('../loaders/pre-bundle-preamble.js'),
      import('../runtime/esbuild-wasm-bytes.js'),
      import('../runtime/host-wasm.js'),
    ]);
    const [wasmModule, jsFnBody] = await Promise.all([esbuildWasmModule(), fetchEsbuildJsFnBody(env)]);
    return new IsolatePool(env, this.ctx, {
      concurrency: PRE_BUNDLE_CONCURRENCY,
      timeoutMs: 60_000,
      retries: 0,
      tag: 'esbuild-bundle',
      preamble: preBundlePreamble(jsFnBody),
      wasmModules: { 'esbuild.wasm': wasmModule },
    });
  }

  /**
   * Tear the pool down with its host. A later acquire() constructs a fresh
   * pool, so a session that installs again after a teardown still bundles.
   */
  dispose(): void {
    this.generation++;
    const pool = this.pool;
    this.pool = null;
    this.pending = null;
    if (pool) {
      try { pool.dispose(); } catch { /* best-effort */ }
    }
  }
}
