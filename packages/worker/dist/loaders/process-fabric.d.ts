/**
 * process-fabric.ts — the resident-process scheduler (peer-DO placement).
 *
 * Every long-lived process Nimbus runs — node servers, python/ruby socket
 * servers, the opencode TUI and its headless server — is a Worker Loader
 * facet. This module owns WHICH workerd process that facet lands in, and it
 * is the only place in the kernel that knows the answer.
 *
 *   local  — the facet is minted from the coordinator session DO's own
 *            env.LOADER, so it shares the coordinator's workerd process
 *            memory envelope with the DO and every other local facet.
 *   peer   — the facet is minted from a sibling DO's loader
 *            (`${coordinatorDoId}:proc:${slot}`), so it gets an INDEPENDENT
 *            workerd memory budget. Measured once on the prod shape under
 *            synthetic load: 8 peers × ~150 MiB held concurrently, and a peer
 *            OOM left its siblings and the coordinator running in 12 of 12
 *            checks. The live opencode gate that followed was weaker — 1 of
 *            its 12 runs reset the session, unattributed. Both numbers come
 *            from probe deployments since deleted; neither report is in the
 *            repo.
 *
 * In BOTH cases the facet's SUPERVISOR binding is minted for the COORDINATOR's
 * doId, so every syscall — VFS read/write, stdout/stderr frames, stdin pump,
 * registerPort, loopback HTTP — lands on the user's session DO. The disk and
 * the terminal never move. Peer placement changes only which workerd process
 * runs the compute and holds the resident memory.
 *
 * Placement is INVISIBLE above this module. A `ResidentProcessHandle` exposes
 * the same lifecycle for either placement — `booted()` for the boot payload,
 * `done` for death, `kill()` for teardown — so the process table, stdio, the
 * shell and the SDK never learn where a process runs.
 *
 * Placement constraint: a peer cannot serve inbound HTTP
 * ─────────────────────────────────────────────────────
 * `routeTarget` is the ONE part of the handle that placement is not invisible
 * to. A dynamically-loaded facet cannot be re-entered to serve an inbound
 * request when it lives on a peer: the peer calling into its own facet's HTTP
 * handler throws `DataCloneError: Entrypoints to dynamically-loaded workers
 * cannot be transferred to other Workers` (raised in
 * `NimbusLoadedEntrypoint.handleHttpRequest`, `session/bindings.ts`). A clean
 * same-build A/B pins it to placement alone: the same server declared `light`
 * returns 200 byte-exact, declared `heavy` returns 502. Buffering the response
 * into peer-owned bytes, transferring native Request/Response, delivering the
 * request from inside the owning `_rpcHostProcess` invocation, and minting the
 * route stub together with the boot spec were each eliminated by experiment —
 * the underlying workerd mechanism is still unexplained.
 *
 * So: a process that serves inbound HTTP must be `light`. `routeThroughPeer`
 * below is the mechanism a fix would restore; until then no heavy-class
 * primitive may bind into PortRegistry.
 *
 * Policy
 * ──────
 * One field, one policy point. Each launch primitive DECLARES a
 * `processClass` where it is defined, and `startResidentProcess` is the only
 * consumer. There is no command-name or argv matching anywhere in this file.
 * A primitive is `heavy` when it is both RESIDENT (it accumulates memory over
 * its lifetime and is worth a whole workerd process) and NON-SERVING (nothing
 * routes inbound HTTP into it). Exactly one primitive qualifies today: the
 * opencode attach TUI, which talks to the user over the terminal RPC and the
 * stdin pump and binds no port. Everything else is `light` — node/vite/
 * wrangler/python/ruby servers and opencode `server` mode all bind ports, and
 * a one-shot command returns promptly and never reaches this module at all.
 *
 * Boot specs
 * ──────────
 * A resident process boots from one of two specs, both small enough to cross
 * the placement boundary:
 *
 *   staged — an OpencodeStageSpec. The ~23 MB artifact module map is
 *            assembled by the HOST inside a stateless NimbusLoadedEntrypoint
 *            isolate on the Worker-Loader cache-miss path, never in a session
 *            DO (which OOM-reset at the isolate cap when it did).
 *   code   — a generated module map (node / python / ruby runners). Module
 *            TEXT rides inline; wasm sidecars ride BY VFS PATH and are
 *            materialized by the HOST from the coordinator's disk. A ruby
 *            server's `ruby+stdlib.wasm` alone is 34.3 MiB — past workerd's
 *            32 MiB RPC argument limit — so shipping bytes was never an
 *            option, and resolving them host-side keeps them out of the
 *            coordinator's isolate entirely.
 *
 * Peer topology
 * ─────────────
 * Peers are sibling NimbusSession DOs named `${coordinatorDoId}:proc:${slot}`
 * (the same posture as the fanout's `nbf:` siblings — the existing DO
 * namespace binding, no new worker, no config change). A peer spawn:
 *
 *   1. Probes the candidate peer for its module-scope isolate token
 *      (`_rpcHostProcessProbe`, one RPC, 2–11 ms warm). Two DOs reporting the
 *      same token share one isolate/process; on collision with the
 *      coordinator's own token or another in-use peer token, the scheduler
 *      moves to the next slot (co-location is rare — 1 pair in 24 fresh
 *      peers). If every probed slot co-locates (e.g. single-process
 *      `wrangler dev`), the last candidate is used anyway: placement
 *      verification is an isolation OPTIMIZATION; lifecycle and routing
 *      semantics do not depend on it.
 *   2. Holds `_rpcHostProcess` open for the process lifetime. The peer boots
 *      the facet from ITS OWN env.LOADER and retains the facet's resources
 *      for as long as that call is open.
 *
 * Failure model
 * ─────────────
 * A peer OOM or silent facet reset severs the held-open RPC, which rejects on
 * the coordinator — the identical surface to a local facet death. The
 * scheduler MAY respawn the process on a FRESH slot (a new machine lottery,
 * impossible when the facet is pinned to the session DO's process); the
 * respawn budget defaults to 1, is gated on the caller's `shouldRespawn`, and
 * is always surfaced through `onRespawn` so a peer death is never silent.
 * A peer death is a PROCESS death, never a session death.
 *
 * Lifecycle
 * ─────────
 * The coordinator holds `_rpcHostProcess` open; if the coordinator DO dies,
 * workerd cancels the inbound call on the peer, the peer disposes the facet's
 * retained resources, and the facet dies with it — a process-hosting peer
 * cannot outlive its parent. Peers store nothing beyond the NimbusSession
 * constructor's isolate-gen counter (the `nbf:` fanout siblings' accepted
 * posture) and idle-evict when their process exits.
 */
import { z } from 'zod/v4';
import { type OpencodeStageSpec } from '../facets/opencode-staging.js';
import type { RouteableFacetTarget } from '../runtime/port-registry.js';
/**
 * Memory class of a resident process. Declared by the launch primitive that
 * defines the process kind (`facets/opencode-staging.ts` for the staged
 * opencode modes, `facets/manager.ts` for the node/worker spawn primitives);
 * consumed by exactly one policy point — `ProcessFabric.startResidentProcess`.
 */
export type ProcessClass = 'light' | 'heavy';
/**
 * Runner contract for `startProcess()`. A property of the generated runner,
 * not of placement:
 *
 *   lifetime — the call is held open for the process's whole life and settles
 *              only at exit (opencode attached + server, attached-TTY node).
 *   boot     — the call returns a boot payload once the process is up and the
 *              facet stays resident behind its retained resources (node
 *              servers, the python/ruby socket runners).
 */
export type StartContract = 'lifetime' | 'boot';
/**
 * A generated module map in the form that crosses a placement boundary.
 * Module TEXT rides inline; wasm images are named by VFS path and read by the
 * NimbusLoadedEntrypoint that loads the facet — never by a session DO.
 */
export declare const ResidentCodeSpecSchema: z.ZodObject<{
    compatibilityDate: z.ZodString;
    compatibilityFlags: z.ZodArray<z.ZodString>;
    mainModule: z.ZodString;
    modules: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        wasm: z.ZodCustom<ArrayBuffer, ArrayBuffer>;
    }, z.core.$strip>]>>;
    vfsWasmModules: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}, z.core.$strip>;
export type ResidentCodeSpec = z.infer<typeof ResidentCodeSpecSchema>;
export declare const ResidentBootSpecSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"staged">;
    stage: z.ZodObject<{
        mode: z.ZodEnum<{
            oneshot: "oneshot";
            attached: "attached";
            server: "server";
        }>;
        argv: z.ZodArray<z.ZodString>;
        env: z.ZodRecord<z.ZodString, z.ZodString>;
        cred: z.ZodObject<{
            uid: z.ZodNumber;
            gid: z.ZodNumber;
            groups: z.ZodArray<z.ZodNumber>;
            umask: z.ZodNumber;
        }, z.core.$strip>;
        cwd: z.ZodString;
        stdin: z.ZodString;
        vfsBundle: z.ZodString;
        vfsManifest: z.ZodString;
        vfsMetadata: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"code">;
    code: z.ZodObject<{
        compatibilityDate: z.ZodString;
        compatibilityFlags: z.ZodArray<z.ZodString>;
        mainModule: z.ZodString;
        modules: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            wasm: z.ZodCustom<ArrayBuffer, ArrayBuffer>;
        }, z.core.$strip>]>>;
        vfsWasmModules: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, z.core.$strip>;
}, z.core.$strip>], "kind">;
export type ResidentBootSpec = z.infer<typeof ResidentBootSpecSchema>;
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
            residentCode?: ResidentCodeSpec;
        };
    }) => LoadedWorkerEntrypointStub;
}
export declare function getNimbusCtxExports(): NimbusCtxExports;
/**
 * Mint a NimbusLoadedEntrypoint stub for a keyed dynamic worker. The
 * `supervisor` identity controls where the facet's SUPERVISOR binding routes:
 * a peer host passes the COORDINATOR's doId so every syscall lands on the
 * user's session DO, not the peer.
 */
export declare function createLoadedWorkerEntrypoint(ctxExports: NimbusCtxExports, code: unknown, supervisor: {
    doId: string;
    pid: number;
}, name?: string | null, key?: string, boot?: ResidentBootSpec): Promise<LoadedWorkerEntrypointStub>;
/** Everything a host needs to boot one resident process. */
export interface ResidentHost {
    /**
     * The HOSTING DO's own ctx.exports — this is what decides which workerd
     * process the facet lands in.
     */
    ctxExports: NimbusCtxExports;
    /** Always the COORDINATOR's identity, whichever DO is hosting. */
    supervisor: {
        doId: string;
        pid: number;
    };
    workerKey: string;
}
/** A booted facet, owned by its host. */
export interface HostedResidentProcess {
    /** Invoke the runner's startProcess; see StartContract. */
    start(args: unknown): Promise<unknown>;
    /** Re-resolvable inbound-HTTP target for the running facet. */
    route: RouteableFacetTarget;
    /** Release the resources pinning the facet — the facet dies with them. */
    dispose(): void;
}
/**
 * Boot a resident process's facet on THIS host. Identical code runs on the
 * coordinator (local placement) and on a peer DO (peer placement); the only
 * difference is whose `ctx.exports` — and therefore whose workerd process —
 * is handed in.
 *
 * Both spec kinds take the SAME route: the module map is completed inside the
 * stateless NimbusLoadedEntrypoint that loads it, never in a session DO. That
 * is a workerd requirement as much as a memory one — a dynamic worker loaded
 * directly from a Durable Object cannot be re-entered from a later request
 * ("the system does not know how to reload this Worker from scratch; have the
 * parent Worker expose an entrypoint which constructs the dynamic worker"), so
 * a DO-loaded facet could never serve its registered port.
 */
export declare function hostResidentProcess(host: ResidentHost, boot: ResidentBootSpec): Promise<HostedResidentProcess>;
/** Options the coordinator hands a hosting peer. */
export interface HostProcessOpts {
    coordinatorDoId: string;
    pid: number;
    workerKey: string;
    startContract: StartContract;
    startArgs?: unknown;
}
interface PeerNamespace {
    idFromName(name: string): unknown;
    get(id: unknown): unknown;
}
/** Extract the NIMBUS_SESSION peer namespace from a raw env, if present. */
export declare function peerNamespaceFromEnv(env: unknown): PeerNamespace | undefined;
type ProcessPlacement = {
    kind: 'local';
} | {
    kind: 'peer';
    slot: number;
    peerName: string;
    isolateToken: string;
};
/**
 * Resource handle for one resident process — the whole surface the kernel
 * above this module sees. Its lifecycle is placement-free: `booted`, `done`
 * and `kill` behave identically whether the facet runs in the coordinator's
 * workerd process or a sibling's. `routeTarget` is the exception — see the
 * placement constraint at the top of this file.
 *
 * `done` settles when the process's HOST context ends: for a `lifetime`
 * runner that is the process exiting (resolve) or dying (reject); for a
 * `boot` runner it is the facet dying under it, which locally is only
 * observable at kill time and on a peer is the severed host RPC.
 *
 * The handle is disposable so FacetManager's existing per-pid resource
 * tracking kills a hosted process exactly the way it kills a local facet.
 */
export declare class ResidentProcessHandle {
    #private;
    readonly done: Promise<void>;
    readonly processClass: ProcessClass;
    /**
     * Inbound-HTTP target for PortRegistry; follows the process across respawns.
     * Usable only on a `light` handle — a peer-hosted facet cannot be re-entered
     * to serve an inbound request (placement constraint, top of this file), so
     * no heavy-class primitive may bind this into PortRegistry.
     */
    readonly routeTarget: RouteableFacetTarget;
    /** Peer respawns consumed (heavy only). */
    respawns: number;
    constructor(init: {
        processClass: ProcessClass;
        placement: () => ProcessPlacement;
        done: Promise<void>;
        booted: () => Promise<unknown>;
        routeTarget: RouteableFacetTarget;
        kill: () => void;
    });
    /**
     * The runner's startProcess payload. The runner is started as part of the
     * spawn, so this is a handle on that one boot — awaiting it twice is safe
     * and never re-starts anything. For a `lifetime` runner it settles at exit.
     */
    booted(): Promise<unknown>;
    get killed(): boolean;
    /**
     * Human-readable placement, for the NIMBUS_DEBUG process-log line. Callers
     * log the string; they never branch on it — placement stays in here.
     */
    describePlacement(): string;
    /** Idempotent: sever the process's RPC chain and block respawn. */
    kill(): void;
}
export interface ResidentProcessSpawn {
    /** Declared by the launch primitive that defines this process kind. */
    processClass: ProcessClass;
    /** Declared by the runner the primitive generates. */
    startContract: StartContract;
    /** Supervisor-assigned pid of the process entry on the coordinator. */
    pid: number;
    /** Keyed dynamic-worker identity (`nimbus-process:${doId}:${pid}`). */
    workerKey: string;
    /** What the facet boots from. */
    boot: ResidentBootSpec;
    /** Forwarded verbatim to the runner's startProcess, and replayed on respawn. */
    startArgs?: unknown;
    /**
     * Consulted before a respawn: return true only while the process is still
     * expected to run (e.g. its ProcessTable entry is 'running'). A killed or
     * torn-down process must not respawn.
     */
    shouldRespawn?: () => boolean;
    /**
     * Invoked after a host death when a respawn WILL be attempted, with the
     * error that killed the previous host. Callers surface it to the process
     * log so a death-plus-recovery is never silent.
     */
    onRespawn?: (cause: unknown) => void;
}
export declare class ProcessFabric {
    private readonly ctx;
    private readonly ns;
    private readonly coordDoId;
    /** pid → isolate token of the peer currently hosting that process. */
    private readonly tokensInUse;
    /** Monotonic slot counter: respawns and new spawns land on fresh peers. */
    private nextSlot;
    constructor(ctx: DurableObjectState, env: unknown);
    /**
     * Boot a resident process and return its placement-free handle. Resolves
     * once the facet is hosted and the runner has been started; rejects on
     * boot/placement failure, matching a local boot failure's surface.
     *
     * THE policy point: one field read, no matching of any kind.
     */
    startResidentProcess(spawn: ResidentProcessSpawn): Promise<ResidentProcessHandle>;
    private _startLocal;
    private _localHost;
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
     * `_rpcCancelHostProcess`, which disposes the peer's retained facet
     * resources — the exact teardown a local facet gets. The severed RPC then
     * settles the coordinator-side lifecycle, whose respawn gate sees
     * `handle.killed` and stops.
     */
    private _cancelPeer;
}
export {};
//# sourceMappingURL=process-fabric.d.ts.map