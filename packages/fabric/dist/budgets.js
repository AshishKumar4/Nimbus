/**
 * budgets.ts — per-DO accounting for the platform budgets the fabric spends:
 * the Durable Object's Dynamic Worker concurrency limit, the facet-ID
 * lifetime budget, and the dynamic-worker module-map ceiling.
 *
 * The Dynamic Worker model is Cloudflare's documented one
 * ({@link DO_DYNAMIC_WORKER_LIMIT}): a Durable Object may have a fixed number
 * of DISTINCT Dynamic Workers with in-flight requests at once, shared across
 * every concurrent request to that object (one I/O context), and any number
 * of in-flight requests to the same Dynamic Worker count as one. Only
 * in-flight requests count: a loader id with nothing in flight holds nothing.
 *
 * The ledger counts, per hosting actor, the distinct workers that are in
 * flight right now, keyed by loader id (a fresh key per unkeyed `load`), plus
 * the width fan-outs have claimed and not yet released. A fan-out spends only
 * the {@link dynamicWorkerHeadroom} that leaves, so work a Durable Object
 * already has in flight — a resident process, the esbuild facet, a git
 * network op, another fan-out — keeps its slots. Work that would rather wait
 * than be refused waits on the ledger ({@link beginLoaderFetchWhenFree}) and
 * is let in, in the order it asked, by whichever release makes room.
 *
 * Keyed weakly off the hosting actor's `ctx`, like the facet slot books: the
 * limit is per Durable Object, and dynamic workers die with the isolate that
 * loaded them, so a ledger that goes away with its host describes nothing
 * that still exists.
 */
import { classifyError } from '@nimbus-sh/platform/oom-classify.js';
import { hostWasmIdentity } from './host-wasm.js';
/**
 * Distinct Dynamic Workers one Durable Object may have with in-flight
 * requests at once, shared across all concurrent requests to that object;
 * multiple in-flight requests to one Dynamic Worker count once.
 * https://developers.cloudflare.com/changelog/post/2026-08-28-durable-objects-dynamic-workers-limit/
 */
export const DO_DYNAMIC_WORKER_LIMIT = 10;
/**
 * The first pause after a limit refusal, doubling while refusals continue,
 * up to {@link REFUSAL_PAUSE_MAX_MS}. A deployed Durable Object admitted a
 * batch it had refused after a 6 s pause.
 */
const REFUSAL_PAUSE_MS = 50;
const REFUSAL_PAUSE_MAX_MS = 2_000;
const ledgers = new WeakMap();
const claimEntries = new WeakMap();
function ledger(ctx) {
    let entry = ledgers.get(ctx);
    if (!entry) {
        entry = {
            inFlight: new Map(), claims: new Set(), peak: 0,
            waiters: [], pauseMs: 0, pauseTimer: undefined, epoch: 0, refusals: 0,
        };
        ledgers.set(ctx, entry);
    }
    return entry;
}
/** Distinct workers counted: each claim's width (or more, if its holds exceed it), plus held keys no claim covers. */
function inUse(entry) {
    let count = 0;
    const covered = new Set();
    for (const claim of entry.claims) {
        count += Math.max(claim.width, claim.keys.size);
        for (const key of claim.keys.keys())
            covered.add(key);
    }
    for (const key of entry.inFlight.keys())
        if (!covered.has(key))
            count++;
    return count;
}
function headroom(entry) {
    return entry.pauseMs > 0 ? 0 : Math.max(0, DO_DYNAMIC_WORKER_LIMIT - inUse(entry));
}
function claimOf(ctx, claim) {
    if (claim === undefined)
        return undefined;
    const owned = claimEntries.get(claim);
    if (owned === undefined || owned.ledger !== ledger(ctx)) {
        throw new Error('Nimbus: a Dynamic Worker claim is used only on the ledger of the actor that claimed it');
    }
    return owned.ledger.claims.has(owned.entry) ? owned.entry : undefined;
}
function count(map, key, by) {
    const open = (map.get(key) ?? 0) + by;
    if (open > 0)
        map.set(key, open);
    else
        map.delete(key);
}
/** Take one hold; the caller admits waiters after. */
function hold(entry, workerKey, claim) {
    count(entry.inFlight, workerKey, 1);
    if (claim)
        count(claim.keys, workerKey, 1);
    entry.peak = Math.max(entry.peak, inUse(entry));
    const epoch = entry.epoch;
    let ended = false;
    return (failure) => {
        if (ended)
            return;
        ended = true;
        count(entry.inFlight, workerKey, -1);
        if (claim)
            count(claim.keys, workerKey, -1);
        if (classifyError(failure) === 'dynamic_worker_cap')
            refused(entry, epoch);
        else if (epoch === entry.epoch && entry.pauseMs === 0)
            entry.refusals = 0;
        admitWaiters(entry);
    };
}
/**
 * The platform refused a worker this ledger counted room for: it still
 * counts workers the ledger has released, which no release here can show.
 * So nothing new is admitted until a pause has passed. A refusal of a call
 * that began before the latest pause started or ended is the same lag and
 * changes nothing; one of a call let in after it doubles the next pause.
 */
function refused(entry, epoch) {
    if (epoch !== entry.epoch)
        return;
    if (entry.pauseTimer !== undefined)
        clearTimeout(entry.pauseTimer);
    entry.pauseMs = Math.min(REFUSAL_PAUSE_MAX_MS, REFUSAL_PAUSE_MS * 2 ** entry.refusals);
    entry.refusals++;
    entry.epoch++;
    entry.pauseTimer = setTimeout(() => {
        entry.pauseMs = 0;
        entry.pauseTimer = undefined;
        entry.epoch++;
        admitWaiters(entry);
    }, entry.pauseMs);
}
function admissible(entry, waiter) {
    // Requests to a worker already in flight count once, even while paused.
    if (entry.inFlight.has(waiter.key))
        return true;
    if (entry.pauseMs > 0)
        return false;
    if (waiter.claim && entry.claims.has(waiter.claim) && waiter.claim.keys.size < waiter.claim.width)
        return true;
    return inUse(entry) < DO_DYNAMIC_WORKER_LIMIT;
}
/**
 * Let in every waiter that fits, in the order they asked: each takes its
 * hold here, so a freed slot goes to exactly one waiter and is never left
 * between a wake and a begin. Run after every change that can make room.
 * A waiter let in on a new key lets in the later ones on that key, and the
 * earlier ones too: the scan starts over.
 */
function admitWaiters(entry) {
    for (let i = 0; i < entry.waiters.length;) {
        const waiter = entry.waiters[i];
        if (!admissible(entry, waiter)) {
            i++;
            continue;
        }
        const joins = entry.inFlight.has(waiter.key);
        entry.waiters.splice(i, 1);
        waiter.admit(hold(entry, waiter.key, waiter.claim));
        if (!joins)
            i = 0;
    }
}
/**
 * Hold the Dynamic Worker `workerKey` in flight on this actor's ledger; the
 * returned function ends the hold (idempotently), from the caller's own
 * `finally`. Holds on one key nest: the worker counts once until the last
 * one ends, as the platform counts it. Under a `claim`, the hold counts
 * inside the claim's width. This never waits: it is for work the actor
 * starts regardless (a resident process); {@link beginLoaderFetchWhenFree}
 * waits for room.
 *
 * A begin/end pair rather than a wrapper on purpose, and the shape is
 * load-bearing: wrapping the stub call in a ledger-owned async frame
 * (`trackLoaderFetch(ctx, () => entrypoint.execute(...))`) left the hosting
 * Durable Object poisoned after every pooled dispatch — the next fabric
 * activity hung the object or reset the instance outright (pid base jumped,
 * every attached WebSocket dropped with no close frame), measured 7/7 on
 * staging and gone 3/3 with the direct call restored. Same seam-quirk class
 * as pipelined `fetch.call`, which workerd refuses for dynamically-loaded
 * workers: an RPC stub call must stay a direct property call awaited by the
 * frame that made it, so the ledger only brackets it.
 */
export function beginLoaderFetch(ctx, workerKey, claim) {
    const entry = ledger(ctx);
    const end = hold(entry, workerKey, claimOf(ctx, claim));
    admitWaiters(entry);
    return end;
}
/**
 * {@link beginLoaderFetch} once the ledger has room: resolves, holding
 * `workerKey`, as soon as that worker is already in flight (holds on it
 * count once) or a distinct worker more fits — within the `claim`'s width,
 * or the actor's headroom. Waits are let in in the order they asked, by
 * whoever's release makes the room: a hold's end, a claim's release, a
 * pause's end. The hold is taken as the wait is let in, so a freed slot
 * wakes one waiter and no other caller can take it first; once resolved, it
 * is the caller's to end.
 *
 * A call refused with "Dynamic worker concurrency limit exceeded" ends its
 * hold with the refusal (`end(error)`) and waits again: the refusal pauses
 * admission (50 ms, doubling to 2 s while refusals continue), because the
 * platform counts a worker for a moment after its call returns and no
 * release can show that.
 *
 * `signal` abandons the wait: it rejects with the signal's reason and holds
 * nothing. A wait outlives nothing on its own: bound it with a signal when
 * room may never come (a resident process holds its worker for as long as
 * it runs).
 *
 *   const end = await beginLoaderFetchWhenFree(ctx, key, { signal });
 *   try { return await worker.getEntrypoint().run(); }
 *   catch (error) { end(error); throw error; }
 *   finally { end(); }
 */
export function beginLoaderFetchWhenFree(ctx, workerKey, options = {}) {
    const { signal } = options;
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        const entry = ledger(ctx);
        const abandon = () => {
            const at = entry.waiters.indexOf(waiter);
            if (at < 0)
                return;
            entry.waiters.splice(at, 1);
            reject(signal?.reason);
        };
        const waiter = {
            key: workerKey,
            claim: claimOf(ctx, options.claim),
            admit(end) {
                signal?.removeEventListener('abort', abandon);
                resolve(end);
            },
        };
        entry.waiters.push(waiter);
        signal?.addEventListener('abort', abandon, { once: true });
        admitWaiters(entry);
    });
}
/**
 * Distinct Dynamic Workers this actor may still put in flight: the limit
 * less what is held and claimed right now, and none while a limit refusal's
 * pause lasts. Never negative.
 */
export function dynamicWorkerHeadroom(ctx) {
    return headroom(ledger(ctx));
}
/**
 * Claim `width` distinct Dynamic Workers for one fan-out, or null when the
 * headroom cannot hold it. The claim counts until `release` (idempotent), so
 * a second fan-out sizing itself meanwhile sees it; the claimant's own
 * dispatches, held under the claim, count inside it.
 */
export function claimDynamicWorkers(ctx, width) {
    const entry = ledger(ctx);
    if (width < 1 || width > headroom(entry))
        return null;
    const claim = { width, keys: new Map() };
    entry.claims.add(claim);
    entry.peak = Math.max(entry.peak, inUse(entry));
    const handle = {
        release() {
            if (!entry.claims.delete(claim))
                return;
            admitWaiters(entry);
        },
    };
    claimEntries.set(handle, { ledger: entry, entry: claim });
    return handle;
}
/** Snapshot for the diag surface. Pure read; no I/O. */
export function loaderLedgerStats(ctx) {
    const entry = ledger(ctx);
    return {
        limit: DO_DYNAMIC_WORKER_LIMIT,
        inFlightWorkers: [...entry.inFlight.keys()],
        claimed: claimedWidth(entry),
        headroom: headroom(entry),
        peak: entry.peak,
        waiting: entry.waiters.length,
        pauseMs: entry.pauseMs,
    };
}
function claimedWidth(entry) {
    let width = 0;
    for (const claim of entry.claims)
        width += claim.width;
    return width;
}
/**
 * Name the per-DO accounting on a "Dynamic worker concurrency limit exceeded"
 * failure; hand every other error back untouched. The platform's message
 * says only that the limit was hit — which workers were in flight, and what
 * fan-outs had claimed, is what the operator needs to know to shrink anything.
 */
export function withDynamicWorkerCapNamed(ctx, error) {
    if (classifyError(error) !== 'dynamic_worker_cap')
        return error;
    const entry = ledger(ctx);
    const platform = error instanceof Error ? error.message : String(error);
    return new Error(`${platform} — this Durable Object had ${entry.inFlight.size} distinct dynamic worker(s) in flight `
        + `(${[...entry.inFlight.keys()].join(', ') || 'none recorded'}) and ${claimedWidth(entry)} claimed by fan-outs, `
        + `against a limit of ${DO_DYNAMIC_WORKER_LIMIT}; peak ${entry.peak}`, { cause: error });
}
// ── Dynamic-worker module-map ceiling ───────────────────────────────────────
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
 * (plain string, `{ js | cjs | py | text }`, `{ wasm | data }`, a bare
 * WebAssembly.Module). With an encoder, text is measured exactly; without
 * one, by code-unit length. A compiled module counts the wire size its host
 * described (host-wasm.ts); one nobody described counts nothing here and is
 * left to the platform's own refusal, as the text undercount is.
 */
function memberBytes(content, encoder) {
    const textBytes = (text) => encoder ? encoder.encode(text).byteLength : text.length;
    if (typeof content === 'string')
        return textBytes(content);
    if (content instanceof WebAssembly.Module)
        return hostWasmIdentity(content)?.bytes ?? 0;
    if (content !== null && typeof content === 'object') {
        for (const value of Object.values(content)) {
            if (typeof value === 'string')
                return textBytes(value);
            if (value instanceof ArrayBuffer)
                return value.byteLength;
            if (ArrayBuffer.isView(value))
                return value.byteLength;
            if (value instanceof WebAssembly.Module)
                return hostWasmIdentity(value)?.bytes ?? 0;
        }
    }
    return 0;
}
// ── Facet-ID lifetime budget ────────────────────────────────────────────────
/**
 * Facet IDs a Durable Object is granted over its LIFETIME. Append-only and
 * never reclaimed, so crossing it is unrecoverable for the object — which is
 * why the ledger below counts consumption durably instead of leaving the
 * bound as prose the slot book merely respects.
 */
export const FACET_ID_LIFETIME_BUDGET = 65_536;
/** Where the ledger persists the count of facet names ever minted. */
export const FACET_NAME_HIGH_WATER_KEY = 'fabric_facet_name_high_water';
const facetNameLedgers = new WeakMap();
function facetNameLedger(ctx) {
    let ledger = facetNameLedgers.get(ctx);
    if (!ledger) {
        const created = { chain: Promise.resolve(0), known: 0, minted: 0 };
        created.chain = Promise.resolve(ctx.storage.get(FACET_NAME_HIGH_WATER_KEY))
            .then((value) => (typeof value === 'number' ? value : 0))
            .catch(() => 0)
            .then((adopted) => {
            created.known = Math.max(created.known, adopted);
            return adopted;
        });
        ledger = created;
        facetNameLedgers.set(ctx, ledger);
    }
    return ledger;
}
/**
 * Advance the durable ledger to this incarnation's name count, if it is a new
 * lifetime high. Chained behind adoption so the comparison is always against
 * the real persisted value; a failed write leaves the old link's count and the
 * next mint tries again — the ledger may transiently undercount, never over.
 */
export function recordFacetNameMinted(ctx, count) {
    const ledger = facetNameLedger(ctx);
    ledger.minted = Math.max(ledger.minted, count);
    ledger.chain = ledger.chain.then(async (durable) => {
        if (count <= durable)
            return durable;
        try {
            await ctx.storage.put(FACET_NAME_HIGH_WATER_KEY, count);
        }
        catch {
            return durable;
        }
        ledger.known = Math.max(ledger.known, count);
        return count;
    });
}
/** The best count available without awaiting storage: minted or adopted. */
export function facetNameCount(ctx) {
    const ledger = facetNameLedger(ctx);
    return Math.max(ledger.known, ledger.minted);
}
/** The count with adoption awaited, for a first failure on a fresh boot. */
export async function facetNameCountDurable(ctx) {
    const ledger = facetNameLedger(ctx);
    const durable = await ledger.chain;
    return Math.max(durable, ledger.minted);
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
    return {
        consumed: await facetNameCountDurable(ctx),
        budget: FACET_ID_LIFETIME_BUDGET,
    };
}
/**
 * Name the facet-ID budget on a creation failure at the wall; below it, hand
 * the error back untouched. Exhaustion is the one failure here the platform
 * reports opaquely AND that no teardown, retry or reset can undo, so the
 * ledger — the only witness to the real cause — does the naming. Not a
 * threshold: the comparison is against the budget itself.
 */
export function withFacetBudgetNamed(consumed, error) {
    if (consumed < FACET_ID_LIFETIME_BUDGET)
        return error;
    const platform = error instanceof Error ? error.message : String(error);
    return new Error(`Nimbus: facet creation failed with this Durable Object's `
        + `${FACET_ID_LIFETIME_BUDGET.toLocaleString('en-US')} facet-ID lifetime budget consumed `
        + `(${consumed} facet names ever created). Facet IDs are append-only and never reclaimed, `
        + `so this failure is permanent for the object: ${platform}`, { cause: error });
}
