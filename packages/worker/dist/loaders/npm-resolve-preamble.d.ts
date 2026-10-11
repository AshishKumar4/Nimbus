/**
 * npm-resolve-preamble.ts — preamble injected into IsolatePool isolates
 * that run src/npm/resolve-facet.ts and src/npm/resolve-one-facet.ts.
 *
 * IsolatePool evaluates a task expression compiled at build time. The
 * resolver's explicit guest-global policy/semver bindings are supplied here.
 *
 * The resolver facets reference the following preamble symbols:
 *   - SHOULD_SWAP(name)         → swap entry | undefined
 *   - SHOULD_REJECT_FAIL(name)  → reject entry | undefined
 *   - NATIVE_EXECUTABLE_REJECT(pkg) → reject entry | undefined
 *   - IS_OPTIONAL_NATIVE_BINDING(pkg) → boolean
 *   - PARSE_SEMVER(v) → [major, minor, patch, prerelease[]] | null
 *   - COMPARE_SEMVER(a, b) → number
 *   - SATISFIES_RANGE(version, range) → boolean
 *   - RESOLVE_VERSION(versions, range) → string | null
 *   - IS_SEMVER_RANGE(range)    → boolean
 *   - PICK_VERSION(versions, distTags, range) → string | null
 *   - PARSE_REGISTRY_REQUEST(name, range) → { installName, registryName, range, alias }
 *
 * The package-ABI policy block is GENERATED at supervisor module-load
 * time: `PACKAGE_ABI_POLICY` is embedded as JSON and the `policy*`
 * functions are compiled with their dependencies at build time, so the facet decisions are
 * the supervisor's decisions by construction. The parity unit test
 * (`tests/unit/package-abi-policy.mjs`) extracts the injected policy and
 * asserts equality with the supervisor module.
 *
 * Versions and specs are npm's own semver and npm-package-arg behind
 * @nimbus-sh/core's npm-semver.ts and npm-spec.ts, which the build bundles
 * into an IIFE (npm/resolve-libs.generated.ts, scripts/bundle-facet-workers.mjs)
 * whose free names are only the builtin imports spliced ahead of it and a
 * facet's globals: the facet picks versions with the supervisor's own code.
 *
 * Preamble bytes are part of the loader-cache key for IsolatePool —
 * any edit invalidates the warm slot and forces a re-load on next
 * dispatch. Acceptable cost for a one-shot resolver phase.
 */
export declare const NPM_RESOLVE_PREAMBLE: string;
//# sourceMappingURL=npm-resolve-preamble.d.ts.map