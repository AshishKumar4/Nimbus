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
 * is let in, in the order it asked, by whichever release makes room. A wait
 * no release can ever satisfy (every worker held by a process stuck on its
 * own children, which wait here or are stuck too) is refused instead, on a
 * later turn than the change that showed it: {@link DynamicWorkerDeadlockError}.
 *
 * Keyed weakly off the hosting actor's `ctx`, like the facet slot books: the
 * limit is per Durable Object, and dynamic workers die with the isolate that
 * loaded them, so a ledger that goes away with its host describes nothing
 * that still exists.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
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
 * The refusal of a wait for a Dynamic Worker that no release can ever
 * satisfy: every worker this Durable Object has in flight is held by a
 * process stuck on its own children (deadlocked: it has said it waits on
 * nothing else and has heard all the news of them, and each of them is
 * queued here or stuck too), so none will end to make room (nine children
 * of a parent, each doing nothing but wait on a grandchild of its own, fill
 * the limit). The newest queued process a stuck process waits on is refused,
 * as a spawn at a process limit is (EAGAIN): its program never runs, and
 * whoever waits on it hears so and can go on.
 */
export class DynamicWorkerDeadlockError extends Error {
    pid;
    holders;
    code = 'EAGAIN';
    errno = -11;
    constructor(pid, holders) {
        super(`Resource temporarily unavailable: every Dynamic Worker this Durable Object may have in flight `
            + `(${DO_DYNAMIC_WORKER_LIMIT}) is held by a process doing nothing but wait on its children `
            + `(holders ${holders.join(', ')}); process ${pid} cannot be started`);
        this.pid = pid;
        this.holders = holders;
        this.name = 'DynamicWorkerDeadlockError';
    }
}
/** Whether `error` is the ledger's refusal of a wait nothing can satisfy. */
export function isDynamicWorkerDeadlock(error) {
    return error instanceof DynamicWorkerDeadlockError;
}
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
            inFlight: new Map(), holders: new Map(), processHolds: new Map(), news: new Map(), graph: undefined,
            schedule: decideOnALaterTurn, deciding: false,
            claims: new Set(), peak: 0,
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
/** Take one hold, for process `holder` if it is one's; the caller admits waiters after. */
function hold(entry, workerKey, claim, holder) {
    count(entry.inFlight, workerKey, 1);
    if (claim)
        count(claim.keys, workerKey, 1);
    const holders = entry.holders.get(workerKey) ?? [];
    holders.push(holder);
    entry.holders.set(workerKey, holders);
    if (holder !== null)
        entry.processHolds.set(holder, (entry.processHolds.get(holder) ?? 0) + 1);
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
        holders.splice(holders.indexOf(holder), 1);
        if (holders.length === 0)
            entry.holders.delete(workerKey);
        // A process that holds nothing more is not a holder whose state matters.
        if (holder !== null) {
            const open = (entry.processHolds.get(holder) ?? 1) - 1;
            if (open > 0)
                entry.processHolds.set(holder, open);
            else {
                entry.processHolds.delete(holder);
                entry.news.delete(holder);
            }
        }
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
        waiter.admit(hold(entry, waiter.key, waiter.claim, waiter.process?.pid ?? null));
        if (!joins)
            i = 0;
    }
    // A wait that looks unsatisfiable is never refused on the synchronous path
    // of the change that made it look so: that change may be one half of a
    // step whose other half has not run yet (a shell's command ending, its next
    // one about to begin). The decision is put off to a later turn, after the
    // continuations pending now have run, and taken on the state as it is then.
    if (!entry.deciding && deadlocked(entry) !== undefined) {
        entry.deciding = true;
        entry.schedule(() => {
            entry.deciding = false;
            decide(entry);
        });
    }
}
/** The default schedule for a refusal's decision: a later turn of the event loop. */
function decideOnALaterTurn(decide) {
    setTimeout(decide, 0);
}
/**
 * A refusal put off by admitWaiters, decided on the ledger as it stands now:
 * the newest wait no release can satisfy is refused, if there still is one.
 */
function decide(entry) {
    const stuck = deadlocked(entry);
    if (stuck === undefined)
        return;
    // Refused, it is no longer queued: whoever waits on it is no longer stuck
    // (its wait will end, with this error), so one refusal answers one
    // deadlock.
    entry.waiters.splice(entry.waiters.indexOf(stuck.waiter), 1);
    stuck.waiter.refuse(new DynamicWorkerDeadlockError(stuck.waiter.process.pid, stuck.holders));
}
/**
 * The wait no release can ever let in, with the processes holding the
 * limit, or undefined while room may still come. Room comes when a hold
 * ends or a fan-out's claim is released, and a hold ends when the process
 * holding it ends, unless it is stuck. Whether a process is stuck is told
 * from the session's own account of its processes (the ProcessWaitGraph,
 * never pids a guest names) and from what each guest has said of itself:
 *
 *   - a guest holding a worker is stuck when its report is current (it said
 *     it is blocked, waiting on nothing but its children, having applied
 *     every piece of news the session issued it: ProcessNews) and each of
 *     its running children is queued here or stuck;
 *   - a process holding no worker (a shell line running in the session) is
 *     stuck when every unit of its own work is awaiting a child it started
 *     (the graph's `awaits`), and each of those is queued or stuck;
 *   - anything else (a builtin running, a process that never reports, a
 *     hold no process owns) is taken to end on its own.
 *
 * Computed as the greatest fixpoint over those wait-for edges: start from
 * every candidate, and drop any that waits on a process neither queued nor
 * still in the set, until nothing changes (a closed cycle stays stuck). At
 * the limit, with no claim, and every worker in flight held by a stuck
 * process, nothing will make room: the newest queued process a stuck process
 * waits on is refused, on a later turn, if it still is (admitWaiters).
 */
function deadlocked(entry) {
    const graph = entry.graph;
    if (!graph || entry.waiters.length === 0 || entry.claims.size > 0)
        return undefined;
    if (inUse(entry) < DO_DYNAMIC_WORKER_LIMIT)
        return undefined;
    const queued = new Set();
    for (const waiter of entry.waiters)
        if (waiter.process)
            queued.add(waiter.process.pid);
    // What each candidate waits on, from the holders outward.
    const waitsOn = new Map();
    const visit = (pid) => {
        if (waitsOn.has(pid) || queued.has(pid))
            return;
        let on;
        if (entry.processHolds.has(pid))
            on = currentNews(entry, pid) ? graph.children(pid) : null;
        else
            on = graph.awaits(pid);
        if (!on || on.length === 0)
            return;
        waitsOn.set(pid, on);
        for (const child of on)
            visit(child);
    };
    for (const pid of entry.processHolds.keys())
        visit(pid);
    const stuck = new Set(waitsOn.keys());
    for (let changed = true; changed;) {
        changed = false;
        for (const pid of stuck) {
            if (waitsOn.get(pid).some((child) => !queued.has(child) && !stuck.has(child))) {
                stuck.delete(pid);
                changed = true;
            }
        }
    }
    // Every worker in flight is held for good: one of its holders is stuck.
    for (const owners of entry.holders.values()) {
        if (!owners.some((pid) => pid !== null && stuck.has(pid)))
            return undefined;
    }
    for (let i = entry.waiters.length - 1; i >= 0; i--) {
        const waiter = entry.waiters[i];
        const pid = waiter.process?.pid;
        if (pid === undefined)
            continue;
        for (const holder of stuck) {
            if (waitsOn.get(holder).includes(pid)) {
                return { waiter, holders: [...stuck].filter((p) => entry.processHolds.has(p)) };
            }
        }
    }
    return undefined;
}
/**
 * The session's process account for `ctx`'s ledger (ProcessWaitGraph).
 * Without one, nothing is refused. `schedule` runs a refusal's decision on
 * a later turn (by default the event loop's next); a test drives it.
 */
export function bindProcessWaitGraph(ctx, graph, schedule = decideOnALaterTurn) {
    const entry = ledger(ctx);
    entry.graph = graph;
    entry.schedule = schedule;
}
/**
 * A session's process table, bound to `ctx`'s ledger: its wait graph read
 * from the table, and every change to what a process waits on told to the
 * ledger (processWaitGraphChanged). The one binding the session and the
 * ledger's protocol model (tests/unit/lib/ledger-protocol-model.mjs) use.
 */
export function bindProcessTable(ctx, processes, schedule) {
    bindProcessWaitGraph(ctx, processes.waitGraph(), schedule);
    processes.setOnWaitChange(() => processWaitGraphChanged(ctx));
}
/**
 * What the graph answers has changed (a process's work began or ended, a
 * child ended): a wait nothing could satisfy before may be told now.
 */
export function processWaitGraphChanged(ctx) {
    admitWaiters(ledger(ctx));
}
function newsOf(entry, pid) {
    let news = entry.news.get(pid);
    if (!news)
        entry.news.set(pid, news = { issued: 0, reportSeq: 0, blockedAt: null });
    return news;
}
/** Whether `pid` has said it is blocked, having applied all the news it was issued. */
function currentNews(entry, pid) {
    const news = entry.news.get(pid);
    return news !== undefined && news.blockedAt !== null && news.blockedAt === news.issued;
}
/**
 * Process `pid` says whether its only remaining work is waiting on its own
 * children (a runtime's own liveness, as Node's ref-counted event loop knows
 * it: no timer, socket, server, stdin read or fetch of its own is pending),
 * and how far it has applied its news. Taken only from a process holding a
 * worker, and only if newer than the last taken (ProcessNews).
 */
export function setProcessBlocked(ctx, pid, report) {
    const entry = ledger(ctx);
    if (!entry.processHolds.has(pid))
        return;
    const news = newsOf(entry, pid);
    if (!(report.seq > news.reportSeq))
        return;
    news.reportSeq = report.seq;
    news.blockedAt = report.blocked && report.frontier === news.issued ? report.frontier : null;
    admitWaiters(entry);
}
/**
 * Number a piece of news for process `pid` as it is produced (ProcessNews):
 * the reply that delivers it carries this number. 0, and nothing counted,
 * for a process holding no worker, whose reports are not taken.
 */
export function issueProcessNews(ctx, pid) {
    const entry = ledger(ctx);
    if (!entry.processHolds.has(pid))
        return 0;
    return ++newsOf(entry, pid).issued;
}
/**
 * Hold the Dynamic Worker `workerKey` in flight on this actor's ledger; the
 * returned function ends the hold (idempotently), from the caller's own
 * `finally`. Holds on one key nest: the worker counts once until the last
 * one ends, as the platform counts it. Under a `claim`, the hold counts
 * inside the claim's width. This never waits: it is for work the actor
 * starts regardless (a resident process); {@link beginLoaderFetchWhenFree}
 * waits for room. `holder` is the process the hold is for, when it is one's
 * (a resident's worker): see {@link DynamicWorkerDeadlockError}.
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
export function beginLoaderFetch(ctx, workerKey, claim, holder) {
    const entry = ledger(ctx);
    const end = hold(entry, workerKey, claimOf(ctx, claim), holder ?? null);
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
 * `process` is the process the wait is for, and the ones it descends from;
 * the hold it is let in on is that process's. When every worker of a full
 * ledger is held by a process stuck on its children (deadlocked), no wait
 * can be let in, and the newest a stuck holder waits on is refused with
 * {@link DynamicWorkerDeadlockError} (EAGAIN), holding nothing.
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
            process: options.process,
            admit(end) {
                signal?.removeEventListener('abort', abandon);
                resolve(end);
            },
            refuse(error) {
                signal?.removeEventListener('abort', abandon);
                reject(error);
            },
        };
        entry.waiters.push(waiter);
        signal?.addEventListener('abort', abandon, { once: true });
        admitWaiters(entry);
    });
}
/**
 * The admission of the launch whose async context this is. AsyncLocalStorage
 * rather than a parameter, so a launch's helper calls (a transform, a build,
 * a prebundle) find it however deep the call that makes them, and a
 * concurrent launch's never do. Requires `nodejs_compat` (or `nodejs_als`).
 */
const launchAdmission = new AsyncLocalStorage();
/**
 * Run a launch admitted once on the ledger. It waits, as
 * {@link beginLoaderFetchWhenFree} with its process does, for one Dynamic
 * Worker, and holds it until `body` settles. Everything the launch puts in
 * flight in body's async context (its transform facet, its build facet, its
 * own program) is that worker: a launch prepares and then runs, one of them
 * at a time, so its preparation can never wait on room its own admission
 * holds. A stopped program releases the admission while it awaits input
 * (suspendLaunchAdmission), and waits its turn to regain it before preparing
 * its next run. (A helper call its program makes later, over RPC, is not in that
 * context: a worker more, it waits its turn.) `signal` abandons the wait; a
 * wait no release can satisfy is refused with {@link DynamicWorkerDeadlockError}.
 */
export async function withLaunchAdmission(ctx, process, signal, body) {
    const end = await beginLoaderFetchWhenFree(ctx, `launch:${process.pid}`, { signal, process });
    const admission = { ctx, process, end, claimed: false, closed: false };
    try {
        return await launchAdmission.run(admission, body);
    }
    finally {
        admission.closed = true;
        admission.end?.();
        admission.end = undefined;
    }
}
/**
 * A program that stopped has no Worker in flight: give back its launch's
 * admission before waiting on input. Its nested run hold must already have
 * ended. The returned resume waits on the ledger with the same process,
 * fairly and abortably, before the caller does any replay preparation.
 * Calling resume twice joins one readmission, never takes two holds. If the
 * process ends instead, the launch's finally finds nothing held.
 * Undefined outside a launch admission (a shell's one-shot owns only its
 * run hold, which has already ended).
 */
export function suspendLaunchAdmission(ctx) {
    const admission = launchAdmission.getStore();
    if (admission?.ctx !== ctx)
        return undefined;
    if (admission.claimed || admission.end === undefined || admission.closed) {
        throw new Error('Nimbus: only a stopped launch with no run in flight can release its admission');
    }
    const end = admission.end;
    admission.end = undefined;
    end();
    let resumed;
    return (signal) => resumed ??= (async () => {
        if (admission.closed)
            throw new Error('Nimbus: a finished launch cannot regain its admission');
        const hold = await beginLoaderFetchWhenFree(ctx, `launch:${admission.process.pid}`, { signal, process: admission.process });
        // A kill may arrive after admission but before this continuation runs.
        if (signal?.aborted || admission.closed) {
            hold();
            if (signal?.aborted)
                throw signal.reason;
            throw new Error('Nimbus: a finished launch cannot regain its admission');
        }
        admission.end = hold;
    })();
}
/**
 * Within an admitted launch on `ctx`'s ledger, a hold on that launch's own
 * worker for a helper's call made in its preparation: holds on one key nest
 * and count once, so it costs nothing more, and a limit refusal it ends with
 * still pauses the ledger. Undefined outside one.
 */
export function beginAdmittedFetch(ctx) {
    const admission = launchAdmission.getStore();
    if (admission?.ctx !== ctx || admission.end === undefined)
        return undefined;
    return beginLoaderFetch(ctx, `launch:${admission.process.pid}`, undefined, admission.process.pid);
}
/**
 * Within an admitted launch on `ctx`'s ledger, the admission's worker for the
 * launch's program: the first run claims it, whatever pid its runtime runs
 * it as (Bun's runner, like any runtime that allocates its own, runs it as a
 * child of the launch's pid), and gives it back as it ends. A second run
 * while the first holds it is a worker of its own, and gets undefined, as
 * does a run outside an admitted launch: either waits its turn on the
 * ledger. The hold counts for `pid` too, the process whose state says
 * whether the worker can be given back (see setProcessBlocked).
 */
export function claimAdmission(ctx, pid) {
    const admission = launchAdmission.getStore();
    if (admission?.ctx !== ctx || admission.end === undefined || admission.claimed)
        return undefined;
    admission.claimed = true;
    const runner = beginLoaderFetch(ctx, `launch:${admission.process.pid}`, undefined, pid ?? admission.process.pid);
    let ended = false;
    return (failure) => {
        if (ended)
            return;
        ended = true;
        admission.claimed = false;
        runner(failure);
    };
}
/**
 * The Dynamic Worker `workerKey` in flight for a helper's call (the
 * transform facet, the esbuild facet, the build facet): within an admitted
 * launch it is that launch's worker (beginAdmittedFetch); otherwise it waits
 * its turn on the ledger, joining at once when that worker is already in
 * flight. End the hold from the caller's own `finally`, as beginLoaderFetch's.
 */
export async function beginHelperFetch(ctx, workerKey) {
    return beginAdmittedFetch(ctx) ?? beginLoaderFetchWhenFree(ctx, workerKey);
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
        holders: Object.fromEntries([...entry.holders].map(([key, owners]) => [key, [...owners]])),
        waiters: entry.waiters.map((w) => ({ key: w.key, pid: w.process?.pid })),
        news: Object.fromEntries([...entry.news].map(([pid, news]) => [pid, { ...news }])),
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
/** Where it persists how many `proc-slot-` names the slot book has ever minted. */
const FACET_SLOT_HIGH_WATER_KEY = 'fabric_facet_slot_high_water';
/** The row that marks one explicit facet name (a lease's, a durable application's) as minted. */
const mintedNameKey = (name) => `fabric_facet_name_minted:${name}`;
const facetNameLedgers = new WeakMap();
function facetNameLedger(ctx) {
    let ledger = facetNameLedgers.get(ctx);
    if (!ledger) {
        const read = (key) => Promise.resolve(ctx.storage.get(key))
            .then((value) => (typeof value === 'number' ? value : undefined), () => undefined);
        const created = { chain: Promise.resolve({ names: 0, slots: 0 }), names: 0, minted: new Set() };
        created.chain = Promise.all([read(FACET_NAME_HIGH_WATER_KEY), read(FACET_SLOT_HIGH_WATER_KEY)])
            .then(([names = 0, slots]) => {
            created.names = names;
            // A ledger persisted before the slot high-water existed kept slots
            // and names in one count. That count bounds the slots, so no slot
            // under it is charged twice.
            return { names, slots: slots ?? names };
        });
        ledger = created;
        facetNameLedgers.set(ctx, ledger);
    }
    return ledger;
}
/**
 * Append one charge to the ledger and persist the counts it leaves. A failed
 * write keeps the charge in memory, and the next charge's write carries it:
 * the durable count may lag, never lead.
 */
function appendCharge(ctx, ledger, charge) {
    ledger.chain = ledger.chain.then(async (counts) => {
        const after = await charge(counts);
        if (after.names !== counts.names || after.slots !== counts.slots) {
            try {
                await ctx.storage.put(FACET_NAME_HIGH_WATER_KEY, after.names);
                await ctx.storage.put(FACET_SLOT_HIGH_WATER_KEY, after.slots);
            }
            catch { /* the next charge writes both counts again */ }
        }
        ledger.names = after.names;
        return after;
    });
    return ledger.chain;
}
/**
 * Charge the slot book's `slot`. A fresh incarnation restarts the book at
 * zero and issues the same `proc-slot-` names again, so only a slot past the
 * slot high-water is a name never minted before.
 */
export function chargeFacetSlot(ctx, slot) {
    void appendCharge(ctx, facetNameLedger(ctx), async (counts) => (slot < counts.slots
        ? counts
        : { names: counts.names + slot + 1 - counts.slots, slots: slot + 1 }));
}
/**
 * Charge an explicit facet name before its facet is created: its first use
 * ever consumes one lifetime ID, and any later use, in this incarnation or
 * another, costs nothing. A first use at the wall is refused, so nothing is
 * created. Resolves with the count after the charge.
 */
export async function chargeFacetName(ctx, name) {
    const ledger = facetNameLedger(ctx);
    let refused = false;
    const counts = await appendCharge(ctx, ledger, async (before) => {
        if (ledger.minted.has(name))
            return before;
        const marked = await Promise.resolve(ctx.storage.get(mintedNameKey(name))).then((value) => value === true, () => false);
        if (marked) {
            ledger.minted.add(name);
            return before;
        }
        if (before.names >= FACET_ID_LIFETIME_BUDGET) {
            refused = true;
            return before;
        }
        ledger.minted.add(name);
        return { names: before.names + 1, slots: before.slots };
    });
    if (refused) {
        throw withFacetBudgetNamed(counts.names, new Error(`facet '${name}' refused before creation: no lifetime ids remain`));
    }
    // After the count it adds to, so a lost write charges the name again rather than never.
    await Promise.resolve(ctx.storage.put(mintedNameKey(name), true)).catch(() => { });
    return counts.names;
}
/** The best count available without awaiting storage. */
export function facetNameCount(ctx) {
    return facetNameLedger(ctx).names;
}
/** The count with every charge so far applied, for a first failure on a fresh boot. */
export async function facetNameCountDurable(ctx) {
    return (await facetNameLedger(ctx).chain).names;
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
