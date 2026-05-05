/**
 * replica-routing.ts — W12 — DO read replica routing primitives.
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
 *   - ~lambros/Feedback for DO read replication API: replicas error with
 *     "Network connection lost" during high-volume writes. Mitigation:
 *     suspend replicas during npm install / git clone bursts (the
 *     suspension state lives in `replica-suspension.ts`).
 */

/** Result of `classifyReplicaPolicy(pathname, method)`. */
export type ReplicaPolicy =
  /** Always safe on a replica (idempotent reads of soft state). */
  | 'replica-ok'
  /** Safe on a replica IFF the in-memory state needed is already warm. */
  | 'replica-warm-only'
  /** Replica must forward to primary. */
  | 'primary-only'
  /** Replica must forward; the route is a WS upgrade and the replica must
   *  not subscribe its own hibernation handler to a stream the primary
   *  appends to. */
  | 'primary-only-ws';

/** Eventual-consistency tolerance in ms (replica-eligible routes only). */
export interface RoutePolicy {
  policy: ReplicaPolicy;
  /** Max acceptable replication lag for this route, in ms. `null` for
   *  primary-only routes (not replicable). */
  toleranceMs: number | null;
}

const PROCESSES_LOGS_RE = /^\/api\/processes\/\d+\/logs$/;
const PORT_RE = /^\/port\/\d+(\/.*)?$/;
const TWO_SECONDS = 2000;

/**
 * Pure routing decision. Mirrors the route table in W12-plan §2.
 * Methods other than GET/HEAD on a replica-eligible route escape to
 * primary-only — read replicas only make sense for reads.
 */
export function classifyReplicaPolicy(
  pathname: string,
  method: string,
): ReplicaPolicy {
  // ── WS upgrades — must land on primary so hibernation subscriptions
  //    follow the primary's append stream. (Replica acceptWebSocket
  //    would subscribe a doomed replica handler.)
  if (pathname === '/ws') return 'primary-only-ws';
  if (PROCESSES_LOGS_RE.test(pathname)) return 'primary-only-ws';
  if (pathname === '/preview/__nimbus_hmr' || pathname.startsWith('/preview/__nimbus_hmr/')) {
    return 'primary-only-ws';
  }

  // ── Worker / port routes — facets are owned by the primary; no
  //    replica representation. Always primary-only.
  if (pathname === '/worker' || pathname.startsWith('/worker/')) return 'primary-only';
  if (PORT_RE.test(pathname)) return 'primary-only';

  // ── /preview/* — read-mostly after warm. Cold-warm distinction
  //    handled by shouldDelegateToPrimary's `isWarm` input.
  if (pathname === '/preview' || pathname.startsWith('/preview/')) {
    if (!isReadMethod(method)) return 'primary-only';
    return 'replica-warm-only';
  }

  // ── /api/_test/* — test-only endpoints, predictable behaviour > latency.
  if (pathname.startsWith('/api/_test/')) return 'primary-only';

  // ── /api/* read endpoints (replica-ok)
  if (isReadMethod(method)) {
    if (pathname === '/api/memory') return 'replica-ok';
    if (pathname === '/api/_diag/memory') return 'replica-ok';
    if (pathname.startsWith('/api/_diag/')) return 'replica-ok';
    if (pathname === '/api/processes') return 'replica-ok';
    if (pathname === '/api/stats') return 'replica-ok';
  }

  // ── Known write endpoints — primary-only.
  if (pathname === '/api/write-file') return 'primary-only';
  if (pathname === '/api/mkdir') return 'primary-only';
  if (pathname === '/api/start-vite') return 'primary-only';
  if (pathname === '/api/supervisor-rpc') return 'primary-only';

  // Default: anything we don't recognize on a replica goes to primary.
  // Safety > latency. New routes added must be classified explicitly
  // (and the eventual-consistency-window-ms.mjs probe enforces that).
  return 'primary-only';
}

function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

/**
 * Eventual-consistency tolerance per route (in ms).
 *
 * Returns `null` for primary-only routes (not replicable) and a numeric
 * tolerance for replica-eligible routes. The probe
 * `eventual-consistency-window-ms.mjs` enforces that every eligible route
 * has a tolerance ≤ 2000ms.
 *
 * The 2-second budget aligns with D1 read-replication best practice
 * (D1 docs § "Replica lag and consistency model"); DO replicas are
 * the same architectural pattern.
 */
export function getEventualConsistencyToleranceMs(pathname: string): number | null {
  // Re-classify with a synthetic GET to figure out replica eligibility.
  const policy = classifyReplicaPolicy(pathname, 'GET');
  if (policy === 'replica-ok') return TWO_SECONDS;
  if (policy === 'replica-warm-only') return TWO_SECONDS;
  return null;
}

/** Tolerance lookup table (for diagnostics / observability surfaces). */
export const REPLICA_POLICIES: Record<string, RoutePolicy> = {
  '/api/memory':         { policy: 'replica-ok',         toleranceMs: TWO_SECONDS },
  '/api/_diag/memory':   { policy: 'replica-ok',         toleranceMs: TWO_SECONDS },
  '/api/processes':      { policy: 'replica-ok',         toleranceMs: TWO_SECONDS },
  '/api/stats':          { policy: 'replica-ok',         toleranceMs: TWO_SECONDS },
  '/preview/':           { policy: 'replica-warm-only',  toleranceMs: TWO_SECONDS },
  '/ws':                 { policy: 'primary-only-ws',    toleranceMs: null },
  '/api/write-file':     { policy: 'primary-only',       toleranceMs: null },
  '/api/mkdir':          { policy: 'primary-only',       toleranceMs: null },
  '/api/start-vite':     { policy: 'primary-only',       toleranceMs: null },
  '/api/supervisor-rpc': { policy: 'primary-only',       toleranceMs: null },
  '/worker/':            { policy: 'primary-only',       toleranceMs: null },
};

// ────────────────────────────────────────────────────────────────────────
// Replica state — runtime probes
// ────────────────────────────────────────────────────────────────────────

export type ReplicasState =
  | 'enabled'                  // SPEC API present, called successfully
  | 'enabled-via-configure'    // alternate API present, called successfully
  | 'unsupported'              // pre-GA runtime, no API surface
  | 'error';                   // API present but threw

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
export function tryEnableReplicas(ctx: any): TryEnableReplicasResult {
  if (!ctx || !ctx.storage) return { state: 'unsupported', error: null };
  const s = ctx.storage;
  try {
    if (typeof s.enableReplicas === 'function') {
      s.enableReplicas();
      return { state: 'enabled', error: null };
    }
    if (typeof s.configureReadReplication === 'function') {
      s.configureReadReplication({ mode: 'auto' });
      return { state: 'enabled-via-configure', error: null };
    }
    return { state: 'unsupported', error: null };
  } catch (e: any) {
    return { state: 'error', error: e?.message ?? String(e) };
  }
}

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
export function inspectReplicaState(ctx: any): ReplicaStateInspect {
  if (!ctx || !ctx.storage) return { isReplica: false, primary: null, bookmark: null };
  const s = ctx.storage;
  const isReplica = typeof s.primary !== 'undefined' && s.primary !== null;
  let bookmark: string | null = null;
  try {
    if (typeof s.getCurrentBookmark === 'function') {
      const v = s.getCurrentBookmark();
      // The SPEC describes getCurrentBookmark as returning Promise<string>.
      // J.7.1 uses it synchronously — accept either. We only surface
      // string-on-fast-path; promises get null + the operator falls back
      // to the async getReplicaState() variant if needed.
      if (typeof v === 'string') bookmark = v;
    }
  } catch { /* best-effort */ }
  return { isReplica, primary: isReplica ? s.primary : null, bookmark };
}

/**
 * Capture the current bookmark immediately after a write completes on
 * the primary. The caller (e.g. /api/write-file) can stash the result in
 * a response header / cookie so the next read-your-writes call from the
 * same client can wait for the replica to catch up before responding.
 *
 * Phase 1 of W12 surfaces this as observability only (visible via
 * /api/_diag/memory.replica.bookmark). Phase 2 (W12.5 if measured demand)
 * wires the wait-for-bookmark contract end-to-end.
 */
export function captureBookmarkAfterWrite(ctx: any): string | null {
  return inspectReplicaState(ctx).bookmark;
}

// ────────────────────────────────────────────────────────────────────────
// Routing — should we delegate to primary?
// ────────────────────────────────────────────────────────────────────────

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
export function shouldDelegateToPrimary(inputs: DelegationInputs): boolean {
  // Primary never delegates to itself.
  if (!inputs.isReplica) return false;

  // Suspended (write-burst window) — replicas defer everything to primary
  // to avoid the SPEC's "Network connection lost" replication error.
  if (inputs.suspended === true) return true;

  switch (inputs.policy) {
    case 'replica-ok':
      return false;
    case 'replica-warm-only':
      return !inputs.isWarm;
    case 'primary-only':
    case 'primary-only-ws':
      return true;
    default:
      // Defensive: unknown policies fail closed → primary-only.
      return true;
  }
}

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
  decision: DelegationInputs & { pathname: string; method: string };
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
export async function handleReplicaPreflight(
  ctx: any,
  request: Request,
  opts: { isWarm: boolean; suspended?: boolean },
): Promise<PreflightResult> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method;
  const policy = classifyReplicaPolicy(pathname, method);
  const inspect = inspectReplicaState(ctx);
  const decision = {
    isReplica: inspect.isReplica,
    policy,
    isWarm: opts.isWarm,
    suspended: opts.suspended ?? false,
    pathname,
    method,
  };
  const delegate = shouldDelegateToPrimary(decision);
  if (!delegate) {
    return { delegated: false, response: null, decision };
  }
  const primary = inspect.primary;
  if (!primary || typeof primary.fetch !== 'function') {
    // We claimed isReplica but the primary stub isn't usable — fall back
    // to local handling (correctness > performance). Document via
    // decision.suspended for diagnostic surfaces.
    return { delegated: false, response: null, decision };
  }
  // Single intra-region RPC hop. The replica was placed near the primary
  // so this is fast; the user's RTT-to-replica-edge is short anyway.
  const response = await primary.fetch(request);
  return { delegated: true, response, decision };
}
