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
 */
import { type W7Attrs, type W7Call } from '@nimbus-sh/platform/w7-frame.js';
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
}
/** The session's stat of a file a data call published (its receipt, less the path). */
export type ProcessFsReceipt = Omit<WriteStreamReceipt, 'path'>;
/** An op committed: the stat of the file its data call published, when it published one. */
export interface ProcessFsAnswer {
    receipt?: ProcessFsReceipt;
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
    /** Resolves once every op logged so far is answered. */
    flush(): Promise<void>;
    /** The end of the run: everything answered; throws naming every failure not yet taken. */
    settle(): Promise<void>;
    /** The failures not yet reported, taken (the next effect reports them). */
    takeFailures(): ProcessFsFailure[];
    /** Bytes logged and not yet answered. */
    readonly pendingBytes: number;
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
}
/** A synchronous loop's bytes held at once, at most (ProcessFsClientOptions.syncCapBytes). */
export declare const PROCESS_FS_SYNC_CAP_BYTES: number;
export declare function processFsClient(options: ProcessFsClientOptions): ProcessFsClient;
//# sourceMappingURL=process-fs-client.d.ts.map