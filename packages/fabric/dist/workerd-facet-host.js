/**
 * workerd-facet-host.ts — how a resident process is actually made, on workerd.
 *
 * `process-fabric.ts` says what a resident process IS, in terms no
 * runtime owns: a boot spec, a start contract, a handle that can be routed to
 * and released. This module is the one implementation of that on Cloudflare,
 * and everything here is a workerd mechanism rather than a Nimbus concept —
 * `ctx.facets`, the Worker Loader, `ctx.exports`, and the facet-index
 * arithmetic the slot book exists to satisfy.
 *
 * The split is what lets the contract be read without the platform: a host
 * that is not a Durable Object implements `ProcessHost` against the same
 * `HostedProcess` and never imports this file.
 */
import { disposeRpcResource } from '@nimbus-sh/core/_shared/rpc-dispose.js';
import { getCtxExports, supervisorEntrypoint, supervisorEntrypointName, } from './ctx-exports.js';
import { beginLoaderFetch, recordLoaderId, withDynamicWorkerCapNamed, } from './loader-ledger.js';
import { RESIDENT_PROCESS_CLASS, requireStagedBootAssembler, residentLoaderConfig, } from './process-fabric.js';
export function getNimbusCtxExports() {
    const ctxExports = getCtxExports();
    if (!ctxExports || typeof ctxExports !== 'object') {
        throw new Error('Nimbus: ctx.exports unavailable');
    }
    return ctxExports;
}
/**
 * Mint a NimbusLoadedEntrypoint stub for a keyed dynamic worker. Used by the
 * one-shot runtime paths, which run a program to completion inside a single
 * request rather than leaving it resident: their module map is assembled in
 * that stateless entrypoint's own isolate, never in a session DO.
 */
export async function createLoadedWorkerEntrypoint(ctxExports, supervisor, stage, name = null) {
    if (!ctxExports.NimbusLoadedEntrypoint) {
        throw new Error('Nimbus: ctx.exports.NimbusLoadedEntrypoint unavailable');
    }
    return await ctxExports.NimbusLoadedEntrypoint({
        props: {
            key: `nimbus-process:${supervisor.doId}:${supervisor.pid}`,
            name,
            depth: 0,
            supervisor,
            stage,
        },
    });
}
/**
 * Total bytes a dynamic Worker's module map may carry, across every member of
 * it. A hard platform limit, not a policy knob: 62 MiB lands and 64 MiB is
 * refused with "Dynamic Worker code size (N bytes) exceeds the maximum allowed
 * size of 67108864 bytes", confirmed at five sizes with two trials each. The
 * budget is shared, so a ruby process is already 34.3 MiB down before its disk
 * is counted.
 */
export const DYNAMIC_WORKER_CODE_LIMIT_BYTES = 67_108_864;
/**
 * Refuse a module map over {@link DYNAMIC_WORKER_CODE_LIMIT_BYTES}, naming
 * the largest members. The platform's own refusal reports one number for a
 * budget shared across every member of the map, which tells the operator
 * nothing about WHAT to shrink — so every fabric seam that assembles a map
 * runs this before the loader sees it.
 *
 * Costed to its two paths. Under the ceiling: one length read per member —
 * UTF-16 code units for text, which equal UTF-8 bytes for the ASCII module
 * text the generators emit and undercount otherwise; the platform's own
 * refusal still backstops the exotic case, because this check exists to name
 * members, not to be the ceiling. Over it: exact UTF-8 sizes, computed only
 * then, sorted so the biggest lever is first.
 */
export function assertModuleMapWithinCodeLimit(modules) {
    let estimate = 0;
    for (const content of Object.values(modules)) {
        estimate += memberBytes(content, null);
    }
    if (estimate <= DYNAMIC_WORKER_CODE_LIMIT_BYTES)
        return;
    const encoder = new TextEncoder();
    const sized = Object.entries(modules)
        .map(([name, content]) => ({ name, bytes: memberBytes(content, encoder) }))
        .sort((a, b) => b.bytes - a.bytes);
    const total = sized.reduce((sum, member) => sum + member.bytes, 0);
    const top = sized.slice(0, 5)
        .map(({ name, bytes }) => `'${name}' (${bytes.toLocaleString('en-US')} bytes)`)
        .join(', ');
    throw new Error(`Nimbus: dynamic-worker module map is ${total.toLocaleString('en-US')} bytes, over the `
        + `${DYNAMIC_WORKER_CODE_LIMIT_BYTES.toLocaleString('en-US')}-byte platform ceiling shared by `
        + `every member. Largest members: ${top}`);
}
/**
 * Bytes one module-map member carries, across the loader's content kinds
 * (plain string, `{ js | cjs | py | text }`, `{ wasm | data }`). With an
 * encoder, text is measured exactly; without one, by code-unit length.
 */
function memberBytes(content, encoder) {
    const textBytes = (text) => encoder ? encoder.encode(text).byteLength : text.length;
    if (typeof content === 'string')
        return textBytes(content);
    if (content !== null && typeof content === 'object') {
        for (const value of Object.values(content)) {
            if (typeof value === 'string')
                return textBytes(value);
            if (value instanceof ArrayBuffer)
                return value.byteLength;
            if (ArrayBuffer.isView(value))
                return value.byteLength;
        }
    }
    return 0;
}
function facetContainer(ctx) {
    const facets = ctx.facets;
    if (!facets || typeof facets.get !== 'function') {
        throw new Error('Nimbus: ctx.facets is unavailable in this Durable Object; '
            + 'resident processes cannot be hosted');
    }
    return facets;
}
/**
 * Fork one facet's entire SQLite into another by copy-on-write — the one way
 * the fabric calls `ctx.facets.clone`, because the raw call carries a hazard
 * measured on production workerd: ANY `src` that does not resolve to a
 * populated facet — a typo, a name not created yet, not merely the obvious
 * `''`/`'.'`/`'/'` — silently EMPTIES the destination and reports success. A
 * blocklist of bad names would pass a typo straight through and wipe a
 * process's filesystem while returning ok, so validation is positive on both
 * ends: the source must answer as populated before the clone runs, the
 * destination must answer as populated after it, and anything else fails
 * loud.
 *
 * `populated` is the caller's probe because populated-ness is the caller's
 * schema. The hosting actor cannot read a facet's SQLite from outside it, and
 * an EMPTIED facet still reports a 4,096-byte database — one page, the empty
 * file — so only a check that positively finds the caller's own data means
 * anything. The post-clone probe is not redundant with the pre-clone one: the
 * probe answers off the caller's accounting, and the capture races un-awaited
 * writes to the source, so the destination is verified rather than inferred.
 *
 * The primitive itself, measured: a reflink, 18–31 ms for a 45.73 MB corpus
 * and 34–54 ms for 1 GB — flat, because nothing is copied — with the data
 * visible from the destination's constructor. Same-Durable-Object only.
 * Quiesce and await writes to the source first; the destination name consumes
 * a facet ID on first use like any other facet name; and the shared ~10 GiB
 * storage budget grants no copy-on-write credit — crossing it resets the
 * object rather than raising an error.
 */
export async function cloneFacetStorage(ctx, clone) {
    const facets = facetContainer(ctx);
    if (typeof facets.clone !== 'function') {
        throw new Error('Nimbus: ctx.facets.clone is unavailable in this runtime; the reflink image '
            + 'path needs deployed Cloudflare workerd (local workerd <= 1.20260603.1 lacks it)');
    }
    const { src, dst } = clone;
    if (!(await clone.populated(src))) {
        throw new Error(`Nimbus: refusing to clone facet '${src}' into '${dst}': the source does not `
            + 'answer as populated, and cloning an unresolvable source silently EMPTIES '
            + 'the destination while reporting success');
    }
    facets.clone(src, dst);
    if (!(await clone.populated(dst))) {
        throw new Error(`Nimbus: clone of facet '${src}' left the destination '${dst}' without the `
            + "source's data; the destination must not be booted from");
    }
}
/**
 * The facet name for a slot. Reused, and that is the entire point.
 *
 * A Durable Object admits 65,536 facets over its LIFETIME: the IDs are
 * append-only and are never reclaimed, so the bound is on facets ever CREATED,
 * not facets alive at once. Naming a facet after its pid, when pids never
 * repeat, therefore burned one of those IDs on every spawn — a long-lived
 * session would eventually exhaust its facet index with no way back, and the
 * failure is unrecoverable rather than merely slow.
 *
 * Reusing a NAME costs no new ID. So the name comes from a free list and the
 * pid stays what it always was: the process identity in the ProcessTable. The
 * two were only ever conflated because one of them happened to be handy.
 */
export function residentFacetName(slot) {
    return `proc-slot-${slot}`;
}
/**
 * Facet IDs a Durable Object is granted over its LIFETIME. Append-only and
 * never reclaimed, so crossing it is unrecoverable for the object — which is
 * why the ledger below counts consumption durably instead of leaving the
 * bound as prose the slot book merely respects.
 */
export const FACET_ID_LIFETIME_BUDGET = 65_536;
/** Where the ledger persists the count of facet names ever minted. */
export const FACET_NAME_HIGH_WATER_KEY = 'fabric_facet_name_high_water';
/**
 * Slot books, per hosting actor, because the facet index is per Durable
 * Object.
 *
 * Keyed weakly off `ctx`, and that is sound rather than lossy: a facet cannot
 * outlive the Durable Object hosting it, so a book that goes away with its
 * host describes nothing that still exists. A fresh incarnation restarts at
 * slot 0 and re-attaches to the SQLite a previous incarnation left there —
 * which is safe for the reason the store is sealed until it has reconciled.
 * Its persisted cursor is either datable against the current authority, in
 * which case the ACQUIRE delta brings it current, or it carries a different
 * VFS epoch, in which case `invalidatedSince` can only answer poison and the
 * whole store is dropped. A process therefore cannot boot onto a previous
 * tenant's filesystem even when release never ran.
 */
const slotBooks = new WeakMap();
function slotBook(ctx) {
    let book = slotBooks.get(ctx);
    if (!book) {
        const created = {
            free: [],
            next: 0,
            held: new Map(),
            ledger: Promise.resolve(0),
            ledgerKnown: 0,
        };
        created.ledger = Promise.resolve(ctx.storage.get(FACET_NAME_HIGH_WATER_KEY))
            .then((value) => (typeof value === 'number' ? value : 0))
            .catch(() => 0)
            .then((adopted) => {
            created.ledgerKnown = Math.max(created.ledgerKnown, adopted);
            return adopted;
        });
        book = created;
        slotBooks.set(ctx, book);
    }
    return book;
}
/**
 * The lifetime facet-ID ledger: how many facet names this fabric has ever
 * minted on the Durable Object, against the 65,536 the platform will ever
 * grant it. `consumed` only ever counts FIRST uses — a reused name, in this
 * incarnation or any earlier one, cost no new ID, which is the slot book's
 * whole reason to exist. Surfaced so an operator can see proximity to a wall
 * whose crossing is unrecoverable, instead of discovering it from the
 * platform's opaque failure.
 */
export async function facetIdBudget(ctx) {
    const book = slotBook(ctx);
    const durable = await book.ledger;
    return {
        consumed: Math.max(durable, book.next),
        budget: FACET_ID_LIFETIME_BUDGET,
    };
}
/** Take a slot for `pid`, reusing a returned one before minting a new name. */
function acquireSlot(ctx, pid) {
    const book = slotBook(ctx);
    const existing = book.held.get(pid);
    if (existing !== undefined)
        return existing;
    const reused = book.free.length > 0;
    const slot = reused ? book.free.shift() : book.next++;
    book.held.set(pid, slot);
    if (!reused)
        recordNameMinted(ctx, book);
    return slot;
}
/**
 * Advance the durable ledger to this incarnation's name count, if it is a new
 * lifetime high. Chained behind adoption so the comparison is always against
 * the real persisted value; a failed write leaves the old link's count and the
 * next mint tries again — the ledger may transiently undercount, never over.
 */
function recordNameMinted(ctx, book) {
    const count = book.next;
    book.ledger = book.ledger.then(async (durable) => {
        if (count <= durable)
            return durable;
        try {
            await ctx.storage.put(FACET_NAME_HIGH_WATER_KEY, count);
        }
        catch {
            return durable;
        }
        book.ledgerKnown = Math.max(book.ledgerKnown, count);
        return count;
    });
}
/**
 * Name the facet-ID budget on a creation failure at the wall; below it, hand
 * the error back untouched. Exhaustion is the one failure here the platform
 * reports opaquely AND that no teardown, retry or reset can undo, so the
 * ledger — the only witness to the real cause — does the naming. Not a
 * threshold: the comparison is against the budget itself.
 */
function withFacetBudgetNamed(consumed, error) {
    if (consumed < FACET_ID_LIFETIME_BUDGET)
        return error;
    const platform = error instanceof Error ? error.message : String(error);
    return new Error(`Nimbus: facet creation failed with this Durable Object's `
        + `${FACET_ID_LIFETIME_BUDGET.toLocaleString('en-US')} facet-ID lifetime budget consumed `
        + `(${consumed} facet names ever created). Facet IDs are append-only and never reclaimed, `
        + `so this failure is permanent for the object: ${platform}`, { cause: error });
}
/** Return `pid`'s slot to the free list. */
function releaseSlot(ctx, pid) {
    const book = slotBook(ctx);
    const slot = book.held.get(pid);
    if (slot === undefined)
        return;
    book.held.delete(pid);
    book.free.push(slot);
    book.free.sort((a, b) => a - b);
}
/**
 * Open a resident process as a facet of the actor whose `ctx` and `env` are
 * given, and start its runner.
 *
 * This is the ONE way a resident process comes into existence, and every
 * substrate goes through it: the facet host calls it with the coordinator's
 * own `ctx`, the peer host calls it — over one RPC — with a sibling session
 * DO's. Everything a substrate could plausibly want to special-case is a
 * PARAMETER here rather than a branch: which actor hosts the child, and how
 * the boot spec's by-path members are read.
 */
export function openResidentFacet(ctx, env, disk, supervisor, params) {
    const facets = facetContainer(ctx);
    const book = slotBook(ctx);
    const slot = acquireSlot(ctx, params.pid);
    const name = residentFacetName(slot);
    // The start callback is the ONLY way this facet is ever created, and it
    // fires AT MOST ONCE. Every later use goes through the stub below, so the
    // callback running a second time means the facet was released or died —
    // and re-running it would evaluate the user's program again, answering a
    // request from a process they never started while the one they did start
    // is gone. Both cases are reported instead.
    let evaluated = false;
    let released = false;
    const start = async () => {
        if (released) {
            throw new Error(`Nimbus: resident process ${params.pid} is no longer running`);
        }
        if (evaluated) {
            throw new Error(`Nimbus: resident process ${params.pid} is no longer loaded (its facet was lost); `
                + 'it is not restarted');
        }
        evaluated = true;
        return { class: residentProcessClass(ctx, env, disk, supervisor, params) };
    };
    let facet;
    try {
        facet = facets.get(name, start);
    }
    catch (error) {
        releaseSlot(ctx, params.pid);
        throw withFacetBudgetNamed(Math.max(book.ledgerKnown, book.next), error);
    }
    let disposed = false;
    const release = async () => {
        if (disposed)
            return;
        disposed = true;
        released = true;
        try {
            facets.abort(name, new Error('Nimbus: resident process released'));
        }
        catch { /* already gone */ }
        try {
            facets.delete(name);
        }
        catch { /* already gone */ }
        // Only after the facet is gone. A slot handed out while its previous
        // tenant were still being torn down would have two processes on one name.
        releaseSlot(ctx, params.pid);
    };
    let started;
    try {
        started = facet.startProcess(params.startArgs);
    }
    catch (error) {
        void release();
        throw withFacetBudgetNamed(Math.max(book.ledgerKnown, book.next), error);
    }
    // The rejection that carries the platform's failure at ID exhaustion is
    // this one, and it is annotated AFTER awaiting the ledger — the first
    // failure of a fresh incarnation must compare against the persisted count,
    // not the zero its adoption read has not yet replaced.
    started = started.catch(async (error) => {
        const durable = await book.ledger;
        throw withFacetBudgetNamed(Math.max(durable, book.next), error);
    });
    // A caller reads whichever of `started` and the lifecycle it needs, so keep
    // the runtime from reporting the other as an unhandled rejection.
    started.catch(() => { });
    return {
        started,
        // A facet cannot die without taking its Durable Object — and this object —
        // with it, so there is no independent death to report.
        lost: new Promise(() => { }),
        handleHttpRequest: (request) => facet.handleHttpRequest(request),
        handleWebSocketRequest: (request) => facet.fetch(request),
        release,
        slot,
    };
}
/**
 * The dynamic worker's Durable Object class, minted in the caller's request
 * context. `LOADER.get` runs its callback only on a cache miss, so a process
 * assembles its module map at most once and the bytes never stay resident in
 * the hosting DO's heap.
 */
function residentProcessClass(ctx, env, disk, supervisor, params) {
    const loader = env.LOADER;
    if (!loader || typeof loader.get !== 'function') {
        throw new Error('Nimbus: env.LOADER binding missing or invalid. Resident processes require '
            + 'the Worker Loader binding; add it via worker_loaders in wrangler.jsonc.');
    }
    try {
        const worker = loader
            .get(params.workerKey, () => residentWorkerConfig(env, disk, supervisor, params.boot))
            .getDurableObjectClass(RESIDENT_PROCESS_CLASS);
        recordLoaderId(ctx, params.workerKey);
        return worker;
    }
    catch (error) {
        throw withDynamicWorkerCapNamed(ctx, error);
    }
}
/**
 * Run one program to completion as an UNKEYED dynamic worker.
 *
 * Unkeyed is the whole difference from `openResidentFacet`: nothing can
 * re-resolve this worker into a later request's context, so it can never be a
 * routeable target and never has to be released by name. It exists for the
 * duration of one call and its stubs are dropped as that call unwinds.
 *
 * Shared by both substrates on purpose. `peer` places processes that have a
 * residency to place; a one-shot has none, and shipping its fully-inline map
 * across a sibling hop would meet the 32 MiB RPC ceiling that by-path boot
 * specs exist to avoid — for a run that gains nothing by moving.
 */
export async function runOneShotWorker(ctx, env, supervisor, params, consume) {
    const loader = env.LOADER;
    if (!loader || typeof loader.load !== 'function') {
        throw new Error('Nimbus: env.LOADER binding missing or invalid. Running a program requires '
            + 'the Worker Loader binding; add it via worker_loaders in wrangler.jsonc.');
    }
    const supervisorRpc = supervisorEntrypoint();
    let supervisorBinding;
    let worker;
    let entrypoint;
    try {
        // Built before the capability is minted: nothing can write as this writer
        // until there is a program to do the writing, and a map that fails to
        // assemble should not have granted append authority on its way out.
        let spec = await params.code();
        assertModuleMapWithinCodeLimit(spec.modules);
        if (supervisorRpc) {
            params.onWriterActivated(params.writerId);
            supervisorBinding = supervisorRpc({ props: supervisor });
        }
        worker = loader.load({
            compatibilityDate: spec.compatibilityDate,
            compatibilityFlags: spec.compatibilityFlags,
            mainModule: spec.mainModule,
            modules: spec.modules,
            ...(supervisorBinding ? { env: { SUPERVISOR: supervisorBinding } } : {}),
        });
        // The loader has taken the map; holding it here would keep a second full
        // copy of the program alive for as long as the program runs.
        spec = undefined;
        entrypoint = worker.getEntrypoint();
        // Narrowed by the runtime check; kept as a property call on the stub —
        // extracting the method builds a pipelined `fetch.call` path workerd
        // refuses for dynamically-loaded workers.
        const ep = entrypoint;
        if (typeof ep.fetch !== 'function') {
            throw new Error('Nimbus: one-shot runtime entrypoint has no fetch method');
        }
        params.onLoaded?.();
        // The unkeyed worker is a live dynamic worker for exactly this call, so
        // the run is a Loader fetch on the hosting actor's ledger — bracketed,
        // never wrapped: see beginLoaderFetch for the measured DO-poisoning
        // hazard, and the pipelined-`fetch.call` note above for its sibling.
        const endFetch = beginLoaderFetch(ctx);
        let response;
        try {
            response = await ep.fetch(params.request);
        }
        finally {
            endFetch();
        }
        try {
            return await consume(response);
        }
        finally {
            disposeRpcResource(response);
        }
    }
    catch (error) {
        throw withDynamicWorkerCapNamed(ctx, error);
    }
    finally {
        disposeRpcResource(entrypoint);
        disposeRpcResource(worker);
        disposeRpcResource(supervisorBinding);
    }
}
async function residentWorkerConfig(env, disk, supervisor, boot) {
    const config = boot.kind === 'staged'
        ? await requireStagedBootAssembler()(env, boot.stage)
        : await residentLoaderConfig(boot.code, disk());
    assertModuleMapWithinCodeLimit(config.modules ?? {});
    const supervisorRpc = supervisorEntrypoint();
    if (!supervisorRpc) {
        throw new Error(`Nimbus: ctx.exports.${supervisorEntrypointName() ?? '<supervisor entrypoint>'} unavailable`);
    }
    return { ...config, env: { SUPERVISOR: supervisorRpc({ props: supervisor }) } };
}
