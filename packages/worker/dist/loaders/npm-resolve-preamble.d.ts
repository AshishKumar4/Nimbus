/**
 * npm-resolve-preamble.ts — preamble injected into IsolatePool isolates
 * that run src/npm/resolve-facet.ts and src/npm/resolve-one-facet.ts.
 *
 * IsolatePool serialises the user function via fn.toString() and runs
 * it inside a dynamic worker. Names referenced by the function at module
 * scope are NOT in that worker's lexical scope at runtime — they must be
 * re-declared in the preamble.
 *
 * The resolver facets reference the following preamble symbols:
 *   - SHOULD_SKIP_PACKAGE(name, frameworkAware) → boolean
 *   - SHOULD_SWAP(name)         → swap entry | undefined
 *   - SHOULD_REJECT_FAIL(name)  → reject entry | undefined
 *   - SHOULD_WARN_SKIP_TRANSITIVE(name) → reject entry | undefined
 *   - NATIVE_EXECUTABLE_REJECT(pkg) → reject entry | undefined
 *   - IS_OPTIONAL_NATIVE_BINDING(pkg) → boolean
 *   - PARSE_SEMVER(v) → [major, minor, patch] | null
 *   - COMPARE_SEMVER(a, b) → number
 *   - SATISFIES_RANGE(version, range) → boolean
 *   - RESOLVE_VERSION(versions, range) → string | null
 *
 * The package-ABI policy block is GENERATED at supervisor module-load
 * time: `PACKAGE_ABI_POLICY` is embedded as JSON and the `policy*`
 * functions are embedded via `fn.toString()`, so the facet decisions are
 * the supervisor's decisions by construction. The parity unit test
 * (`tests/unit/package-abi-policy.mjs`) extracts the injected policy and
 * asserts equality with the supervisor module.
 *
 * The semver helpers are pasted from src/npm/resolver.ts and MUST stay
 * byte-equivalent — divergence would mean the facet picks different
 * versions than the in-supervisor path.
 *
 * Preamble bytes are part of the loader-cache key for IsolatePool —
 * any edit invalidates the warm slot and forces a re-load on next
 * dispatch. Acceptable cost for a one-shot resolver phase.
 */
export declare const NPM_RESOLVE_PREAMBLE: string;
//# sourceMappingURL=npm-resolve-preamble.d.ts.map