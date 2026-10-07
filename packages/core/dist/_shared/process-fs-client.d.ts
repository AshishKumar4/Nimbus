/**
 * process-fs-client.ts — a process's filesystem mutations, sent to the
 * session as numbered calls in W7 waves (spike/delegation/MEMO.md, P4b).
 *
 * The one write path of a process: node's fs and a WASI program's syscalls
 * both log here. Each mutation is a syscall record (W7Call, rename,
 * truncate, setattr) the session applies with its own operation of that
 * name, its semantics and its refusals: nothing is an upsert, and nothing
 * makes a parent the program did not make.
 *
 * Intake is synchronous: an op takes the next place in the log and a copy
 * of its bytes in the turn it is made, so the log is program order across
 * every file. Waves carry the log in that order, one in flight at a time:
 * an op made while none is in flight goes out at the end of its turn (a
 * lone op is a wave of one, with no timer), and whatever is made while a
 * wave is out goes in the next, up to W7's bounds.
 *
 * Every wave is numbered under the process's writer epoch (WaveSequence):
 * the session keeps the writer's cursor with each commit, so a wave whose
 * answer was lost is sent again (the lost-call policy, sendWaveAttempts)
 * and answered, never applied twice. A refused op is the session's answer:
 * the op is dropped and the log goes on from the next one. A caller that
 * awaits its op gets the errno; one the program was already told succeeded
 * (a synchronous call: `acknowledged`) is a durability failure, reported at
 * the next effect (takeFailures) and by settle(), which throws naming it.
 * An op whose fate the session cannot answer (its writer epoch gone, a
 * failure that is no verdict) is one too, and the ops after it are sent
 * under a new epoch.
 *
 * Grants (delegations): once a subtree has had GRANT_AFTER mutations, the
 * client takes it (the deepest directory holding them, never the root, a
 * home directory itself or a store the session refuses), and the runtime
 * decides the mutations there itself (holder(), number()): the program is
 * answered at once and the op is logged acknowledged. Nothing of the
 * process's is in flight while a grant is taken: a wave the session began
 * before the subtree was the process's would recall it from the process
 * itself. A recall is answered by sending the log (every op, in order) and
 * then saying so; a grant unused for its idle period is given back, and
 * every one at settle(). A process's calls hold all its delegations
 * (ProcessFiles' process view), so its waves name none. A subtree the
 * session refused is not asked for again.
 */
import { type W7Attrs, type W7Call } from '@nimbus-sh/platform/w7-frame.js';
import type { ExclusiveMutationGrant, RecallKind } from '../runtime/os-contracts.js';
import { type WaveFence, type WaveTimers } from '@nimbus-sh/platform/wave-writer.js';
import type { WriteStreamReceipt } from '../vfs/sqlite-vfs.js';
/** One mutation, as the session applies it: a call, or a rename, truncate or attribute change. */
export type ProcessFsOp = {
    type: 'call';
    call: W7Call;
} | {
    type: 'rename';
    from: string;
    to: string;
} | {
    type: 'truncate';
    path: string;
    size: number;
} | {
    type: 'setattr';
    path: string;
    attrs: W7Attrs;
};
/** What the client asks of the session. */
export interface ProcessFsSession {
    /** A writer epoch (openWaveWriter); null when the session fences nothing (nothing between them loses a call). */
    openWriter(): Promise<string | null>;
    /** One attempt of one wave (SupervisorRPC.writeBatchStream). */
    writeBatchStream(stream: ReadableStream<Uint8Array>, fence?: WaveFence, owner?: string): Promise<unknown>;
    /** Delegations; absent, the process holds none and the session decides every op. */
    readonly grants?: ProcessFsGrantSession;
}
/** The session's delegation calls (fsAcquireExclusiveMutation with `delegate`, fsAwaitRecall, fsRecalled, fsReleaseExclusiveMutation). */
export interface ProcessFsGrantSession {
    acquire(path: string, delegate: {
        reads: boolean;
        inos: number;
        bytes: number;
    }): Promise<ExclusiveMutationGrant>;
    release(owner: string): Promise<void>;
    awaitRecall(owner: string, waitMs: number): Promise<RecallKind | null>;
    recalled(owner: string, kind: RecallKind): Promise<void>;
}
/** A subtree the process holds: what its runtime decides there is the session's answer. */
export interface ProcessFsGrant {
    /** Its root, a storage key. */
    readonly root: string;
    readonly owner: string;
    /** The umask the session applies to the process's creates. */
    readonly umask: number;
}
/** The session's stat of a file a data call published (its receipt, less the path). */
export type ProcessFsReceipt = Omit<WriteStreamReceipt, 'path'>;
/** An op committed: the stat of the file its data call published, when it published one. */
export interface ProcessFsAnswer {
    receipt?: ProcessFsReceipt;
    /** What a session call of its own (ProcessFsClient.call) answered. */
    value?: unknown;
}
/** An op the program was told succeeded that the session refused, or whose fate it could not answer. */
export interface ProcessFsFailure {
    /** The call's name: writeFile, mkdir, rename, … */
    op: string;
    path: string;
    errno: string;
    message: string;
}
export interface ProcessFsClientOptions {
    readonly session: ProcessFsSession;
    /**
     * Timers captured before a program's shims replace the global ones: the
     * resend backoff and a wave's watch run on them, never on the program's.
     */
    readonly timers?: WaveTimers;
    /** The clock (ms) the writer epoch's age is read on. */
    readonly now?: () => number;
    /**
     * Bytes of synchronous ops (`acknowledged`) the client holds unanswered
     * before one more fails ENOMEM: a synchronous loop sends nothing until it
     * yields, so its bytes are all held until then.
     */
    readonly syncCapBytes?: number;
    /** Told of every call the client makes to the session (the invocation budget). */
    readonly charge?: (call: string) => void;
    /** The lost-call policy's timings; tests shorten them. */
    readonly retry?: {
        backoffMs: readonly number[];
        stallMs: number;
        answerDeadlineMs: number;
    };
    /** Mutations in a subtree before the client takes it (GRANT_AFTER). */
    readonly grantAfter?: number;
    /** A grant unused this long is given back (GRANT_IDLE_MS). */
    readonly grantIdleMs?: number;
    /** How long one recall poll waits before asking again. */
    readonly recallPollMs?: number;
    /** Every key that is a home directory itself: never taken. */
    readonly isHomeRoot?: (key: string) => boolean;
    /**
     * Told when a grant ends or is shared (recalled, idle, settled), its log
     * sent: what the runtime decided under `root` is the session's to answer
     * now.
     */
    readonly released?: (root: string) => void;
    /**
     * Called first by every flush (a recall's too): the runtime logs what it
     * still holds unlogged (a file's latest bytes), so the flush sends it.
     */
    readonly drain?: () => void;
}
export interface ProcessFsClient {
    /**
     * Log `op` (its bytes copied now, its place in the log taken now) and
     * answer once the session has it: resolved when committed, rejected with
     * its errno when refused. `acknowledged`: the program was already told
     * it succeeded (a synchronous call), so its refusal is a failure to
     * report and the answer never rejects. A synchronous op past the client's
     * cap throws ENOMEM here, logged nowhere.
     */
    submit(op: ProcessFsOp, options?: {
        acknowledged?: boolean;
    }): Promise<ProcessFsAnswer>;
    /**
     * A mutation no call record carries (a tree's removal, a copy), made by
     * `run` as one session call in its place in the log: once every op logged
     * before it is answered, and before any logged after it is sent.
     * Answers what `run` answers; a failure of an acknowledged one is reported.
     */
    call<T>(name: string, path: string, run: () => Promise<T>, options?: {
        acknowledged?: boolean;
    }): Promise<T>;
    /** Resolves once every op logged so far is answered. */
    flush(): Promise<void>;
    /** The end of the run: everything answered; throws naming every failure not yet taken. */
    settle(): Promise<void>;
    /** The failures not yet reported, taken (the next effect reports them). */
    takeFailures(): ProcessFsFailure[];
    /** Bytes logged and not yet answered. */
    readonly pendingBytes: number;
    /**
     * The grant a mutation at `key` is decided under now (held, not shared),
     * or undefined: the session decides it. Counts the mutation toward taking
     * the subtree.
     */
    holder(key: string): ProcessFsGrant | undefined;
    /** A number for a name made under `grant` (from its reserved range), or undefined once the range is spent. */
    number(grant: ProcessFsGrant): number | undefined;
    /** Draw `bytes` of the storage `grant` reserved; false when it has too few left (the session decides). */
    draw(grant: ProcessFsGrant, bytes: number): boolean;
    /** The grant holding `key` (held, not shared), without counting a mutation. */
    held(key: string): ProcessFsGrant | undefined;
    /** Whether `key` is in a subtree the process holds or shares: what is decided there is not known elsewhere yet. */
    holds(key: string): boolean;
    /** Whether any op is logged and not yet answered. */
    pending(): boolean;
    stats(): ProcessFsStats;
}
export interface ProcessFsStats {
    ops: number;
    waves: number;
    resends: number;
    epochs: number;
    refused: number;
    lost: number;
    maxWaveOps: number;
    grants: number;
    grantsRefused: number;
    recalls: number;
    released: number;
    widened: number;
}
/** A synchronous loop's bytes held at once, at most (ProcessFsClientOptions.syncCapBytes). */
export declare const PROCESS_FS_SYNC_CAP_BYTES: number;
/** The most subtrees one process holds at once; past it, two are widened to their common ancestor. */
export declare const MAX_DELEGATIONS_PER_PROCESS = 8;
/** Mutations in a subtree before the client takes it. */
export declare const GRANT_AFTER = 8;
/** A grant unused this long is given back. */
export declare const GRANT_IDLE_MS = 2000;
export declare function processFsClient(options: ProcessFsClientOptions): ProcessFsClient;
//# sourceMappingURL=process-fs-client.d.ts.map