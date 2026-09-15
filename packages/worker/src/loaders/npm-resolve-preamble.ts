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
 *   - SHOULD_SWAP(name)         → swap entry | undefined
 *   - SHOULD_REJECT_FAIL(name)  → reject entry | undefined
 *   - NATIVE_EXECUTABLE_REJECT(pkg) → reject entry | undefined
 *   - IS_OPTIONAL_NATIVE_BINDING(pkg) → boolean
 *   - PARSE_SEMVER(v) → [major, minor, patch, prerelease[]] | null
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
 * The semver helpers are embedded from src/npm/semver.ts the same way, so
 * the facet picks versions with the supervisor's own implementation.
 *
 * Preamble bytes are part of the loader-cache key for IsolatePool —
 * any edit invalidates the warm slot and forces a re-load on next
 * dispatch. Acceptable cost for a one-shot resolver phase.
 */

import {
  PACKAGE_ABI_POLICY,
  policyApplyStagedArtifact,
  policyIsOptionalNativeBinding,
  policyLookupReject,
  policyLookupStagedArtifact,
  policyLookupSwap,
  policyNativeArtifactReject,
  STAGED_ARTIFACT_BIN_PREFIX,
} from '../facets/wasm-swap-registry.js';
import {
  compareSemver,
  parseSemver,
  resolveVersion,
  satisfiesRange,
  semverComparators,
} from '../npm/semver.js';
import { parseRegistryRequest } from '../npm/resolve-one-facet.js';

export const NPM_RESOLVE_PREAMBLE: string = `
// ── Package ABI policy (serialized from src/facets/wasm-swap-registry.ts) ──
// Generated — do not edit here. PACKAGE_ABI_POLICY is the single source
// of truth; tests/unit/package-abi-policy.mjs enforces parity.
const __NIMBUS_PACKAGE_ABI_POLICY = ${JSON.stringify(PACKAGE_ABI_POLICY)};
const __policyLookupSwap = ${policyLookupSwap.toString()};
const __policyLookupReject = ${policyLookupReject.toString()};
const __policyNativeArtifactReject = ${policyNativeArtifactReject.toString()};
const __policyIsOptionalNativeBinding = ${policyIsOptionalNativeBinding.toString()};
const __policyLookupStagedArtifact = ${policyLookupStagedArtifact.toString()};
const __policyApplyStagedArtifact = ${policyApplyStagedArtifact.toString()};
function SHOULD_SWAP(name) {
  return __policyLookupSwap(__NIMBUS_PACKAGE_ABI_POLICY, name);
}
function SHOULD_REJECT_FAIL(name) {
  const r = __policyLookupReject(__NIMBUS_PACKAGE_ABI_POLICY, name);
  if (r && r.transitive === 'fail') return r;
  return undefined;
}
function NATIVE_EXECUTABLE_REJECT(pkg) {
  return __policyNativeArtifactReject(__NIMBUS_PACKAGE_ABI_POLICY, pkg);
}
function IS_OPTIONAL_NATIVE_BINDING(pkg) {
  return __policyIsOptionalNativeBinding(__NIMBUS_PACKAGE_ABI_POLICY, pkg);
}
function STAGED_ARTIFACT(name) {
  return __policyLookupStagedArtifact(__NIMBUS_PACKAGE_ABI_POLICY, name);
}
const STAGED_ARTIFACT_BIN_PREFIX = ${JSON.stringify(STAGED_ARTIFACT_BIN_PREFIX)};
function STAGED_ARTIFACT_APPLY(pkg, entry) {
  __policyApplyStagedArtifact(pkg, entry, STAGED_ARTIFACT_BIN_PREFIX);
}

// ── Registry telemetry: facet-side event collection ──────────────────────
// The facet cannot import the registry's emitRegistryEvent (preamble has
// no import surface). Instead, decision sites push into a shared
// __pendingEvents array which resolveOnePackumentInFacet returns inside
// ResolveOneResult.events. The supervisor drains it and flushes via
// emitRegistryEvent (npm-installer.ts).
//
// Shape of each entry:
//   { type: 'swap',            from, to,                     ctx: 'transitive' }
//   { type: 'reject',          from, reason, suggest?,       ctx: 'transitive' }
//   { type: 'transitive-skip', from, reason }
//
// Note: ctx is always 'transitive' from this path (the supervisor's
// applyW6Registry handles 'top'-ctx events directly without the facet).
const __pendingEvents = [];
function __EMIT_EVENT(e) { __pendingEvents.push(e); }
function __DRAIN_EVENTS() {
  // Hand ownership to caller; reset for next run (defensive — facet
  // function bodies are re-instantiated per run anyway).
  const out = __pendingEvents.slice();
  __pendingEvents.length = 0;
  return out;
}

// ── Semver (embedded from src/npm/semver.ts) ────────────────────────────
// Generated — do not edit here. npm/semver.ts is the single implementation;
// tests/unit/npm-semver.mjs asserts the embedded functions answer exactly as
// the exported ones do.
${parseSemver.toString()}
${compareSemver.toString()}
${semverComparators.toString()}
${satisfiesRange.toString()}
${resolveVersion.toString()}
// ── Spec parsing (embedded from src/npm/resolve-one-facet.ts) ───────────
// Generated the same way — the facet body references the bare
// parseRegistryRequest binding.
${parseRegistryRequest.toString()}
function PARSE_SEMVER(v) { return parseSemver(v); }
function COMPARE_SEMVER(a, b) { return compareSemver(a, b); }
function SATISFIES_RANGE(version, range) { return satisfiesRange(version, range); }
function RESOLVE_VERSION(versions, range) { return resolveVersion(versions, range); }
// ── end npm-resolve preamble ────────────────────────────────────────────
`;
