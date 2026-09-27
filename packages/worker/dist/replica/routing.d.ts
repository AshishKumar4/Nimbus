/**
 * replica/routing.ts — W12 — DO read replica routing primitives.
 *
 * Pure module (no `cloudflare:workers` import) so it can be unit-tested
 * under Bun. NimbusSession wraps these helpers in its constructor and
 * `_handleFetch` preflight; everything else is plumbing.
 *
 * Background:
 *   - CF research §G.4 / §J.7.1: DO read replicas (wiki SPEC: STOR/Durable
 *     Objects read replication API). Replicas serve cross-region read-mostly
 *     traffic; writes always run on the primary. The runtime exposes:
 *
 *       ctx.storage.enableReplicas()                — wiki SPEC API
 *       ctx.storage.configureReadReplication(opts)  — alternate API name
 *                                                     observed in J.7.1 sketch
 *       ctx.storage.primary                         — RpcStub-like; undefined
 *                                                     on the primary itself,
 *                                                     defined on replicas
 *       ctx.storage.getCurrentBookmark()            — opaque bookmark for
 *                                                     read-your-writes
 *
 *     We probe each defensively at runtime so this module is forward- and
 *     backward-compatible: pre-GA runtimes lacking the API surface get
 *     `state: 'unsupported'` and the DO behaves exactly as before W12.
 *
 *   - CF docs (workers/configuration/placement/): Smart Placement applies
 *     to fetch handlers, NOT RPC. So Smart Placement on the gateway Worker
 *     pins it near the DO; RPC into the DO is unaffected. DOs themselves
 *     don't move.
 *

 */
/** Result of `classifyReplicaPolicy(pathname, method)`. */
export type ReplicaPolicy = 
/** Always safe on a replica (idempotent reads of soft state). */
'replica-ok'
/** Safe on a replica IFF the in-memory state needed is already warm. */
 | 'replica-warm-only'
/** Replica must forward to primary. */
 | 'primary-only'
/** Replica must forward; the route is a WS upgrade and the replica must
 *  not subscribe its own hibernation handler to a stream the primary
 *  appends to. */
 | 'primary-only-ws';
/**
 * Pure routing decision. Mirrors the route table in W12-plan §2.
 * Methods other than GET/HEAD on a replica-eligible route escape to
 * primary-only — read replicas only make sense for reads.
 */
export declare function classifyReplicaPolicy(pathname: string, method: string): ReplicaPolicy;
export type ReplicasState = 'enabled' | 'enabled-via-configure' | 'unsupported' | 'error';
export interface TryEnableReplicasResult {
    state: ReplicasState;
    error: string | null;
}
/**
 * Best-effort: enable read replicas on this DO instance. Safe to call from
 * the constructor — pre-GA runtimes that lack the API surface no-op.
 *
 * Operators reading `getReplicaState()` (exposed via /api/_diag/memory)
 * see which path was taken.
 */
export declare function tryEnableReplicas(ctx: any): TryEnableReplicasResult;
export interface ReplicaStateInspect {
    isReplica: boolean;
    primary: any | null;
    bookmark: string | null;
}
/**
 * Inspect this isolate's replica state.
 *
 *   - `isReplica` is `true` when `ctx.storage.primary` is defined. (Per
 *     the wiki SPEC: the primary's `storage.primary` is `undefined`;
 *     replica isolates get an RPC stub to the primary here.)
 *   - `primary` is a stub-shaped object on replicas, `null` on primary.
 *   - `bookmark` is `getCurrentBookmark()` if the API is present; `null`
 *     otherwise. Used to thread read-your-writes via headers/cookies
 *     when the SPEC's `waitForBookmark` lands.
 */
export declare function inspectReplicaState(ctx: any): ReplicaStateInspect;
export interface DelegationInputs {
    isReplica: boolean;
    policy: ReplicaPolicy;
    /** Whether this isolate has the in-memory state needed to serve a
     *  `replica-warm-only` route (e.g. ViteDevServer.isRunning). */
    isWarm: boolean;
    /** Whether replicas are globally suspended (npm install / git clone
     *  in flight). When true, replicas always delegate. */
    suspended?: boolean;
}
/**
 * Pure decision: should this isolate forward the Request to the primary
 * via `ctx.storage.primary.fetch(request)`?
 *
 * `false` means "handle locally" (works on both primary and replica).
 * `true` means "delegate" (replica-only; the caller is responsible for
 * actually invoking `ctx.storage.primary.fetch(...)`).
 */
export declare function shouldDelegateToPrimary(inputs: DelegationInputs): boolean;
/** Result of `handleReplicaPreflight`. */
export interface PreflightResult {
    /** True iff the caller should NOT invoke the local route handlers and
     *  return `response` as-is. False means "fall through to local handling
     *  as today." */
    delegated: boolean;
    /** When `delegated === true`, the Response from the primary. When
     *  `delegated === false`, `null`. */
    response: Response | null;
    /** The decision inputs, surfaced for diagnostic logging / tests. */
    decision: DelegationInputs & {
        pathname: string;
        method: string;
    };
}
/**
 * High-level preflight: classify the request, decide whether to delegate,
 * and (if so) actually call `ctx.storage.primary.fetch(request)` and
 * return the response.
 *
 * Caller pattern in NimbusSession._handleFetch:
 *
 *   const pre = await handleReplicaPreflight(this.ctx, request, {
 *     isWarm: this.viteDevServer?.isRunning ?? false,
 *   });
 *   if (pre.delegated) return pre.response!;
 *   // … existing route handlers …
 *
 * Note: the request is forwarded by reference (Request objects are
 * single-consumption — the caller MUST NOT have read the body already).
 */
export declare function handleReplicaPreflight(ctx: any, request: Request, opts: {
    isWarm: boolean;
    suspended?: boolean;
}): Promise<PreflightResult>;
//# sourceMappingURL=routing.d.ts.map