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
import { buildFacetPrebundler, loadBuildFacet } from './build-facet.js';
export class PrebundlePool {
    env;
    ctx;
    pool;
    /** Pre-bundles waiting for a slot, oldest first; a finishing one hands its slot to the next. */
    waiting = [];
    running = 0;
    constructor(env, ctx) {
        this.env = env;
        this.ctx = ctx;
        const prebundle = buildFacetPrebundler(ctx, env);
        this.pool = {
            prebundle: async (spec) => {
                if (this.running < PRE_BUNDLE_CONCURRENCY)
                    this.running++;
                else
                    await new Promise((resolve) => this.waiting.push(resolve));
                try {
                    return await prebundle(spec);
                }
                finally {
                    const next = this.waiting.shift();
                    if (next)
                        next();
                    else
                        this.running--;
                }
            },
        };
    }
    async acquire() {
        await loadBuildFacet(this.ctx, this.env);
        return this.pool;
    }
    /** The build facet is the Durable Object's, not the pool's: nothing to release. */
    dispose() { }
}
