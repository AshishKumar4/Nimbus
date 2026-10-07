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
 *   - IS_SEMVER_RANGE(range)    → boolean
 *   - PICK_VERSION(versions, distTags, range) → string | null
 *   - PARSE_REGISTRY_REQUEST(name, range) → { installName, registryName, range, alias }
 *
 * The package-ABI policy block is GENERATED at supervisor module-load
 * time: `PACKAGE_ABI_POLICY` is embedded as JSON and the `policy*`
 * functions are embedded via `fn.toString()`, so the facet decisions are
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

import {
  PACKAGE_ABI_POLICY,
  policyApplyStagedArtifact,
  policyIsOptionalNativeBinding,
  policyLookupReject,
  policyLookupStagedArtifact,
  policyLookupSwap,
  policyNativeBinAdvisory,
  policyNativePlatformReject,
  STAGED_ARTIFACT_BIN_PREFIX,
} from '../facets/wasm-swap-registry.js';
import { NPM_RESOLVE_NODE_IMPORTS, NPM_RESOLVE_SRC } from '../npm/resolve-libs.generated.js';

export const NPM_RESOLVE_PREAMBLE: string = `
${NPM_RESOLVE_NODE_IMPORTS}
// ── Package ABI policy (serialized from src/facets/wasm-swap-registry.ts) ──
// Generated — do not edit here. PACKAGE_ABI_POLICY is the single source
// of truth; tests/unit/package-abi-policy.mjs enforces parity.
const __NIMBUS_PACKAGE_ABI_POLICY = ${JSON.stringify(PACKAGE_ABI_POLICY)};
const __policyLookupSwap = ${policyLookupSwap.toString()};
const __policyLookupReject = ${policyLookupReject.toString()};
const __policyNativePlatformReject = ${policyNativePlatformReject.toString()};
const __policyNativeBinAdvisory = ${policyNativeBinAdvisory.toString()};
const __policyLookupStagedArtifact = ${policyLookupStagedArtifact.toString()};
const __policyApplyStagedArtifact = ${policyApplyStagedArtifact.toString()};
const __policyIsOptionalNativeBinding = ${policyIsOptionalNativeBinding.toString()};
function SHOULD_SWAP(name) {
  return __policyLookupSwap(__NIMBUS_PACKAGE_ABI_POLICY, name);
}
function SHOULD_REJECT_FAIL(name) {
  const r = __policyLookupReject(__NIMBUS_PACKAGE_ABI_POLICY, name);
  if (r && r.transitive === 'fail') return r;
  return undefined;
}
function NATIVE_EXECUTABLE_REJECT(pkg) {
  return __policyNativeBinAdvisory(__NIMBUS_PACKAGE_ABI_POLICY, pkg)
      ?? __policyNativePlatformReject(__NIMBUS_PACKAGE_ABI_POLICY, pkg);
}
function NATIVE_PLATFORM_REJECT(pkg) {
  return __policyNativePlatformReject(__NIMBUS_PACKAGE_ABI_POLICY, pkg);
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

// ── Versions and specs (bundled from @nimbus-sh/core npm-semver.ts, npm-spec.ts) ──
// Generated — do not edit here; tests/unit/npm-semver.mjs asserts the bundle
// answers exactly as the modules do, and that the module these declarations
// make with the facet reads nothing a facet lacks.
${NPM_RESOLVE_SRC}
function PARSE_SEMVER(v) { return __nimbusNpmResolve.parseSemver(v); }
function COMPARE_SEMVER(a, b) { return __nimbusNpmResolve.compareSemver(a, b); }
function SATISFIES_RANGE(version, range) { return __nimbusNpmResolve.satisfiesRange(version, range); }
function RESOLVE_VERSION(versions, range) { return __nimbusNpmResolve.resolveVersion(versions, range); }
function IS_SEMVER_RANGE(range) { return __nimbusNpmResolve.isSemverRange(range); }
function PICK_VERSION(versions, distTags, range) { return __nimbusNpmResolve.pickPackumentVersion(versions, distTags, range); }
function PARSE_REGISTRY_REQUEST(name, range) { return __nimbusNpmResolve.parseRegistryRequest(name, range); }
// ── end npm-resolve preamble ────────────────────────────────────────────
`;
