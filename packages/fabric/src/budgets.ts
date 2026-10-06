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
 * Ends one hold, idempotently. Pass the error the call failed with, if it
 * did: a "Dynamic worker concurrency limit exceeded" refusal pauses the
 * ledger's admissions (see {@link beginLoaderFetchWhenFree}); anything else,
 * or nothing, just ends the hold.
 */
export type EndLoaderFetch = (failure?: unknown) => void;

/**
 * A width one fan-out reserved with {@link claimDynamicWorkers}. Holds taken
 * under it (`beginLoaderFetch(ctx, key, claim)`) count inside that width, not
 * on top of it, until `release` (idempotent).
 */
export interface DynamicWorkerClaim {
  release(): void;
}

interface ClaimEntry {
  width: number;
  /** Loader id → open holds taken under this claim. */
  keys: Map<string, number>;
}

/**
 * A process on the ledger: the one a hold or a wait is for, as the session's
 * process table knows it (ProcessWaitGraph).
 */
export interface LedgerProcess {
  pid: number;
}

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
  readonly code = 'EAGAIN';
  readonly errno = -11;
  constructor(readonly pid: number, readonly holders: readonly number[]) {
    super(
      `Resource temporarily unavailable: every Dynamic Worker this Durable Object may have in flight `
        + `(${DO_DYNAMIC_WORKER_LIMIT}) is held by a process doing nothing but wait on its children `
        + `(holders ${holders.join(', ')}); process ${pid} cannot be started`,
    );
    this.name = 'DynamicWorkerDeadlockError';
  }
}

/** Whether `error` is the ledger's refusal of a wait nothing can satisfy. */
export function isDynamicWorkerDeadlock(error: unknown): error is DynamicWorkerDeadlockError {
  return error instanceof DynamicWorkerDeadlockError;
}

interface Waiter {
  key: string;
  claim: ClaimEntry | undefined;
  process: LedgerProcess | undefined;
  admit(end: EndLoaderFetch): void;
  refuse(error: DynamicWorkerDeadlockError): void;
}

interface LoaderLedger {
  /** Loader id → open holds on it, under a claim or not. A key is present only while held. */
  inFlight: Map<string, number>;
  /** Loader id → the process each open hold on it is for; null for a hold no process owns. */
  holders: Map<string, Array<number | null>>;
  /** Process → its open holds: a process with none is not a holder whose state matters. */
  processHolds: Map<number, number>;
  /** Process → what it last said of itself, while it holds a worker (see ProcessNews). */
  news: Map<number, ProcessNews>;
  /** The session's processes and what each waits on (bindProcessWaitGraph); none, no refusals. */
  graph: ProcessWaitGraph | undefined;
  /** How a refusal is put off to a later turn (bindProcessWaitGraph); a decision is pending while set. */
  schedule: (decide: () => void) => void;
  deciding: boolean;
  /** Claims not yet released. */
  claims: Set<ClaimEntry>;
  /** The most distinct workers (holds plus claims) ever counted at once. */
  peak: number;
  /** Waits not yet admitted, in the order they asked. */
  waiters: Waiter[];
  /** Length of the pause a refusal started, while it lasts; 0 when admitting. */
  pauseMs: number;
  pauseTimer: ReturnType<typeof setTimeout> | undefined;
  /** Advanced when a pause starts and when it ends; a hold keeps the one it began in. */
  epoch: number;
  /** Pauses in a row with no worker admitted between them. */
  refusals: number;
}

/**
 * The first pause after a limit refusal, doubling while refusals continue,
 * up to {@link REFUSAL_PAUSE_MAX_MS}. A deployed Durable Object admitted a
 * batch it had refused after a 6 s pause.
 */
const REFUSAL_PAUSE_MS = 50;
const REFUSAL_PAUSE_MAX_MS = 2_000;

const ledgers = new WeakMap<object, LoaderLedger>();
const claimEntries = new WeakMap<DynamicWorkerClaim, { ledger: LoaderLedger; entry: ClaimEntry }>();

function ledger(ctx: object): LoaderLedger {
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
function inUse(entry: LoaderLedger): number {
  let count = 0;
  const covered = new Set<string>();
  for (const claim of entry.claims) {
    count += Math.max(claim.width, claim.keys.size);
    for (const key of claim.keys.keys()) covered.add(key);
  }
  for (const key of entry.inFlight.keys()) if (!covered.has(key)) count++;
  return count;
}

function headroom(entry: LoaderLedger): number {
  return entry.pauseMs > 0 ? 0 : Math.max(0, DO_DYNAMIC_WORKER_LIMIT - inUse(entry));
}

function claimOf(ctx: object, claim: DynamicWorkerClaim | undefined): ClaimEntry | undefined {
  if (claim === undefined) return undefined;
  const owned = claimEntries.get(claim);
  if (owned === undefined || owned.ledger !== ledger(ctx)) {
    throw new Error('Nimbus: a Dynamic Worker claim is used only on the ledger of the actor that claimed it');
  }
  return owned.ledger.claims.has(owned.entry) ? owned.entry : undefined;
}

function count(map: Map<string, number>, key: string, by: 1 | -1): void {
  const open = (map.get(key) ?? 0) + by;
  if (open > 0) map.set(key, open);
  else map.delete(key);
}

/** Take one hold, for process `holder` if it is one's; the caller admits waiters after. */
function hold(entry: LoaderLedger, workerKey: string, claim: ClaimEntry | undefined, holder: number | null): EndLoaderFetch {
  count(entry.inFlight, workerKey, 1);
  if (claim) count(claim.keys, workerKey, 1);
  const holders = entry.holders.get(workerKey) ?? [];
  holders.push(holder);
  entry.holders.set(workerKey, holders);
  if (holder !== null) entry.processHolds.set(holder, (entry.processHolds.get(holder) ?? 0) + 1);
  entry.peak = Math.max(entry.peak, inUse(entry));
  const epoch = entry.epoch;
  let ended = false;
  return (failure) => {
    if (ended) return;
    ended = true;
    count(entry.inFlight, workerKey, -1);
    if (claim) count(claim.keys, workerKey, -1);
    holders.splice(holders.indexOf(holder), 1);
    if (holders.length === 0) entry.holders.delete(workerKey);
    // A process that holds nothing more is not a holder whose state matters.
    if (holder !== null) {
      const open = (entry.processHolds.get(holder) ?? 1) - 1;
      if (open > 0) entry.processHolds.set(holder, open);
      else {
        entry.processHolds.delete(holder);
        entry.news.delete(holder);
      }
    }
    if (classifyError(failure) === 'dynamic_worker_cap') refused(entry, epoch);
    else if (epoch === entry.epoch && entry.pauseMs === 0) entry.refusals = 0;
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
function refused(entry: LoaderLedger, epoch: number): void {
  if (epoch !== entry.epoch) return;
  if (entry.pauseTimer !== undefined) clearTimeout(entry.pauseTimer);
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

function admissible(entry: LoaderLedger, waiter: Waiter): boolean {
  // Requests to a worker already in flight count once, even while paused.
  if (entry.inFlight.has(waiter.key)) return true;
  if (entry.pauseMs > 0) return false;
  if (waiter.claim && entry.claims.has(waiter.claim) && waiter.claim.keys.size < waiter.claim.width) return true;
  return inUse(entry) < DO_DYNAMIC_WORKER_LIMIT;
}

/**
 * Let in every waiter that fits, in the order they asked: each takes its
 * hold here, so a freed slot goes to exactly one waiter and is never left
 * between a wake and a begin. Run after every change that can make room.
 * A waiter let in on a new key lets in the later ones on that key, and the
 * earlier ones too: the scan starts over.
 */
function admitWaiters(entry: LoaderLedger): void {
  for (let i = 0; i < entry.waiters.length;) {
    const waiter = entry.waiters[i];
    if (!admissible(entry, waiter)) { i++; continue; }
    const joins = entry.inFlight.has(waiter.key);
    entry.waiters.splice(i, 1);
    waiter.admit(hold(entry, waiter.key, waiter.claim, waiter.process?.pid ?? null));
    if (!joins) i = 0;
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
function decideOnALaterTurn(decide: () => void): void {
  setTimeout(decide, 0);
}

/**
 * A refusal put off by admitWaiters, decided on the ledger as it stands now:
 * the newest wait no release can satisfy is refused, if there still is one.
 */
function decide(entry: LoaderLedger): void {
  const stuck = deadlocked(entry);
  if (stuck === undefined) return;
  // Refused, it is no longer queued: whoever waits on it is no longer stuck
  // (its wait will end, with this error), so one refusal answers one
  // deadlock.
  entry.waiters.splice(entry.waiters.indexOf(stuck.waiter), 1);
  stuck.waiter.refuse(new DynamicWorkerDeadlockError(stuck.waiter.process!.pid, stuck.holders));
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
function deadlocked(entry: LoaderLedger): { waiter: Waiter; holders: number[] } | undefined {
  const graph = entry.graph;
  if (!graph || entry.waiters.length === 0 || entry.claims.size > 0) return undefined;
  if (inUse(entry) < DO_DYNAMIC_WORKER_LIMIT) return undefined;
  const queued = new Set<number>();
  for (const waiter of entry.waiters) if (waiter.process) queued.add(waiter.process.pid);
  // What each candidate waits on, from the holders outward.
  const waitsOn = new Map<number, readonly number[]>();
  const visit = (pid: number): void => {
    if (waitsOn.has(pid) || queued.has(pid)) return;
    let on: readonly number[] | null;
    if (entry.processHolds.has(pid)) on = currentNews(entry, pid) ? graph.children(pid) : null;
    else on = graph.awaits(pid);
    if (!on || on.length === 0) return;
    waitsOn.set(pid, on);
    for (const child of on) visit(child);
  };
  for (const pid of entry.processHolds.keys()) visit(pid);
  const stuck = new Set(waitsOn.keys());
  for (let changed = true; changed;) {
    changed = false;
    for (const pid of stuck) {
      if (waitsOn.get(pid)!.some((child) => !queued.has(child) && !stuck.has(child))) {
        stuck.delete(pid);
        changed = true;
      }
    }
  }
  // Every worker in flight is held for good: one of its holders is stuck.
  for (const owners of entry.holders.values()) {
    if (!owners.some((pid) => pid !== null && stuck.has(pid))) return undefined;
  }
  for (let i = entry.waiters.length - 1; i >= 0; i--) {
    const waiter = entry.waiters[i];
    const pid = waiter.process?.pid;
    if (pid === undefined) continue;
    for (const holder of stuck) {
      if (waitsOn.get(holder)!.includes(pid)) {
        return { waiter, holders: [...stuck].filter((p) => entry.processHolds.has(p)) };
      }
    }
  }
  return undefined;
}

/**
 * The session's account of its processes, which the ledger's wait-for edges
 * are built from (deadlocked). Answers about processes as the session's own
 * process table records them, never as a guest names them: a parent's child
 * may be a shell whose program runs under a pid of its own.
 */
export interface ProcessWaitGraph {
  /** `pid`'s running children. */
  children(pid: number): readonly number[];
  /**
   * The children `pid` awaits, when awaiting them is every unit of its own
   * in-flight work (a shell line whose every command awaits a program it
   * started); null when it has other work, or none.
   */
  awaits(pid: number): readonly number[] | null;
}

/**
 * The session's process account for `ctx`'s ledger (ProcessWaitGraph).
 * Without one, nothing is refused. `schedule` runs a refusal's decision on
 * a later turn (by default the event loop's next); a test drives it.
 */
export function bindProcessWaitGraph(
  ctx: object,
  graph: ProcessWaitGraph,
  schedule: (decide: () => void) => void = decideOnALaterTurn,
): void {
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
export function bindProcessTable(
  ctx: object,
  processes: { waitGraph(): ProcessWaitGraph; setOnWaitChange(cb: (() => void) | null): void },
  schedule?: (decide: () => void) => void,
): void {
  bindProcessWaitGraph(ctx, processes.waitGraph(), schedule);
  processes.setOnWaitChange(() => processWaitGraphChanged(ctx));
}

/**
 * What the graph answers has changed (a process's work began or ended, a
 * child ended): a wait nothing could satisfy before may be told now.
 */
export function processWaitGraphChanged(ctx: object): void {
  admitWaiters(ledger(ctx));
}

/**
 * What a guest holding a worker has said of itself, and the news the
 * session has issued it. News is anything about its children that could
 * make it run again: a child's start, its output, the end of a stream, its
 * exit, a refused spawn. The session numbers each piece as it is produced
 * (issueProcessNews), the reply that delivers it carries the number, and the
 * guest acknowledges the contiguous run of numbers it has applied (its
 * frontier: every number up to it, whatever order the replies came in). A
 * report counts only while its frontier is everything issued: news produced
 * after it, sent or not, delivered or not, makes it stale, and a report sent
 * before news it had not applied can never be taken. Reports are numbered by
 * the guest; one older than the last taken is dropped, never reinstalled.
 */
interface ProcessNews {
  /** Pieces of news issued to it so far. */
  issued: number;
  /** The number of the last report taken. */
  reportSeq: number;
  /** The frontier of its report, while that report says it is blocked. */
  blockedAt: number | null;
}

function newsOf(entry: LoaderLedger, pid: number): ProcessNews {
  let news = entry.news.get(pid);
  if (!news) entry.news.set(pid, news = { issued: 0, reportSeq: 0, blockedAt: null });
  return news;
}

/** Whether `pid` has said it is blocked, having applied all the news it was issued. */
function currentNews(entry: LoaderLedger, pid: number): boolean {
  const news = entry.news.get(pid);
  return news !== undefined && news.blockedAt !== null && news.blockedAt === news.issued;
}

/** What a guest says of itself (setProcessBlocked). */
export interface ProcessBlockedReport {
  /** Its only remaining work is waiting on its children. */
  blocked: boolean;
  /** Its frontier: it has applied every piece of news numbered up to here (ProcessNews). */
  frontier: number;
  /** The report's own number, increasing. */
  seq: number;
}

/**
 * Process `pid` says whether its only remaining work is waiting on its own
 * children (a runtime's own liveness, as Node's ref-counted event loop knows
 * it: no timer, socket, server, stdin read or fetch of its own is pending),
 * and how far it has applied its news. Taken only from a process holding a
 * worker, and only if newer than the last taken (ProcessNews).
 */
export function setProcessBlocked(ctx: object, pid: number, report: ProcessBlockedReport): void {
  const entry = ledger(ctx);
  if (!entry.processHolds.has(pid)) return;
  const news = newsOf(entry, pid);
  if (!(report.seq > news.reportSeq)) return;
  news.reportSeq = report.seq;
  news.blockedAt = report.blocked && report.frontier === news.issued ? report.frontier : null;
  admitWaiters(entry);
}

/**
 * Number a piece of news for process `pid` as it is produced (ProcessNews):
 * the reply that delivers it carries this number. 0, and nothing counted,
 * for a process holding no worker, whose reports are not taken.
 */
export function issueProcessNews(ctx: object, pid: number): number {
  const entry = ledger(ctx);
  if (!entry.processHolds.has(pid)) return 0;
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
export function beginLoaderFetch(ctx: object, workerKey: string, claim?: DynamicWorkerClaim, holder?: number): EndLoaderFetch {
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
export function beginLoaderFetchWhenFree(
  ctx: object,
  workerKey: string,
  options: { signal?: AbortSignal; claim?: DynamicWorkerClaim; process?: LedgerProcess } = {},
): Promise<EndLoaderFetch> {
  const { signal } = options;
  return new Promise<EndLoaderFetch>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const entry = ledger(ctx);
    const abandon = () => {
      const at = entry.waiters.indexOf(waiter);
      if (at < 0) return;
      entry.waiters.splice(at, 1);
      reject(signal?.reason);
    };
    const waiter: Waiter = {
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
 * One launch's admission: a process let in on the ledger once, before its
 * preparation, as the one Dynamic Worker it puts in flight at a time.
 */
interface Admission {
  ctx: object;
  process: LedgerProcess;
  /** Absent while a stopped program waits for input or readmission. */
  end: EndLoaderFetch | undefined;
  /** A program run of the launch holds the admission's worker (claimAdmission). */
  claimed: boolean;
  closed: boolean;
}

/**
 * The admission of the launch whose async context this is. AsyncLocalStorage
 * rather than a parameter, so a launch's helper calls (a transform, a build,
 * a prebundle) find it however deep the call that makes them, and a
 * concurrent launch's never do. Requires `nodejs_compat` (or `nodejs_als`).
 */
const launchAdmission = new AsyncLocalStorage<Admission>();

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
export async function withLaunchAdmission<T>(
  ctx: object,
  process: LedgerProcess,
  signal: AbortSignal | undefined,
  body: () => Promise<T>,
): Promise<T> {
  const end = await beginLoaderFetchWhenFree(ctx, `launch:${process.pid}`, { signal, process });
  const admission: Admission = { ctx, process, end, claimed: false, closed: false };
  try {
    return await launchAdmission.run(admission, body);
  } finally {
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
export function suspendLaunchAdmission(ctx: object): ((signal?: AbortSignal) => Promise<void>) | undefined {
  const admission = launchAdmission.getStore();
  if (admission?.ctx !== ctx) return undefined;
  if (admission.claimed || admission.end === undefined || admission.closed) {
    throw new Error('Nimbus: only a stopped launch with no run in flight can release its admission');
  }
  const end = admission.end;
  admission.end = undefined;
  end();
  let resumed: Promise<void> | undefined;
  return (signal) => resumed ??= (async () => {
    if (admission.closed) throw new Error('Nimbus: a finished launch cannot regain its admission');
    const hold = await beginLoaderFetchWhenFree(ctx, `launch:${admission.process.pid}`, { signal, process: admission.process });
    // A kill may arrive after admission but before this continuation runs.
    if (signal?.aborted || admission.closed) {
      hold();
      if (signal?.aborted) throw signal.reason;
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
export function beginAdmittedFetch(ctx: object): EndLoaderFetch | undefined {
  const admission = launchAdmission.getStore();
  if (admission?.ctx !== ctx || admission.end === undefined) return undefined;
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
export function claimAdmission(ctx: object, pid?: number): EndLoaderFetch | undefined {
  const admission = launchAdmission.getStore();
  if (admission?.ctx !== ctx || admission.end === undefined || admission.claimed) return undefined;
  admission.claimed = true;
  const runner = beginLoaderFetch(ctx, `launch:${admission.process.pid}`, undefined, pid ?? admission.process.pid);
  let ended = false;
  return (failure) => {
    if (ended) return;
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
export async function beginHelperFetch(ctx: object, workerKey: string): Promise<EndLoaderFetch> {
  return beginAdmittedFetch(ctx) ?? beginLoaderFetchWhenFree(ctx, workerKey);
}

/**
 * Distinct Dynamic Workers this actor may still put in flight: the limit
 * less what is held and claimed right now, and none while a limit refusal's
 * pause lasts. Never negative.
 */
export function dynamicWorkerHeadroom(ctx: object): number {
  return headroom(ledger(ctx));
}

/**
 * Claim `width` distinct Dynamic Workers for one fan-out, or null when the
 * headroom cannot hold it. The claim counts until `release` (idempotent), so
 * a second fan-out sizing itself meanwhile sees it; the claimant's own
 * dispatches, held under the claim, count inside it.
 */
export function claimDynamicWorkers(ctx: object, width: number): DynamicWorkerClaim | null {
  const entry = ledger(ctx);
  if (width < 1 || width > headroom(entry)) return null;
  const claim: ClaimEntry = { width, keys: new Map() };
  entry.claims.add(claim);
  entry.peak = Math.max(entry.peak, inUse(entry));
  const handle: DynamicWorkerClaim = {
    release() {
      if (!entry.claims.delete(claim)) return;
      admitWaiters(entry);
    },
  };
  claimEntries.set(handle, { ledger: entry, entry: claim });
  return handle;
}

/** Snapshot for the diag surface. Pure read; no I/O. */
export function loaderLedgerStats(ctx: object): {
  limit: number;
  inFlightWorkers: string[];
  claimed: number;
  headroom: number;
  peak: number;
  /** Waits not yet admitted. */
  waiting: number;
  /** Length of the pause a limit refusal started, while it lasts; 0 when admitting. */
  pauseMs: number;
  /** In-flight worker → the process each hold on it is for (null: no process's). */
  holders: Record<string, Array<number | null>>;
  /** Waits not yet admitted, in order: the worker each waits for, and the process it is for. */
  waiters: Array<{ key: string; pid?: number }>;
  /** Process → its news (ProcessNews): issued, the last report's number, and the frontier it said it is blocked at. */
  news: Record<number, { issued: number; reportSeq: number; blockedAt: number | null }>;
} {
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

function claimedWidth(entry: LoaderLedger): number {
  let width = 0;
  for (const claim of entry.claims) width += claim.width;
  return width;
}

/**
 * Name the per-DO accounting on a "Dynamic worker concurrency limit exceeded"
 * failure; hand every other error back untouched. The platform's message
 * says only that the limit was hit — which workers were in flight, and what
 * fan-outs had claimed, is what the operator needs to know to shrink anything.
 */
export function withDynamicWorkerCapNamed<E>(ctx: object, error: E): E | Error {
  if (classifyError(error) !== 'dynamic_worker_cap') return error;
  const entry = ledger(ctx);
  const platform = error instanceof Error ? error.message : String(error);
  return new Error(
    `${platform} — this Durable Object had ${entry.inFlight.size} distinct dynamic worker(s) in flight `
      + `(${[...entry.inFlight.keys()].join(', ') || 'none recorded'}) and ${claimedWidth(entry)} claimed by fan-outs, `
      + `against a limit of ${DO_DYNAMIC_WORKER_LIMIT}; peak ${entry.peak}`,
    { cause: error },
  );
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
export function assertModuleMapWithinCodeLimit(modules: Record<string, unknown>): void {
  let estimate = 0;
  for (const content of Object.values(modules)) {
    estimate += memberBytes(content, null);
  }
  if (estimate <= DYNAMIC_WORKER_CODE_LIMIT_BYTES) return;

  const encoder = new TextEncoder();
  const sized = Object.entries(modules)
    .map(([name, content]) => ({ name, bytes: memberBytes(content, encoder) }))
    .sort((a, b) => b.bytes - a.bytes);
  const total = sized.reduce((sum, member) => sum + member.bytes, 0);
  const top = sized.slice(0, 5)
    .map(({ name, bytes }) => `'${name}' (${bytes.toLocaleString('en-US')} bytes)`)
    .join(', ');
  throw new Error(
    `Nimbus: dynamic-worker module map is ${total.toLocaleString('en-US')} bytes, over the `
      + `${DYNAMIC_WORKER_CODE_LIMIT_BYTES.toLocaleString('en-US')}-byte platform ceiling shared by `
      + `every member. Largest members: ${top}`,
  );
}

/**
 * Bytes one module-map member carries, across the loader's content kinds
 * (plain string, `{ js | cjs | py | text }`, `{ wasm | data }`, a bare
 * WebAssembly.Module). With an encoder, text is measured exactly; without
 * one, by code-unit length. A compiled module counts the wire size its host
 * described (host-wasm.ts); one nobody described counts nothing here and is
 * left to the platform's own refusal, as the text undercount is.
 */
function memberBytes(content: unknown, encoder: TextEncoder | null): number {
  const textBytes = (text: string): number =>
    encoder ? encoder.encode(text).byteLength : text.length;
  if (typeof content === 'string') return textBytes(content);
  if (content instanceof WebAssembly.Module) return hostWasmIdentity(content)?.bytes ?? 0;
  if (content !== null && typeof content === 'object') {
    for (const value of Object.values(content)) {
      if (typeof value === 'string') return textBytes(value);
      if (value instanceof ArrayBuffer) return value.byteLength;
      if (ArrayBuffer.isView(value)) return value.byteLength;
      if (value instanceof WebAssembly.Module) return hostWasmIdentity(value)?.bytes ?? 0;
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

/** The slice of storage the facet-name ledger persists through. */
interface FacetNameLedgerStorage {
  storage: {
    get(key: string): Promise<unknown> | unknown;
    put(key: string, value: unknown): Promise<void>;
  };
}

/**
 * One hosting actor's durable facet-name count, as an adopt-then-advance
 * chain. It starts as the read of {@link FACET_NAME_HIGH_WATER_KEY} and
 * every later link writes only a LARGER count — a fresh incarnation restarts
 * its slot cursor at zero, and a write that had not adopted first would
 * clobber the lifetime count down to this incarnation's. The chain never
 * rejects.
 */
interface FacetNameLedger {
  chain: Promise<number>;
  /** The largest count the chain has adopted or durably written. */
  known: number;
  /** The largest count ever recorded this incarnation, durable or not. */
  minted: number;
}

const facetNameLedgers = new WeakMap<object, FacetNameLedger>();

function facetNameLedger(ctx: FacetNameLedgerStorage): FacetNameLedger {
  let ledger = facetNameLedgers.get(ctx);
  if (!ledger) {
    const created: FacetNameLedger = { chain: Promise.resolve(0), known: 0, minted: 0 };
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
export function recordFacetNameMinted(ctx: FacetNameLedgerStorage, count: number): void {
  const ledger = facetNameLedger(ctx);
  ledger.minted = Math.max(ledger.minted, count);
  ledger.chain = ledger.chain.then(async (durable) => {
    if (count <= durable) return durable;
    try {
      await ctx.storage.put(FACET_NAME_HIGH_WATER_KEY, count);
    } catch {
      return durable;
    }
    ledger.known = Math.max(ledger.known, count);
    return count;
  });
}

/** The best count available without awaiting storage: minted or adopted. */
export function facetNameCount(ctx: FacetNameLedgerStorage): number {
  const ledger = facetNameLedger(ctx);
  return Math.max(ledger.known, ledger.minted);
}

/** The count with adoption awaited, for a first failure on a fresh boot. */
export async function facetNameCountDurable(ctx: FacetNameLedgerStorage): Promise<number> {
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
export async function facetIdBudget(
  ctx: FacetNameLedgerStorage,
): Promise<{ consumed: number; budget: number }> {
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
export function withFacetBudgetNamed(consumed: number, error: unknown): unknown {
  if (consumed < FACET_ID_LIFETIME_BUDGET) return error;
  const platform = error instanceof Error ? error.message : String(error);
  return new Error(
    `Nimbus: facet creation failed with this Durable Object's `
      + `${FACET_ID_LIFETIME_BUDGET.toLocaleString('en-US')} facet-ID lifetime budget consumed `
      + `(${consumed} facet names ever created). Facet IDs are append-only and never reclaimed, `
      + `so this failure is permanent for the object: ${platform}`,
    { cause: error },
  );
}
