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
/**
 * How long a read lease's holder trusts it after it asked the barrier that
 * confirmed it (ProcessFsClient.readLeased): past it, the holder asks again.
 * A recall its holder does not answer waits at most this long after the
 * confirmation (plus READ_LEASE_MARGIN_MS), never a stopped process: the
 * holder no longer answers from the lease by then. A holder that is not
 * reading (no barrier within it) costs a writer nothing.
 */
export declare const READ_LEASE_TRUST_MS = 500;
/** What a writer waits past a read lease's trust, for the holder's clock against the session's. */
export declare const READ_LEASE_MARGIN_MS = 50;
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
    /**
     * Told of a holder that ended still holding a delegation (killed, or gone
     * without giving it back): what it decided there and had not sent is
     * lost, and the host says so where the process's output goes.
     */
    readonly orphaned?: (event: {
        readonly pid: number;
        readonly root: string;
    }) => void;
    readonly recallTimeoutMs?: number;
}
/** What the session's delegations did since it started (the diag route's). */
export interface DelegationStats {
    readonly held: number;
    readonly grants: number;
    readonly recalls: {
        readonly share: number;
        readonly revoke: number;
    };
    /** Holders revoked for not answering within the recall timeout. */
    readonly timedOut: number;
    /** Read leases granted, recalls of them answered, and recalls whose holder's trust ran out first. */
    readonly reads: {
        readonly granted: number;
        readonly answered: number;
        readonly expired: number;
    };
}
export declare class Delegations {
    private readonly options;
    private readonly held;
    private readonly counts;
    /** Each holder's leases. */
    private readonly byPid;
    /**
     * When each process's read lease was last recalled: it is granted none
     * for READ_LEASE_TRUST_MS after, so the writer's next change (a save is
     * several) waits on no one, and the reader asks at each barrier meanwhile.
     */
    private readonly readRecalled;
    private readonly recallTimeoutMs;
    constructor(options: DelegationsOptions);
    /**
     * Delegate to process `pid`: `acquire` takes the lease with the terms this
     * makes (the process's own bridge, so its path and permission are checked
     * as any lease's). `scope` disposes of it when the process ends.
     */
    grant(pid: number, asked: {
        readonly reads: boolean;
        readonly inos?: number;
        readonly bytes?: number;
    }, acquire: (terms: DelegationTerms) => ExclusiveMutationGrant, scope: {
        readonly subscriptions: Set<() => void>;
    }): ExclusiveMutationGrant;
    /**
     * Process `pid`'s read lease (SqliteVFS.acquireReadLease), confirmed: the
     * one it holds, unless a recall of it is asked, or one `acquire` takes now.
     * Asked at the barrier that brought the holder current (fsAcquire with
     * `lease`), in the same turn, so it is granted at the revision that answer
     * reported. Null when its recall is asked (the holder answers it first).
     */
    readLease(pid: number, acquire: (terms: DelegationTerms) => {
        readonly owner: string;
    }, scope: {
        readonly subscriptions: Set<() => void>;
    }): {
        owner: string;
        trustMs: number;
    } | null;
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
    /**
     * The leases process `pid` holds, as one set for as long as its `scope`
     * lives: a call that began before it took one (a wave in flight when its
     * read lease is granted) is made by that one too.
     */
    holdsOf(pid: number, scope: {
        readonly subscriptions: Set<() => void>;
    }): Set<string>;
    get size(): number;
    stats(): DelegationStats;
    private recall;
    /**
     * A read lease's recall: asked of its holder, and answered, or over once
     * the holder's trust in it has run out (it reads nothing from it by then):
     * the lease ends either way, and no one is stopped. A holder whose trust
     * ran out already is not asked.
     */
    private recallRead;
    private forget;
    private holderOf;
}
//# sourceMappingURL=delegations.d.ts.map