import { type RecordedResponse } from './stop-replay-contracts.js';
export type { RecordedResponse } from './stop-replay-contracts.js';
export { SUPERVISOR_CALLS_WITHOUT_EFFECTS } from './stop-replay-policy.js';
/** What a call repeats outside the process; unknown names are never safe. */
export declare function supervisorCallEffect(op: string, args: readonly unknown[] | undefined): string | null;
/**
 * A digest of what a value carries, the same for the same contents however it
 * was built: bytes as bytes, strings by UTF-16 unit, objects by sorted key.
 * Two independent FNV-1a lanes, 64 bits: it is to notice a file that changed
 * while a process waited, not to resist a chosen collision.
 */
export declare function answerDigest(value: unknown): string;
export interface Expected {
    digest: string | undefined;
    /** Null: not answered when the run before stopped. */
    completion: number | null;
    response?: RecordedResponse;
}
/** What makes a run after a stop stray: ReplayJournal hands it to the process's owner. */
export type DivergeHandler = (why: string) => void;
/**
 * The session's journal of one process that can stop, across its runs: what
 * each run was answered, and for a run after a stop, what it must be answered
 * again and in which order, up to the boundary (see the header). One per
 * process, created when it launches and closed when it ends.
 */
export declare class ReplayJournal {
    private readonly onDiverge;
    private readonly stallMs;
    /** The run being answered (its writer identity); another run's calls take nothing. */
    private run;
    /** This run's answers, or null once it cannot be replayed (nothing more is recorded). */
    private entries;
    private occurrences;
    private completions;
    /** Why the current run cannot be replayed: the first thing it did outside itself, or a bound. */
    private disqualified;
    private bodies;
    /** Protocol replies are also digested; their replay is owned by the input/output tapes. */
    private protocolReplies;
    diverged: string | null;
    private expected;
    private expectedCompleted;
    /** How many of those the run after the stop has asked for again. */
    private expectedAsked;
    private boundaryPassed;
    private delivered;
    private waiting;
    private atBoundary;
    private stall;
    private recordedBytes;
    private boundaryWait;
    private effectsHeld;
    constructor(onDiverge: DivergeHandler, stallMs?: number);
    /** A run begins: the writer identity its calls carry. */
    start(run: string): void;
    get unreplayable(): string | null;
    bodyStarted(ticket: string, what: string): void;
    bodyFinished(ticket: string): void;
    bodyBytes(n: number): void;
    /** What the guest must have received before it may consume new fd-0 bytes. */
    get observations(): Record<string, number>;
    /** Whether a call made by `run` belongs to the run being answered. */
    admits(run: string | undefined): boolean;
    /** Whether the run being answered may still be stopped and replayed. */
    get replayable(): boolean;
    /**
     * Whether what the run is answered is still journaled: it may yet stop, or
     * it is a run after a stop still short of its boundary.
     */
    get recording(): boolean;
    /**
     * The current run stopped: what it was answered becomes what the next run
     * must be answered again, and what it was still waiting for is answered to
     * the next only past the boundary. Nothing it asked for is answered now.
     */
    stopped(): void;
    /** The process ended: nothing more is answered or held. */
    close(): void;
    /** The current run did something outside itself (or `what` makes it unreplayable): see the class. */
    effect(what: string): Error | null;
    /** RPC hops may deliver the post-read effect before its boundary notice. */
    beforeEffect(what: string): Promise<Error | null>;
    /** The current run cannot be replayed (D1: nothing more is recorded for it). */
    disqualify(why: string): void;
    /** A supervisor call from the process: answered through `dispatch`, journaled, ordered. */
    handle(op: string, args: readonly unknown[] | undefined, run: string | undefined, dispatch: () => Promise<unknown>): Promise<unknown>;
    /**
     * One journaled answer: `produce` yields it (and a recording to keep, for a
     * response); a run after a stop is answered as the run before it was, or it
     * strays. Resolves when the program may have it.
     */
    answer<T>(key: string, what: string, produce: (expected?: Expected) => Promise<T>, record?: (value: T) => RecordedResponse | undefined, observe?: (value: unknown) => unknown): Promise<T>;
    /**
     * The run after a stop reached the read the run before stopped at. It must
     * have asked again for everything the run before was answered by then; an
     * answer still on its way (the run got to the read sooner) is checked when
     * it comes, and given in the run before's order. The program reaches the
     * read synchronously, so it cannot wait here for it: getting to the read
     * before an answer is an order Node can give too.
     */
    boundary(run: string | undefined): Promise<void>;
    /** Whether a run after a stop is still retracing the run before it. */
    get replaying(): boolean;
    private hold;
    /** The answer in turn was given: the next in the run before's order may go. */
    private advance;
    private watch;
    private diverge;
    private failHeld;
}
/** A call's identity across runs: its op and arguments, digested. */
export declare function callKey(op: string, args: readonly unknown[] | undefined): string;
/** A call, for a person: its op and the first path it names. */
export declare function describeCall(op: string, args: readonly unknown[] | undefined): string;
//# sourceMappingURL=stop-replay-journal.d.ts.map