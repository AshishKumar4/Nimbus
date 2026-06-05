/**
 * npm-resolve-preamble.ts — preamble injected into NimbusLoaderPool isolates
 * that run src/npm-resolve-facet.ts.
 *
 * NimbusLoaderPool serialises the user function via fn.toString() and runs
 * it inside a dynamic worker. Names referenced by the function at module
 * scope are NOT in that worker's lexical scope at runtime — they must be
 * re-declared in the preamble.
 *
 * The resolver-facet references the following preamble symbols:
 *   - SHOULD_SKIP_PACKAGE(name) → boolean
 *   - SHOULD_SWAP(name)         → { from, to } | undefined
 *   - SHOULD_REJECT_FAIL(name)  → { from, reason, suggest? } | undefined
 *   - SHOULD_WARN_SKIP_TRANSITIVE(name) → entry | undefined
 *   - PARSE_SEMVER(v) → [major, minor, patch] | null
 *   - COMPARE_SEMVER(a, b) → number
 *   - SATISFIES_RANGE(version, range) → boolean
 *   - RESOLVE_VERSION(versions, range) → string | null
 *
 * All of these are pasted from src/npm-resolver.ts and src/wasm-swap-registry.ts
 * and MUST stay byte-equivalent. Divergence between supervisor and facet
 * resolution would mean the facet picks different versions / makes different
 * swap-or-reject decisions than the legacy in-supervisor path, breaking
 * both correctness and the NIMBUS_FACET_RESOLVER=0 fallback contract.
 *
 * Registry data is duplicated below and gated by the preamble parity test.
 *
 * Preamble bytes are part of the loader-cache key for NimbusLoaderPool —
 * any edit invalidates the warm slot and forces a re-load on next
 * dispatch. Acceptable cost for a one-shot resolver phase.
 */
export declare const NPM_RESOLVE_PREAMBLE: string;
//# sourceMappingURL=npm-resolve-preamble.d.ts.map