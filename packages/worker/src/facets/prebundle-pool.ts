/**
 * PrebundlePool — where a session's pre-bundles run.
 *
 * Install-time pre-bundling (npm/installer.ts) and the Vite dev server's
 * on-demand /@modules/ bundles send each npm specifier, with the slice of
 * package files it needs (npm/pre-bundle-facet.ts), to the session's build
 * facet (facets/build-facet.ts `prebundle`): rolldown over the staged
 * binding, whose runtime the facet's module map loads, so no pre-bundle
 * dispatches any source. One at a time (PRE_BUNDLE_CONCURRENCY), as the
 * isolate pool that ran esbuild did: each holds up to a slice cap of files,
 * and the facet's binding never gives back what a bundle grew it to.
 *
 * `acquire()` loads the facet before resolving, so its staged parts are
 * fetched, verified and handed to the loader before a caller builds and
 * holds a slice.
 */
import { PRE_BUNDLE_CONCURRENCY } from '@nimbus-sh/platform/limits.js';
import type { PrebundleResult, PrebundleSpec } from '../npm/pre-bundle-facet.js';
import { buildFacetPrebundler, loadBuildFacet } from './build-facet.js';

/** What both pre-bundling pipelines call. */
export interface BundlePool {
  prebundle(spec: PrebundleSpec): Promise<PrebundleResult>;
}

/** What a pre-bundling pipeline receives from its host. */
export interface BundlePoolProvider {
  /** The session's pool, its facet loaded. */
  acquire(): Promise<BundlePool>;
}

export class PrebundlePool implements BundlePoolProvider {
  private readonly pool: BundlePool;
  /** Pre-bundles waiting for a slot, oldest first; a finishing one hands its slot to the next. */
  private readonly waiting: Array<() => void> = [];
  private running = 0;

  constructor(
    private readonly env: unknown,
    private readonly ctx: DurableObjectState,
  ) {
    const prebundle = buildFacetPrebundler(ctx, env);
    this.pool = {
      prebundle: async (spec) => {
        if (this.running < PRE_BUNDLE_CONCURRENCY) this.running++;
        else await new Promise<void>((resolve) => this.waiting.push(resolve));
        try {
          return await prebundle(spec);
        } finally {
          const next = this.waiting.shift();
          if (next) next();
          else this.running--;
        }
      },
    };
  }

  async acquire(): Promise<BundlePool> {
    await loadBuildFacet(this.ctx, this.env);
    return this.pool;
  }

  /** The build facet is the Durable Object's, not the pool's: nothing to release. */
  dispose(): void {}
}
