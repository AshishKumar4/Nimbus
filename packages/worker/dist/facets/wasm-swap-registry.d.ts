/**
 * Package ABI policy — WASM swaps, rejected packages, build-only skips,
 * and native-artifact classification.
 *
 * The contract:
 *   - swaps  : name→name rewrite at the resolver/installer boundary.
 *              Only `compat: 'drop-in'` swaps qualify (the consumer's
 *              `require()` call site works unchanged). Different-
 *              require-name candidates (bcrypt → bcryptjs, argon2 →
 *              hash-wasm, …) are NOT swaps until the resolver supports
 *              `npm:` aliases. They live in `rejects` with a
 *              code-change suggestion.
 *
 *   - rejects: deny list with helpful messages. Each entry has a
 *              per-entry `transitive` policy:
 *                'fail' = hard-fail at any depth (top + transitive).
 *                'warn' = top-level fails; transitive logs `[skip]`
 *                         and continues (matches the existing
 *                         `shouldSkipPackage` UX for build-only).
 *
 * IMPORTANT: `PACKAGE_ABI_POLICY` is the single source of truth for the
 * whole npm policy — supervisor AND facets. Generated dynamic-Worker
 * facets cannot `import` this module, so
 * `src/loaders/npm-resolve-preamble.ts` SERIALIZES the policy object
 * (JSON) plus the `policy*` functions below (`fn.toString()`) into the
 * facet preamble at supervisor module-load time. The `policy*` functions
 * must therefore stay self-contained: parameters and globals only — no
 * references to module-scope bindings. The parity unit test
 * (`tests/unit/package-abi-policy.mjs`) extracts the injected policy and
 * asserts equality with this module.
 */
import { type PackageAbiPolicy, type PackageRejectEntry, type PackageStagedArtifactEntry, type PackageSwapEntry } from '@nimbus-sh/core/runtime/os-contracts.js';
/**
 * Sentinel bin target the installer writes for a staged-artifact package.
 * `bin/<name>` is rewritten to `<prefix><artifact-id>`; the .bin runner
 * (init.ts) recognizes the scheme and dispatches the staged opencode bundle
 * through the node runtime instead of trying to exec the native launcher.
 */
export declare const STAGED_ARTIFACT_BIN_PREFIX = "nimbus-staged:";
/**
 * The single typed package-ABI policy (see `PackageAbiPolicy` in
 * runtime/os-contracts.ts). Everything the npm resolver/installer needs
 * to decide swap / reject / skip / native-artifact classification, in
 * one JSON-serializable object.
 */
export declare const PACKAGE_ABI_POLICY: PackageAbiPolicy;
/** Check if a package is build-only (skipped at transitive depth). */
export declare function policyShouldSkipPackage(policy: PackageAbiPolicy, name: string, frameworkAware: boolean): boolean;
export declare function policyLookupSwap(policy: PackageAbiPolicy, name: string): PackageSwapEntry | undefined;
export declare function policyLookupReject(policy: PackageAbiPolicy, name: string): PackageRejectEntry | undefined;
export declare function policyLookupStagedArtifact(policy: PackageAbiPolicy, name: string): PackageStagedArtifactEntry | undefined;
/**
 * Mutate a resolved-package shape so a staged-artifact package installs as
 * a Nimbus JS bundle instead of its native launcher: rewrite `bin` to the
 * single `nimbus-staged:<artifact>` sentinel and drop the platform-native
 * `optionalDependencies` (shards) so the resolver never enqueues them.
 *
 * Self-contained (parameters + globals only) so it serializes into the
 * resolver facet preamble. `pkg` is mutated in place and returned.
 */
export declare function policyApplyStagedArtifact(pkg: {
    bin?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    os?: string[];
    cpu?: string[];
    libc?: string[];
}, entry: PackageStagedArtifactEntry, binPrefix: string): void;
export declare function lookupSwap(name: string): PackageSwapEntry | undefined;
export declare function lookupReject(name: string): PackageRejectEntry | undefined;
export declare function lookupStagedArtifact(name: string): PackageStagedArtifactEntry | undefined;
/** Apply the staged-artifact bin/optionalDeps rewrite in supervisor scope. */
export declare function applyStagedArtifact(pkg: {
    bin?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
}, entry: PackageStagedArtifactEntry): void;
/** Check if a package should be skipped (build-only, types). */
export declare function shouldSkipPackage(name: string): boolean;
/**
 * W11: framework-aware skip variant. When `frameworkAware` is true,
 * packages in `frameworkRequiredPackages` (currently just `vite`) pass
 * through so framework dev binaries can import them from node_modules.
 */
export declare function shouldSkipPackageWithFramework(name: string, frameworkAware: boolean): boolean;
/**
 * Pure: return a new specs map with every swap `from` key rewritten
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
    swaps: PackageSwapEntry[];
};
/**
 * Return rejects whose policy applies at this depth.
 *   ctx='top'        → all matching rejects (any policy).
 *   ctx='transitive' → only `transitive: 'fail'` rejects (the 'warn'
 *                      policy is handled by the caller as a `[skip]`
 *                      log + continue).
 */
export declare function findRejects(specs: Record<string, string>, ctx: 'top' | 'transitive'): PackageRejectEntry[];
/**
 * Lookup that the resolver uses at depth>0 to decide between throw and
 * `[skip]`+continue. Returns the entry only when its policy is 'warn'
 * (i.e., this is a transitive-skip case). 'fail' entries return undefined
 * here; the caller handles those via findRejects/throw.
 */
export declare function shouldWarnSkipTransitive(name: string): PackageRejectEntry | undefined;
/**
 * Single-line yellow notice emitted to onProgress when a swap fires.
 *   `[npm] [swap] esbuild → esbuild-wasm (Native esbuild not available …)`
 */
export declare function formatSwapNotice(s: PackageSwapEntry): string;
/**
 * Multi-line red error thrown when one or more top-level rejects fire.
 * Includes a leading summary line and a `try:` suggestion per package
 * (when present).
 *
 * `devOnly` names the rejects that only a devDependency asked for. Refusing a
 * bundled 150 MB browser is right — a sandbox cannot run it, and fetching it
 * to fail later is the same dishonesty as answering `uname -m` with a value
 * whose binaries cannot execute. But when nothing the project RUNS wanted the
 * package, refusing without naming the flag that skips it leaves the caller
 * stuck at a wall that has a door in it.
 */
export declare function formatRejectError(rejects: ReadonlyArray<PackageRejectEntry>, devOnly?: ReadonlySet<string>): string;
/**
 * Single-line yellow notice emitted for a transitive `[skip]`.
 *   `[npm] [skip] fsevents — macOS-only filesystem watcher; never runs in Workers`
 */
export declare function formatTransitiveSkip(r: PackageRejectEntry): string;
/**
 * Tag class for registry-driven rejects. Both the supervisor-side path
 * (npm-installer.ts and npm-resolver.ts) and the
 * facet-side path (resolve-one-facet.ts:resolveOnePackumentInFacet) throw
 * errors tagged for this case.
 *
 * Supervisor-side: throw `new RegistryRejectError(rejects)` directly.
 * Facet-side: cannot import this class (preamble has no import surface),
 *   so the facet throws `new Error(...)` with `err.__nimbus_registry_reject = true`.
 *   Both are detected via `isRegistryReject()`.
 *
 * The own-property survives worker boundary serialization.
 */
export declare class RegistryRejectError extends Error {
    readonly rejects: ReadonlyArray<PackageRejectEntry>;
    readonly __nimbus_registry_reject: true;
    constructor(rejects: ReadonlyArray<PackageRejectEntry>, devOnly?: ReadonlySet<string>);
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
 * `ResolveOneResult.events` and are flushed by the supervisor
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
/**
 * Minimal manifest shape consumed by the native-artifact classifier.
 * Carries the npm bin map plus the package's platform-constraint
 * metadata.
 */
export interface PackageBinManifest {
    name: string;
    bin?: Record<string, string>;
    os?: string[];
    cpu?: string[];
    libc?: string[];
}
/**
 * Heuristic: does this packument represent a platform-native binding
 * that workerd cannot load?
 *
 * Returns true when ANY of:
 *   - `os`, `cpu`, or `libc` field is non-empty (npm spec platform
 *     constraints — package is opting out of cross-platform installs).
 *   - `main` ends in `.node` (Node.js N-API binary, not workerd-loadable).
 *   - name matches a known native-shard glob
 *     (policy.nativeShardPrefixes).
 *
 * Returns false for pure-JS packages, parent wrappers (e.g. the
 * non-platform `@parcel/watcher` itself), packuments with empty
 * platform-constraint arrays, and exempted pure-WASM builds
 * (policy.nativeShardExemptions).
 *
 * X.5-G G1: the resolver consults this on every packument fetched from
 * a transitive `optionalDependencies` entry. Returns-true → silent-skip
 * (emit a `transitive-skip` RegistryEvent, drop the package from the
 * resolved tree).
 *
 * Serialized into facet preambles — self-contained by contract.
 */
export declare function policyIsOptionalNativeBinding(policy: PackageAbiPolicy, p: MinimalPackument): boolean;
/**
 * Classify a required package's published artifacts against the Nimbus
 * ABI policy and return a reject entry when the package can only run as
 * a native platform binary. Detection is metadata-driven:
 *
 *   - any bin target with a native executable extension
 *     (policy.nativeBinExtensions — .exe Windows executables, .node
 *     N-API binaries, …)
 *   - package.json `os` / `cpu` / `libc` allowlists. A positive
 *     allowlist means the package opts out of cross-platform installs
 *     (npm rejects mismatches with EBADPLATFORM); no allowlisted
 *     platform is executable in Nimbus. Pure negations (`!win32`) do
 *     NOT classify as native — they exclude platforms without
 *     requiring one.
 *
 * Diagnostics always name the package, the artifact class found
 * (policy.nativeArtifactClass), and the artifact kinds Nimbus accepts
 * instead.
 *
 * Serialized into facet preambles — self-contained by contract.
 */
export declare function policyNativeArtifactReject(policy: PackageAbiPolicy, pkg: PackageBinManifest): PackageRejectEntry | undefined;
export declare function isOptionalNativeBinding(p: MinimalPackument): boolean;
export declare function nativeExecutableReject(pkg: PackageBinManifest): PackageRejectEntry | undefined;
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