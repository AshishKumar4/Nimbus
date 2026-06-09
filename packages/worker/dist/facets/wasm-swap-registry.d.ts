/**
 * WASM swap and rejected-package registry.
 *
 * The contract:
 *   - WASM_SWAPS    : name→name rewrite at the resolver/installer boundary.
 *                     Only `compat: 'drop-in'` swaps qualify (the consumer's
 *                     `require()` call site works unchanged). Different-
 *                     require-name candidates (bcrypt → bcryptjs, argon2 →
 *                     hash-wasm, …) are NOT swaps until the resolver supports
 *                     `npm:` aliases. They live in REJECT_INSTALL with a
 *                     code-change suggestion.
 *
 *   - REJECT_INSTALL: deny list with helpful messages. Each entry has a
 *                     per-entry `transitive` policy:
 *                       'fail' = hard-fail at any depth (top + transitive).
 *                       'warn' = top-level fails; transitive logs `[skip]`
 *                                and continues (matches the existing
 *                                `shouldSkipPackage` UX for build-only).
 *
 * IMPORTANT: This module is the single source of truth in the supervisor
 * isolate. The same data is *duplicated* into
 * `src/loaders/npm-resolve-preamble.ts` because that preamble is shipped
 * into NimbusLoaderPool isolates as a string (cannot `import`). The
 * preamble parity test gates the duplication.
 */
export interface SwapEntry {
    /** Original package name the user (or a transitive dep) asked for. */
    from: string;
    /** Package name we install instead. */
    to: string;
    /** One-line reason shown to the user. */
    reason: string;
    /**
     * 'drop-in' = `require(from)` and `require(to)` work identically — same
     *             export shape.
     * 'shim'    = (reserved) we write package.json `dependencies` so consumer
     *             imports `from`, gets `to`.
     * 'manual'  = (reserved) consumer code change required. Demoted to
     *             REJECT_INSTALL because listing it here would silently break
     *             user code.
     */
    compat: 'drop-in' | 'shim' | 'manual';
}
export interface RejectEntry {
    from: string;
    /** Helpful one-liner. Always actionable. */
    reason: string;
    /** Optional swap-target suggestion shown inline. */
    suggest?: string;
    /**
     * 'fail' = hard-fail at any depth.
     * 'warn' = top-level hard-fails; transitive logs `[skip]` and drops the
     *          package from the resolved tree (matches existing
     *          `shouldSkipPackage` semantics for genuinely-optional natives
     *          like fsevents).
     */
    transitive: 'fail' | 'warn';
}
export declare const WASM_SWAPS: ReadonlyArray<SwapEntry>;
export declare const REJECT_INSTALL: ReadonlyArray<RejectEntry>;
export declare function lookupSwap(name: string): SwapEntry | undefined;
export declare function lookupReject(name: string): RejectEntry | undefined;
/**
 * Pure: return a new specs map with every WASM_SWAPS.from key rewritten
 * to its swap target. Records the swaps actually performed.
 *
 * Idempotent: running on already-swapped specs is a no-op.
 *
 * Range carry-over: the original spec range is preserved on the new key.
 * Future alias support may force pulling the current swap target version,
 * but for now we honour the user's requested range.
 */
export declare function applySwaps(specs: Record<string, string>): {
    specs: Record<string, string>;
    swaps: SwapEntry[];
};
/**
 * Return rejects whose policy applies at this depth.
 *   ctx='top'        → all matching rejects (any policy).
 *   ctx='transitive' → only `transitive: 'fail'` rejects (the 'warn'
 *                      policy is handled by the caller as a `[skip]`
 *                      log + continue).
 */
export declare function findRejects(specs: Record<string, string>, ctx: 'top' | 'transitive'): RejectEntry[];
/**
 * Lookup that the resolver uses at depth>0 to decide between throw and
 * `[skip]`+continue. Returns the entry only when its policy is 'warn'
 * (i.e., this is a transitive-skip case). 'fail' entries return undefined
 * here; the caller handles those via findRejects/throw.
 */
export declare function shouldWarnSkipTransitive(name: string): RejectEntry | undefined;
/**
 * Single-line yellow notice emitted to onProgress when a swap fires.
 *   `[npm] [swap] esbuild → esbuild-wasm (Native esbuild not available …)`
 */
export declare function formatSwapNotice(s: SwapEntry): string;
/**
 * Multi-line red error thrown when one or more top-level rejects fire.
 * Includes a leading summary line and a `try:` suggestion per package
 * (when present).
 */
export declare function formatRejectError(rejects: ReadonlyArray<RejectEntry>): string;
/**
 * Single-line yellow notice emitted for a transitive `[skip]`.
 *   `[npm] [skip] fsevents — macOS-only filesystem watcher; never runs in Workers`
 */
export declare function formatTransitiveSkip(r: RejectEntry): string;
/**
 * Tag class for registry-driven rejects. Both the supervisor-side path
 * (npm-installer.ts and npm-resolver.ts) and the
 * facet-side path (npm-resolve-facet.ts:resolveTreeInFacet) throw errors
 * tagged for this case.
 *
 * Supervisor-side: throw `new RegistryRejectError(rejects)` directly.
 * Facet-side: cannot import this class (preamble has no import surface),
 *   so the facet throws `new Error(...)` with `err.__nimbus_registry_reject = true`.
 *   Both are detected via `isRegistryReject()`.
 *
 * The own-property survives worker boundary serialization.
 */
export declare class RegistryRejectError extends Error {
    readonly rejects: ReadonlyArray<RejectEntry>;
    readonly __nimbus_registry_reject: true;
    constructor(rejects: ReadonlyArray<RejectEntry>);
}
/**
 * Robust check that survives the supervisor↔facet boundary: prototypes
 * are lost across that boundary, so we tag via an own-property.
 */
export declare function isRegistryReject(e: unknown): boolean;
/**
 * The discriminated-union event emitted by the supervisor whenever the
 * registry takes a decision.
 *
 *   - `swap`            — `from` is being installed as `to`. `ctx='top'` means
 *                         user typed `npm install <from>`; `'transitive'`
 *                         means a dep of a dep referenced `from`.
 *   - `reject`          — `from` was rejected with `reason` (and optional
 *                         actionable `suggest`). At `ctx='top'` an error is
 *                         thrown; at `ctx='transitive'` the throw happens
 *                         when the entry's policy is `'fail'`.
 *   - `transitive-skip` — `from` (with `transitive: 'warn'` policy) was
 *                         dropped silently from the resolved tree at depth>0.
 */
export type RegistryEvent = {
    type: 'swap';
    from: string;
    to: string;
    ctx: 'top' | 'transitive';
} | {
    type: 'reject';
    from: string;
    reason: string;
    suggest?: string;
    ctx: 'top' | 'transitive';
} | {
    type: 'transitive-skip';
    from: string;
    reason: string;
};
export type RegistryEventSink = (e: RegistryEvent) => void;
/**
 * Install (or clear, with `null`) the global registry event sink.
 *
 * The sink is a per-isolate singleton. The supervisor isolate's sink does
 * NOT propagate to facet isolates — facet emits travel through
 * `ResolveFacetResult.registryEvents` and are flushed by the supervisor
 * after the facet returns.
 */
export declare function setRegistryEventSink(s: RegistryEventSink | null): void;
export declare function getRegistryEventSink(): RegistryEventSink | null;
/**
 * Forward an event to the sink. Sink throws are caught (telemetry must
 * never break install) and counted.
 */
export declare function emitRegistryEvent(e: RegistryEvent): void;
/**
 * Number of sink invocations that threw (and were caught). Useful for
 * production monitoring (and probes).
 */
export declare function getSinkThrowCount(): number;
/**
 * Minimal shape of a registry packument entry that the helpers below
 * consume. We don't pull from a stricter schema because the registry
 * cache passes string-typed data with optional fields.
 */
export interface MinimalPackument {
    name?: string;
    os?: string[];
    cpu?: string[];
    libc?: string[];
    main?: string;
}
export interface PackageBinManifest {
    name: string;
    bin?: Record<string, string>;
}
/**
 * Heuristic: does this packument represent a platform-native binding
 * that workerd cannot load?
 *
 * Returns true when ANY of:
 *   - `os`, `cpu`, or `libc` field is non-empty (npm spec platform
 *     constraints — package is opting out of cross-platform installs).
 *   - `main` ends in `.node` (Node.js N-API binary, not workerd-loadable).
 *   - name matches a known native-shard glob (see NATIVE_SHARD_PREFIXES).
 *
 * Returns false for pure-JS packages, parent wrappers (e.g. the
 * non-platform `@parcel/watcher` itself), and packuments with empty
 * platform-constraint arrays.
 *
 * X.5-G G1: the resolver consults this on every packument fetched from
 * a transitive `optionalDependencies` entry. Returns-true → silent-skip
 * (emit a `transitive-skip` RegistryEvent, drop the package from the
 * resolved tree).
 */
export declare function isOptionalNativeBinding(p: MinimalPackument): boolean;
export declare function nativeExecutableReject(pkg: PackageBinManifest): RejectEntry | undefined;
/**
 * Select which entries in `peerDependencies` should be auto-installed.
 *
 * npm v7+ default behaviour:
 *   - All `peerDependencies` entries auto-install.
 *   - Entries marked `optional: true` in `peerDependenciesMeta` STILL
 *     auto-install (with `--include=peer` default-on) — but tools may
 *     opt-out with `--no-include=peer`.
 *   - Entries that exist ONLY in `peerDependenciesMeta` (NOT in
 *     `peerDependencies`) are NEVER auto-installed (they're feature-
 *     detect signals, e.g. ts-jest's `esbuild`).
 *
 * X.5-G strict mode (the default here): we only iterate `peerDependencies`
 * keys. peer-meta-only entries are excluded by construction.
 *
 * The `requiredOnly` flag, when true, also filters out entries marked
 * optional in meta — used for transitive (depth>0) enqueue per X5F R2.
 * When false (top-level / X5F R2.5), all `peerDependencies` entries are
 * returned including optional-marked-in-meta ones (npm CLI default).
 */
export declare function selectAutoInstallPeers(pkg: {
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, {
        optional?: boolean;
    }>;
}, opts?: {
    requiredOnly?: boolean;
}): string[];
/**
 * Classification of an install-time error so the supervisor can decide
 * whether to swallow (recoverable) or propagate (real fail).
 *
 *   - 'optional-dep-skip'  — the failed package was an entry in
 *                            `optionalDependencies`; skip silently.
 *   - 'registry-reject'    — RegistryRejectError.
 *   - 'real-resolve-fail'  — anything else; propagate.
 */
export type InstallErrorClass = 'optional-dep-skip' | 'registry-reject' | 'real-resolve-fail';
export declare function classifyInstallError(e: unknown, ctx?: {
    isOptional?: boolean;
}): InstallErrorClass;
//# sourceMappingURL=wasm-swap-registry.d.ts.map