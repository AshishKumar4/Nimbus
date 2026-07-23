/**
 * process-fabric.ts — the general heavy-process scheduler (peer-DO placement).
 *
 * The kernel already owns a ProcessTable, a fork/exec fabric, a SupervisorRPC
 * syscall channel, and a peer-DO fanout for short idempotent batch work
 * (fanout-pool.ts). This module adds the last step: scheduling LONG-LIVED,
 * MEMORY-HEAVY resident processes onto sibling NimbusSession DOs, because peer
 * Durable Objects have INDEPENDENT workerd process memory budgets — proven
 * live on the prod shape (placement:smart + D1), 8 peers × 150 MiB facets =
 * 1.2 GiB held concurrently, blast radius contained 12/12
 * (scratchpad/ARCHITECTURE-NEXTGEN.md §1).
 *
 * One policy point: runtime specs declare a process class
 * (`light` | `heavy`); `startResidentProcess` places `heavy` on a peer and
 * runs `light` in a local facet exactly as before. There is no per-runtime
 * special case here — opencode's attach TUI is merely the first heavy tenant;
 * clang/wasm-ld and future heavy user programs ride the same seam.
 *
 * Peer topology
 * ─────────────
 * Peers are sibling NimbusSession DOs named `${coordinatorDoId}:proc:${slot}`
 * (same posture as the fanout's `nbf:` siblings — the existing DO namespace
 * binding, no new worker, no config change). A heavy spawn:
 *
 *   1. Probes the candidate peer for its module-scope isolate token
 *      (`_rpcHostProcessProbe`, one RPC, 2–11 ms warm). Two DOs reporting the
 *      same token share one isolate/process; on collision with the
 *      coordinator's own token or another in-use peer token, the scheduler
 *      moves to the next slot (probe-proven trick; co-location is rare —
 *      1 pair in 24 fresh peers). If every probed slot co-locates (e.g.
 *      single-process `wrangler dev`), the last candidate is used anyway:
 *      placement verification is an isolation OPTIMIZATION; lifecycle and
 *      routing semantics do not depend on it.
 *   2. Calls `_rpcHostProcess(stage, …)` on the peer and holds the RPC open
 *      for the process lifetime. The peer boots the process facet from ITS
 *      OWN env.LOADER — so the facet lands in the peer's workerd process —
 *      with the SUPERVISOR binding minted for the COORDINATOR's doId
 *      (`supervisor.doId` override, the same INSTALL-HONESTY routing the npm
 *      fanout ships). Every syscall (VFS read/write, stdout/stderr frames,
 *      stdin pump, port registry) lands on the coordinator: the disk and the
 *      terminal never move.
 *
 * Failure model
 * ─────────────
 * Peer OOM / silent facet reset severs the held-open RPC, which rejects on
 * the coordinator — identical surface to a local facet death. The scheduler
 * MAY respawn the process on a FRESH slot (a new machine lottery, impossible
 * when the facet is pinned to the session DO's process); respawn budget
 * defaults to 1 and is gated on the caller's `shouldRespawn` (a killed /
 * torn-down process never respawns).
 *
 * Lifecycle
 * ─────────
 * The coordinator holds `_rpcHostProcess` open; if the coordinator DO dies,
 * workerd cancels the inbound call on the peer, the peer's held-open
 * startProcess context collapses, and the facet dies with it — a
 * process-hosting peer cannot outlive its parent. Peers store nothing beyond
 * the NimbusSession constructor's isolate-gen counter (the `nbf:` fanout
 * siblings' accepted posture) and idle-evict when their process exits.
 */
import type { OpencodeStageSpec } from '../facets/opencode-staging.js';
/**
 * Memory class of a resident process. Declared by the runtime spec that
 * defines the process kind (e.g. facets/opencode-staging.ts for the staged
 * opencode modes); consumed by exactly one policy point —
 * `ProcessFabric.startResidentProcess`.
 */
export type ProcessClass = 'light' | 'heavy';
/**
 * Distinct peer slots probed before accepting a co-located peer. Co-location
 * is rare (probe: 1 shared pair in 24 fresh peers), so 4 attempts make an
 * undetected-collision spawn vanishingly unlikely while keeping the
 * worst-case spawn overhead to a few warm RPCs.
 */
export declare const HEAVY_PLACEMENT_MAX_ATTEMPTS = 4;
/** Default respawn budget for a heavy process whose peer dies under it. */
export declare const HEAVY_RESPAWN_BUDGET = 1;
/**
 * Lazy module-scope isolate token. Two Durable Objects that report the same
 * token share one isolate — and, since all NimbusSession DOs run the same
 * script, one workerd process. The scheduler compares peer tokens against its
 * own and those already in use to verify a heavy process landed in a distinct
 * process (the probe-proven placement check).
 */
export declare function isolateToken(): string;
/** Structural surface of a NimbusLoadedEntrypoint RPC stub. */
export interface LoadedWorkerEntrypointStub {
    startProcess?: (args?: unknown) => Promise<unknown>;
    handleHttpRequest?: (request: Request) => Promise<Response>;
    fetch?(request: Request): Promise<Response>;
}
export interface NimbusCtxExports {
    SupervisorRPC?: (options: {
        props: {
            doId: string;
            pid: number;
        };
    }) => unknown;
    NimbusLoadedEntrypoint?: (options: {
        props: {
            key: string;
            name: string | null;
            depth: number;
            code: unknown;
            supervisor: {
                doId: string;
                pid: number;
            };
            stage?: OpencodeStageSpec;
        };
    }) => LoadedWorkerEntrypointStub;
}
export declare function getNimbusCtxExports(): NimbusCtxExports;
/**
 * Mint a NimbusLoadedEntrypoint stub for a keyed dynamic worker. The
 * `supervisor` identity controls where the facet's SUPERVISOR binding routes:
 * a peer host passes the COORDINATOR's doId so every syscall lands on the
 * user's session DO, not the peer (the INSTALL-HONESTY posture).
 */
export declare function createLoadedWorkerEntrypoint(ctxExports: NimbusCtxExports, code: unknown, supervisor: {
    doId: string;
    pid: number;
}, name?: string | null, key?: string, stage?: OpencodeStageSpec): Promise<LoadedWorkerEntrypointStub>;
interface PeerNamespace {
    idFromName(name: string): unknown;
    get(id: unknown): unknown;
}
/** Extract the NIMBUS_SESSION peer namespace from a raw env, if present. */
export declare function peerNamespaceFromEnv(env: unknown): PeerNamespace | undefined;
export type ProcessPlacement = {
    kind: 'local';
} | {
    kind: 'peer';
    slot: number;
    peerName: string;
    isolateToken: string;
};
/**
 * Resource handle for one resident process. `done` settles when the process
 * lifecycle ends (clean exit resolves; facet/peer death rejects). The handle
 * is disposable so FacetManager's existing process-resource tracking kills
 * the process the same way it kills local facets: disposal severs the
 * held-open RPC chain (local: the loopback startProcess; peer: the
 * `_rpcHostProcess` call, plus an explicit cancel RPC so the peer tears its
 * facet down deterministically) and blocks any pending respawn.
 */
export declare class ResidentProcessHandle {
    #private;
    readonly done: Promise<void>;
    readonly processClass: ProcessClass;
    /** Current placement; a heavy respawn moves it to the fresh peer. */
    placement: ProcessPlacement;
    /** Peer respawns consumed (heavy only). */
    respawns: number;
    constructor(processClass: ProcessClass, placement: ProcessPlacement, done: Promise<void>, kill: () => void);
    get killed(): boolean;
    /** Idempotent: sever the process's RPC chain and block respawn. */
    kill(): void;
}
export interface ResidentProcessSpawn {
    /** Declared by the runtime spec (e.g. stagedProcessClass). */
    processClass: ProcessClass;
    /** Supervisor-assigned pid of the process entry on the coordinator. */
    pid: number;
    /** Keyed dynamic-worker identity (`nimbus-process:${doId}:${pid}`). */
    workerKey: string;
    /** Staged-artifact spec the facet boots from. */
    stage: OpencodeStageSpec;
    /**
     * Consulted before a heavy respawn: return true only while the process is
     * still expected to run (e.g. its ProcessTable entry is 'running'). A
     * killed or torn-down process must not respawn.
     */
    shouldRespawn?: () => boolean;
}
export declare class ProcessFabric {
    private readonly ctx;
    private readonly ns;
    private readonly coordDoId;
    /** pid → isolate token of the peer currently hosting that process. */
    private readonly tokensInUse;
    /** Monotonic slot counter: respawns and new spawns land on fresh peers. */
    private nextSlot;
    constructor(ctx: DurableObjectState, ns: PeerNamespace | undefined);
    /**
     * Boot a resident staged process and invoke its held-open startProcess.
     * Resolves once the lifecycle is RUNNING (the returned handle's `done`
     * carries the lifecycle promise); rejects on boot/placement failure.
     */
    startResidentProcess(spawn: ResidentProcessSpawn): Promise<ResidentProcessHandle>;
    private _startLocal;
    private _requireNs;
    private _startPeer;
    /**
     * Drive the process on its peer; on peer death, respawn on a FRESH slot
     * (new machine lottery) within the bounded budget. The first placement is
     * pre-verified by _startPeer.
     */
    private _runPeerLifecycle;
    /**
     * Probe successive slots until one reports an isolate token distinct from
     * the coordinator's own and every token already hosting a process. Falls
     * back to the last probed candidate when every attempt co-locates (dev
     * single-process topologies) — see the module header.
     */
    private _placeDistinctPeer;
    /**
     * First contact with a possibly-cold sibling DO: retry transient platform
     * resets with the same bounded policy the fanout peers ship
     * (fanout-pool.ts PEER_TRANSIENT_RESET_RETRIES). Non-transient failures
     * propagate on the first hit.
     */
    private _probePeer;
    /**
     * Deterministic peer kill: a fresh stub to the hosting peer fires
     * `_rpcCancelHostProcess`, which disposes the peer's held-open startProcess
     * stub — the exact teardown FacetManager.kill applies to local facets. The
     * severed RPC then settles the coordinator-side lifecycle, whose respawn
     * gate sees `handle.killed` and stops.
     */
    private _cancelPeer;
}
export {};
//# sourceMappingURL=process-fabric.d.ts.map