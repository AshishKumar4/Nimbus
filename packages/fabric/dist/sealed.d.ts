/**
 * sealed.ts — prototype-chain RPC sealing, and the versioned surface
 * constants that make it safe to run over the Agents SDK.
 *
 * Cloudflare resolves `stub.foo(...)` on the receiver's PROTOTYPE CHAIN.
 * Proteus verified the three consequences against real workerd
 * (`cf-backend/src/rpc-surface.ts:4-22`, catalog `rpc.prototype_chain`,
 * proven-by-probe): TypeScript `private` is erased, so private methods ARE
 * callable over RPC; superclass methods are reachable too — inherited
 * `Agent.sql` hands any stub-holder arbitrary SQL against the receiver's
 * storage, and `Agent` + `Server` alone contribute hundreds of reachable
 * names; and OWN instance properties are NOT reachable — workerd rejects
 * them exactly as it rejects a missing name, including when the own
 * property shadows a prototype method.
 *
 * That third consequence is the primitive: {@link sealRpcSurface} copies
 * every reachable member that is NOT on the declared surface down onto the
 * instance as a non-enumerable own property. In-process behaviour is
 * unchanged — `this.x(...)` finds the same function object, `super.x()`
 * still reaches the prototype, accessors stay accessors. From outside, the
 * name has ceased to exist. Call it as the LAST statement of the
 * constructor, after every base class installed its wrappers.
 *
 * The surface constants are the part that breaks whenever the SDK moves,
 * which is why fabric owns them: Proteus reverse-engineered its facet
 * surface from `agents/dist` by hand, and a fabric test diffs these
 * constants against the INSTALLED packages so drift is caught by CI, not by
 * a leak. Verified against agents@0.20.1 and partyserver@0.5.10
 * (2026-08-19); an SDK upgrade that changes the cross-stub set fails that
 * test and demands re-derivation, which is the intended failure.
 */
/**
 * Every name RPC can resolve on `target`: own property names of every
 * prototype up to (and excluding) Object.prototype, minus `constructor` and
 * minus anything `target` already carries as an own property — own
 * properties are not RPC-reachable, so they need no seal. The single
 * definition {@link sealRpcSurface} and its tests both work from.
 */
export declare function rpcReachableNames(target: object): string[];
/**
 * Shadow every RPC-reachable member not on `surface` with a non-enumerable
 * own property carrying the SAME descriptor — the same function object, the
 * same accessor pair — so in-process behaviour cannot change while the name
 * stops resolving over RPC. Surface names the class lacks are ignored: a
 * surface is a ceiling, and the runtime already denies what does not exist.
 */
export declare function sealRpcSurface<Instance extends object>(instance: Instance, surface: readonly string[]): void;
/**
 * The platform half of any surface built on partyserver's `Server` (and
 * therefore the Agents SDK's `Agent`): what the RUNTIME and the SDK's own
 * routing must still reach after sealing. From the consumer's verified list
 * (`rpc-surface.ts:63-86`): `setName` is called by `getServerByName` before
 * the stub is returned; `_initAndFetch` is `setName` plus `fetch`, so it
 * exposes nothing new; the WebSocket handlers' arguments cannot cross an
 * RPC boundary anyway.
 */
export declare const PLATFORM_RPC_SURFACE: readonly ["fetch", "setName", "_initAndFetch", "alarm", "webSocketMessage", "webSocketClose", "webSocketError"];
/**
 * The Agents SDK's own cross-stub facet protocol at agents@0.20.1: every
 * `_cf_` method the SDK calls on a receiver that is not `this`, derived
 * from `agents/dist` (the SDK's ACTUAL cross-stub surface, not a prefix
 * rule — Agent's prototype defines 58 `_cf_` methods and only these are
 * cross-called). An Agent that hosts SDK facets must keep these; one that
 * does not (Proteus's UserDO) should not carry them at all.
 */
export declare const AGENTS_FACET_RPC_SURFACE: readonly ["_cf_acquireFacetKeepAlive", "_cf_broadcastToSubAgent", "_cf_cancelScheduleForFacet", "_cf_checkRunFibersForFacet", "_cf_cleanupFacetPrefix", "_cf_closeSubAgentConnection", "_cf_destroyDescendantFacet", "_cf_dispatchScheduledCallback", "_cf_getScheduleForFacet", "_cf_handleSubAgentWebSocketClose", "_cf_handleSubAgentWebSocketConnect", "_cf_handleSubAgentWebSocketMessage", "_cf_initAsFacet", "_cf_listSchedulesForFacet", "_cf_registerFacetRun", "_cf_releaseFacetKeepAlive", "_cf_scheduleEveryForFacet", "_cf_scheduleForFacet", "_cf_sendToSubAgentConnection", "_cf_setSubAgentConnectionState", "_cf_subAgentConnectionMetas", "_cf_unregisterFacetRun"];
/**
 * Cross-stub `_cf_` members deliberately absent from EVERY surface: each
 * takes a method NAME and calls it on the receiver, which would re-open
 * everything sealing closes. Sealing them fail-closes the SDK features
 * built on them (`parentAgent()` proxies, workflow-to-agent bridges) — the
 * consumer accepts exactly that cost, and fail-closed is the right default
 * for a bridge that dispatches arbitrary names. (`_cf_invokeStubMethod` is
 * only ever self-called in the pinned dist, but it is prototype-defined, so
 * it is named here and sealed.)
 */
export declare const AGENTS_INVOKE_BRIDGES: readonly ["_cf_invokeAgentPath", "_cf_invokeStubMethod", "_cf_invokeSubAgent", "_cf_invokeSubAgentPath"];
//# sourceMappingURL=sealed.d.ts.map