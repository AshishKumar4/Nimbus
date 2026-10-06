/**
 * Delegations, the session's half of the protocol (spike/delegation/MEMO.md):
 * a process holds a subtree as a recallable exclusive-mutation lease
 * (SqliteVFS, ExclusiveMutationOptions.delegation), decides its operations
 * itself, and sends them later as writes under the lease. When another
 * caller's access needs them, the engine recalls the delegation; this is
 * where that recall reaches the holder and where its answer comes back.
 *
 * The holder keeps one recall request outstanding (awaitRecall, a long poll
 * answered with the next recall, or with nothing after `waitMs`). A recall
 * asks it to send what it decided and then either keep sending each
 * operation as it decides it ('share': another caller reads the subtree) or
 * give the subtree up ('revoke': another caller writes it); the holder says
 * it has (recalled). A holder that has not answered within the recall
 * timeout is revoked anyway: its lease ends, so every write it sends later
 * is ESTALE (the lease is the fence), `revoked` is told so the host can stop
 * it, and the caller that recalled it goes on. What it had not sent is lost,
 * as a process's unflushed writes are when it dies: no one observed them.
 *
 * A delegation ends with its holder: releasing the process's scope releases
 * it (its subscriptions are the scope's to dispose).
 */
import type { DelegationTerms } from '../vfs/sqlite-vfs.js';
import type { ExclusiveMutationGrant, RecallKind } from './os-contracts.js';
/**
 * How long a holder has to answer a recall (T): send what it decided and
 * say so. A holder making syscalls answers within one recall round trip and
 * one wave's flush; one that has not answered by then is taken to be unable
 * to (a long computation with nothing sent, the documented limit), and is
 * revoked. Measured live (2026-10-06, six sessions): a one-file wave
 * published alone took 34-66 ms at the median, 40-73 ms at p95, 627 ms at
 * the slowest (the first, which opens the writer); a full wave (1,016
 * files, 4 MiB) is under a second at the measured ingest rate. Five
 * seconds is several times their sum. The core README's process model
 * documents it.
 */
export declare const DELEGATION_RECALL_TIMEOUT_MS = 5000;
/**
 * The session's own stores (engine keys): a process may not hold them, so
 * the session's synchronous use of them (durable launch images, inline wasm
 * images, staged bindings) never meets a delegation. A subtree at or above
 * one is not delegated (EPERM).
 */
export declare const SESSION_KERNEL_ROOTS: readonly string[];
/** How long one awaitRecall waits before it answers that nothing is asked (the holder asks again). */
export declare const DELEGATION_RECALL_POLL_MS = 25000;
/** What the host is told when it must stop a holder that did not answer a recall in time. */
export interface DelegationRevoked {
    readonly pid: number;
    readonly root: string;
    readonly kind: RecallKind;
    readonly reason: string;
}
export interface DelegationsOptions {
    /** Releases the lease `owner` names (the engine's). */
    readonly release: (owner: string) => void;
    /** Told of a holder revoked for not answering, so the host can stop it. */
    readonly revoked?: (event: DelegationRevoked) => void;
    readonly recallTimeoutMs?: number;
}
export declare class Delegations {
    private readonly options;
    private readonly held;
    /** Each holder's leases. */
    private readonly byPid;
    private readonly recallTimeoutMs;
    constructor(options: DelegationsOptions);
    /**
     * Delegate to process `pid`: `acquire` takes the lease with the terms this
     * makes (the process's own bridge, so its path and permission are checked
     * as any lease's). `scope` disposes of it when the process ends.
     */
    grant(pid: number, reads: boolean, acquire: (terms: DelegationTerms) => {
        root: string;
        owner: string;
    }, scope: {
        readonly subscriptions: Set<() => void>;
    }): ExclusiveMutationGrant;
    /** The next recall of `owner`'s delegation, as soon as one is asked; null after `waitMs` with none, or once it has ended. */
    awaitRecall(pid: number, owner: string, waitMs?: number): Promise<RecallKind | null>;
    /** The holder has sent what it decided, and done what recall `kind` asked. */
    recalled(pid: number, owner: string, kind: RecallKind): void;
    /** The holder gives the delegation up (what it decided is sent). */
    release(pid: number, owner: string): void;
    /** Whether `owner` is a delegation `pid` holds (its lease is released here, not by a plain release). */
    holds(pid: number, owner: string): boolean;
    /** The leases of every delegation `pid` holds: what its own calls are made by. */
    heldBy(pid: number): ReadonlySet<string>;
    get size(): number;
    private recall;
    private forget;
    private holderOf;
}
//# sourceMappingURL=delegations.d.ts.map