/**
 * supervisor-delivery.ts — a process's filesystem mutation, applied at most
 * once however often the platform makes its supervisor send it.
 *
 * The facet → session hop is a Durable Object call the platform drops now
 * and then ("Network connection lost.", `retryable`), and a dropped mutation
 * may or may not have run. So SupervisorRPC mints one delivery id per
 * mutation and re-sends the same one; the host that owns the filesystem
 * applies an id once and answers every repeat from the receipt of the first.
 *
 * The receipts are kept in memory, by the one Durable Object instance that
 * applied them, and never outlive it. A binding carries the incarnation of
 * the instance that minted it (`hostIncarnation` in its props), every
 * delivered envelope carries it back, and an instance refuses — permanently —
 * a delivery minted by any other. A repeat that reaches a restarted instance
 * therefore cannot be applied a second time, and cannot be answered with the
 * dead instance's descriptor numbers. Nothing is lost by that: a process
 * never outlives the instance that spawned it.
 *
 * An answer is held for a bounded time and then dropped, leaving the id as
 * a tombstone: a repeat that arrives later than that — the session stalled —
 * is refused as EIO, outcome unknown, and never applied a second time.
 *
 * The delivered envelope travels under its own op, {@link SUPERVISOR_DELIVER_OP},
 * which a host that predates delivery does not serve. Such a host refuses it —
 * a permanent answer the sender never repeats — rather than applying the
 * mutation without a receipt for its repeat to find.
 */
import type { SupervisorOpDispatch } from './supervisor-op.js';
import { type SupervisorDeliveredOpName, type SupervisorJoinedReadOpName } from './supervisor-ops.js';
import type { WaveMountReach } from '../vfs/sqlite-vfs.js';
export type { SupervisorDeliveredOpName, SupervisorJoinedReadOpName };
/**
 * The delivered mutation `op` names, as this module's own string — a receipt
 * holds that one copy, not the one each envelope arrived with — or undefined
 * for any op that is not delivered once.
 */
export declare function supervisorDeliveredOp(op: string): SupervisorDeliveredOpName | undefined;
/** The op a delivered mutation travels under; the mutation's own op rides in {@link SupervisorDelivery}. */
export declare const SUPERVISOR_DELIVER_OP = "deliverOnce";
/** The joined read `op` names, or undefined for any op that is not one. */
export declare function supervisorJoinedReadOp(op: string): SupervisorJoinedReadOpName | undefined;
/** Settled read retention is owned by the run's existing replay journal. */
export interface ReadRunRetention {
    readonly maxEntries: number;
    readonly maxBytes: number;
    readonly recording: () => boolean;
    /** Called before an over-bound reply is handed to its caller. */
    readonly disqualify: (why: string) => void;
}
/** Which mutation, under which id, for which host instance. The envelope's args are the mutation's. */
export interface SupervisorDelivery {
    readonly op: SupervisorDeliveredOpName;
    /** Minted once per mutation by its sender, and repeated on every attempt. */
    readonly id: string;
    /** The incarnation of the host instance whose binding sent it. */
    readonly hostIncarnation: string;
}
/**
 * What a delivered mutation answers: plain data — a revision, a mutation
 * receipt, a descriptor, a lease, or nothing — which a receipt can hold and
 * hand back unchanged, and which the RPC carries back as it is.
 */
export type SupervisorDeliveryAnswer = undefined | null | boolean | number | string | readonly SupervisorDeliveryAnswer[] | {
    readonly [key: string]: SupervisorDeliveryAnswer;
};
type Answered = SupervisorDeliveryAnswer | Promise<SupervisorDeliveryAnswer>;
/**
 * What one attempt of a delivered mutation met: `applied` (it ran the
 * mutation), `replayed` (answered from the settled receipt of an earlier
 * attempt), `awaited` (joined an earlier attempt still running).
 */
export type DeliveryReceipt = 'applied' | 'replayed' | 'awaited';
/** A delivered mutation's answer, and what this attempt met. */
export interface Delivered {
    readonly receipt: DeliveryReceipt;
    readonly answer: Answered;
}
/** A joined read's answer, and whether this attempt joined one being served. */
export interface JoinedRead {
    readonly joined: boolean;
    readonly answer: ReturnType<SupervisorOpDispatch>;
}
/**
 * `value`, what a delivered mutation's handler returned, as a delivery
 * answer; anything else is refused. Checked where the handler's answer
 * enters the store, so no op can hand a receipt a live object to replay.
 */
export declare function supervisorDeliveryAnswer(value: unknown): Answered;
export interface SupervisorDeliveriesOptions {
    /** How long a receipt answers at least (and at most twice). */
    receiptMs?: number;
    /** How long a tombstone generation fills before it is the older one. */
    tombstoneMs?: number;
    /** Ids a tombstone generation holds before it is the older one. */
    tombstoneLimit?: number;
}
/**
 * One host instance's receipts, and the ids of those it has dropped.
 *
 * Receipts: two generations, the older dropped whenever the newer has been
 * filling for the retention. A receipt answers for at least the retention
 * after it is recorded and at most twice that, so the set is bounded by the
 * rate of mutation over twice the retention. A mutation still running is
 * held apart until it settles, and never ages out while it runs.
 *
 * Tombstones: a dropped receipt leaves its id, hashed, so a repeat that
 * arrives after its answer is gone — the session stalled past the retention
 * — is refused as EIO, outcome unknown, instead of applied a second time.
 * Two generations again, each filling for the tombstone retention or up to
 * its limit, whichever comes first: a tombstone is held for at least one
 * whole generation, and there are never more than twice the limit.
 */
export declare class SupervisorDeliveries {
    private minted;
    private current;
    private previous;
    private rotatedAt;
    private readonly running;
    /** One joined-read index: pending reads, plus bounded replies of journaled runs. */
    private readonly reads;
    /** Open write-wave epochs, by `${pid}:${writer}`: the newest attempt admitted under each. */
    private readonly waveEpochs;
    private tombstones;
    private olderTombstones;
    private tombstonesSince;
    private readonly receiptMs;
    private readonly tombstoneMs;
    private readonly tombstoneLimit;
    constructor(options?: SupervisorDeliveriesOptions);
    /**
     * This instance, as the bindings it mints name it. Minted on first use:
     * a store may be opened where workerd forbids random numbers.
     */
    get incarnation(): string;
    /** Tombstones held, both generations: what their bound is stated against. */
    get tombstoneCount(): number;
    /** Writer activation starts a fresh run; no preceding run's reply can answer it. */
    startReadRun(pid: number, run: string, retention: ReadRunRetention): void;
    /** Rewind/exit releases replies, without an old completion resurrecting them. */
    endReadRun(pid: number, run?: string): void;
    /**
     * Apply `op` for `pid` once per `id`, and answer every repeat with what the
     * first answered — its value, or its failure — applying nothing; a repeat
     * while the first still runs waits for it, and one that arrives after its
     * answer was dropped is refused, EIO, as its outcome is unknown.
     *
     * The receipt is recorded in the turn `apply` returns or throws in, with
     * nothing that can fail between them, so no mutation is ever applied
     * without the receipt that stops its repeat. It keeps the answer as it
     * was given: a repeat only ever arrives while the mutation's caller is
     * still waiting for that answer, so nothing else holds what the mutation
     * made — a descriptor's number, a lease — to change it in the meantime.
     *
     * The caller has already established that `pid` is a live process of this
     * instance; receipts are its, and are consulted only for it.
     *
     * Returns the answer and what this attempt met ({@link DeliveryReceipt}).
     */
    deliver(pid: number, id: string, op: SupervisorDeliveredOpName, apply: () => Answered): Delivered;
    /**
     * Serve read `id` of process `pid` once, however many of its attempts
     * arrive while it is being served. The first runs `read`; a repeat that
     * arrives before it settles is admitted (`admit`: the process is live and
     * is who it says) and answered with the same promise, reading nothing. A
     * read queued here behind the session's read budget, a lazy import or a
     * busy input gate is exactly what the sender's hedge fires on, and joining
     * is what keeps that hedge from reading the same bytes again. A journaled
     * run also retains settled replies until its writer ends: a response lost
     * AFTER the session answered must not consume a second journal occurrence.
     * Non-journaled reads keep their in-flight-only behavior. Exceeding a run's
     * retention bound forbids replay before handing out the reply; it never
     * silently evicts a reply while that run remains replayable.
     *
     * Returns the answer, and whether this attempt joined a read already
     * being served rather than reading.
     */
    joinRead(pid: number, id: string, op: SupervisorJoinedReadOpName, admit: () => void, read: () => ReturnType<SupervisorOpDispatch>, run?: string): JoinedRead;
    /**
     * Open a write-wave epoch for process `pid`: the only writer identity
     * {@link admitWave} admits, for `ttlMs` from now. Its waves are refused
     * once it expires or its process is forgotten, whatever arrives then.
     */
    openWaveWriter(pid: number, ttlMs: number): string;
    /**
     * Admit attempt (`wave`, `attempt`) of a write wave from epoch `writer`,
     * and answer whether it may still commit: it may while the epoch is open
     * and no newer attempt under it has been admitted. Refused, ESTALE, by
     * default: an epoch this instance did not open, or opened and has since
     * expired or forgotten, admits nothing; and an attempt older than one
     * already admitted is one its writer gave up on and re-sent, so applying
     * it could only put back bytes a newer write replaced. `check` is asked
     * again before each of the attempt's commits, which is what stops an
     * attempt overtaken, or outlived by its epoch, while it runs.
     */
    /**
     * `reach`: how far an earlier attempt of this wave may have reached into
     * mounted records, and where this one notes its own (WaveMountReach).
     */
    admitWave(pid: number, writer: string, wave: number, attempt: number): {
        check(): void;
        reach: WaveMountReach;
    };
    /** Reads being served, which repeats of them would join. */
    get readsServing(): number;
    /** Settled receipts kept by active journaled runs, for lifecycle/bound checks. */
    get readReceipts(): number;
    get readReceiptBytes(): number;
    /**
     * Retire process `pid`'s write-wave epoch `writer`: from now on it admits
     * nothing, and an attempt of it already admitted is refused at its next
     * commit (admitWave's check). How a writer that gave a wave up (its fate
     * unknown) keeps a late attempt of it from landing after what it sends next.
     */
    retireWaveWriter(pid: number, writer: string): void;
    /** A process ended: its receipts answer nothing more, their ids stay refused, and its wave epochs close. */
    forget(pid: number): void;
    private record;
    private age;
    private bury;
    private rotateTombstones;
}
/**
 * The delivery store of the Durable Object instance whose state `ctx` is,
 * opened by the host that serves its supervisor ops — once, before it spawns
 * anything, so every binding it mints can name it.
 */
export declare function openSupervisorDeliveries(ctx: object): SupervisorDeliveries;
/**
 * What to spread into the props of a SUPERVISOR binding minted for a process
 * of the instance whose state `ctx` is: its `hostIncarnation`, or nothing
 * when that host applies nothing once — and then the binding sends each
 * mutation once. For process `pid`, a write-wave epoch minted with it
 * (`waveWriter`, at `waveWriterMintedAt`): the process's first wave needs no
 * round trip for one (SupervisorRPC.openWaveWriter).
 */
export declare function supervisorDeliveryProps(ctx: object, pid?: number): {
    hostIncarnation?: string;
    waveWriter?: string;
    waveWriterMintedAt?: number;
};
//# sourceMappingURL=supervisor-delivery.d.ts.map