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
import { acquireSupervisorAllocation, acquireSupervisorRunningAllocation, tryAcquireSupervisorAllocation, tryAcquireSupervisorRunningAllocation, reclaimableSupervisorAllocation } from '@nimbus-sh/platform/heavy-alloc-coord.js';
import { runningLaunchAdmission, suspendHeldAdmission } from '@nimbus-sh/fabric/budgets.js';
import { prebundleSliceBytes } from '@nimbus-sh/core/runtime/prebundle-slice.js';
import { BuildFacetResetError, buildFacetPrebundler } from './build-facet.js';
class PrebundleCreditUnavailable extends Error {
    bytes;
    constructor(bytes) {
        super(`prebundle needs ${bytes} bytes of supervisor credit`);
        this.bytes = bytes;
    }
}
export class PrebundlePool {
    env;
    ctx;
    /** Pre-bundles waiting for a slot, oldest first; a finishing one hands its slot to the next. */
    waiting = [];
    running = 0;
    constructor(env, ctx) {
        this.env = env;
        this.ctx = ctx;
    }
    get session() { return this.ctx.id.toString(); }
    async acquire(signal) {
        let prebundle = await buildFacetPrebundler(this.ctx, this.env, signal);
        return { prebundle: async (task) => {
                for (let attempt = 0;; attempt++) {
                    try {
                        return await this.dispatch(task, prebundle);
                    }
                    catch (error) {
                        if (!(error instanceof BuildFacetResetError) || attempt > 0)
                            throw error;
                        prebundle = await buildFacetPrebundler(this.ctx, this.env, task.signal);
                    }
                }
            } };
    }
    async dispatch(task, run) {
        const owner = { owner: `prebundle '${task.specifier}'`, ...task.owner,
            session: task.owner?.session ?? this.session, attribution: 'preBundleSliceBytes' };
        let creditFirst = false;
        let resume;
        for (;;) {
            const reclaimed = new AbortController();
            const signal = task.signal ? AbortSignal.any([task.signal, reclaimed.signal]) : reclaimed.signal;
            let lease = null;
            let payload = null;
            let unregister = () => { };
            let slot = false;
            const transferred = () => {
                unregister();
                unregister = () => { };
                payload = null;
                lease?.release();
                lease = null;
            };
            const prepare = () => {
                signal.throwIfAborted();
                if (lease === null) {
                    lease = (task.running || runningLaunchAdmission(this.ctx) ? tryAcquireSupervisorRunningAllocation : tryAcquireSupervisorAllocation)(Math.max(1, task.bytes), owner);
                    if (lease === null)
                        throw new PrebundleCreditUnavailable(task.bytes);
                }
                payload = task.prepare();
                const bytes = Math.max(1, prebundleSliceBytes(payload.slice));
                if (bytes > lease.bytes)
                    throw new Error('prebundle slice exceeded its stat-sized allocation');
                lease.shrinkTo(bytes);
            };
            const leaveSlot = () => {
                if (!slot)
                    return;
                slot = false;
                const next = this.waiting.shift();
                if (next)
                    next.admit();
                else
                    this.running--;
            };
            try {
                if (creditFirst) {
                    resume ??= suspendHeldAdmission(this.ctx);
                    const running = task.running || runningLaunchAdmission(this.ctx);
                    lease = await (running ? acquireSupervisorRunningAllocation : acquireSupervisorAllocation)(Math.max(1, task.bytes), signal, owner);
                    prepare();
                    unregister = reclaimableSupervisorAllocation(() => {
                        transferred();
                        reclaimed.abort(new Error('the parked prebundle slice was reclaimed for running work'));
                    });
                    await resume?.(signal);
                    resume = undefined;
                }
                await this.waitForSlot(signal);
                slot = true;
                return await run({ specifier: task.specifier, signal, transferred, take: () => {
                        signal.throwIfAborted();
                        unregister();
                        unregister = () => { };
                        if (payload === null)
                            prepare();
                        if (payload === null)
                            throw new Error('prebundle prepared no payload');
                        const taken = payload;
                        payload = null;
                        return taken;
                    } });
            }
            catch (error) {
                transferred();
                leaveSlot();
                if (error instanceof PrebundleCreditUnavailable || (reclaimed.signal.aborted && !task.signal?.aborted)) {
                    // One credit-first retry avoids repeated slot/credit bounces; its parked payload is reclaimable.
                    creditFirst = true;
                    continue;
                }
                if (resume !== undefined && !task.signal?.aborted) {
                    await resume(task.signal);
                    resume = undefined;
                }
                throw error;
            }
            finally {
                transferred();
                leaveSlot();
            }
        }
    }
    waitForSlot(signal) {
        signal?.throwIfAborted();
        if (this.running < PRE_BUNDLE_CONCURRENCY) {
            this.running++;
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const waiter = {
                admit: () => { signal?.removeEventListener('abort', waiter.cancel); resolve(); },
                cancel: () => {
                    const index = this.waiting.indexOf(waiter);
                    if (index >= 0)
                        this.waiting.splice(index, 1);
                    reject(signal?.reason);
                },
            };
            this.waiting.push(waiter);
            signal?.addEventListener('abort', waiter.cancel, { once: true });
        });
    }
    /** The build facet is the Durable Object's, not the pool's: nothing to release. */
    dispose() { }
}
