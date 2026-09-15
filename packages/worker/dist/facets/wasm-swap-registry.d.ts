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
 *   - rejects: deny list with helpful messages. Every entry is
 *              `transitive: 'fail'` — hard-fail at any depth (top +
 *              transitive). The 'warn' classification is retired:
 *              plain-JS tooling installs, and native shards are caught
 *              by the optional-native-binding classifier instead.
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
 * Return rejects whose policy applies at this depth. Only 'fail'
 * entries exist, so 'top' and 'transitive' are the same set.
 */
export declare function findRejects(specs: Record<string, string>, ctx: 'top' | 'transitive'): PackageRejectEntry[];
/**
 * Single-line yellow notice emitted to onProgress when a swap fires.
 *   `[npm] [swap] esbuild → esbuild-wasm (Native esbuild not available …)`
 */
export declare function formatSwapNotice(s: PackageSwapEntry): string;
/**
 * Single-line yellow notice emitted for a `[skip]`.
 *   `[npm] [skip] fsevents — macOS-only filesystem watcher; never runs in Workers`
 *
 * When the entry carries an actionable suggestion it is appended inline
 * (`… try: <hint>`) — the same line shape for optional-shard skips and
 * required-package skips, so one grep explains every package the install
 * left out.
 */
export declare function formatTransitiveSkip(r: PackageRejectEntry): string;
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
 *   - `transitive-skip` — `from` was dropped silently from the resolved
 *                         tree at depth>0 (policy refusal, optional peer
 *                         in REJECT_INSTALL, or optional native binding).
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
    type: 'advisory';
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
 * Classify a package's published artifacts against the Nimbus ABI policy.
 * Two halves, two install outcomes:
 *
 *   - policyNativeBinAdvisory — any bin target with a native executable
 *     extension (.exe, .node N-API binaries, …). Real npm installs
 *     these: the artifact only fails when invoked, so install keeps the
 *     package and reports an advisory naming the reason.
 *   - policyNativePlatformReject — package.json `os` / `cpu` / `libc`
 *     allowlists. A positive allowlist means the package opts out of
 *     cross-platform installs (npm rejects mismatches with
 *     EBADPLATFORM); no allowlisted platform is executable in Nimbus.
 *     Pure negations (`!win32`) do NOT classify as native — they exclude
 *     platforms without requiring one.
 *
 * Diagnostics always name the package, the artifact class found
 * (policy.nativeArtifactClass), and the artifact kinds Nimbus accepts
 * instead.
 *
 * Serialized into facet preambles — self-contained by contract.
 */
export declare function policyNativeBinAdvisory(policy: PackageAbiPolicy, pkg: PackageBinManifest): PackageRejectEntry | undefined;
/**
 * The install-time refusal half: package.json `os` / `cpu` / `libc`
 * allowlists. A positive allowlist means the package opts out of
 * cross-platform installs — npm rejects mismatches with EBADPLATFORM,
 * and no allowlisted platform is executable in Nimbus. Pure negations
 * (`!win32`) do NOT classify as native — they exclude platforms without
 * requiring one.
 *
 * Serialized into facet preambles — self-contained by contract.
 */
export declare function policyNativePlatformReject(policy: PackageAbiPolicy, pkg: PackageBinManifest): PackageRejectEntry | undefined;
/**
 * Union of the two halves above — kept for the optional-native-binding
 * skip classifier, which treats either native shape as skippable from
 * an optional edge.
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
//# sourceMappingURL=wasm-swap-registry.d.ts.map