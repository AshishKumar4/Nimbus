/**
 * npm-resolve-preamble.ts — preamble injected into LoaderPool isolates
 * that run src/npm/resolve-facet.ts and src/npm/resolve-one-facet.ts.
 *
 * LoaderPool serialises the user function via fn.toString() and runs
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
 * Preamble bytes are part of the loader-cache key for LoaderPool —
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
  policyShouldSkipPackage,
  STAGED_ARTIFACT_BIN_PREFIX,
} from '../facets/wasm-swap-registry.js';

export const NPM_RESOLVE_PREAMBLE: string = `
// ── Package ABI policy (serialized from src/facets/wasm-swap-registry.ts) ──
// Generated — do not edit here. PACKAGE_ABI_POLICY is the single source
// of truth; tests/unit/package-abi-policy.mjs enforces parity.
const __NIMBUS_PACKAGE_ABI_POLICY = ${JSON.stringify(PACKAGE_ABI_POLICY)};
const __policyShouldSkipPackage = ${policyShouldSkipPackage.toString()};
const __policyLookupSwap = ${policyLookupSwap.toString()};
const __policyLookupReject = ${policyLookupReject.toString()};
const __policyNativeArtifactReject = ${policyNativeArtifactReject.toString()};
const __policyIsOptionalNativeBinding = ${policyIsOptionalNativeBinding.toString()};
const __policyLookupStagedArtifact = ${policyLookupStagedArtifact.toString()};
const __policyApplyStagedArtifact = ${policyApplyStagedArtifact.toString()};
function SHOULD_SKIP_PACKAGE(name, frameworkAware) {
  return __policyShouldSkipPackage(__NIMBUS_PACKAGE_ABI_POLICY, name, !!frameworkAware);
}
function SHOULD_SWAP(name) {
  return __policyLookupSwap(__NIMBUS_PACKAGE_ABI_POLICY, name);
}
function SHOULD_REJECT_FAIL(name) {
  const r = __policyLookupReject(__NIMBUS_PACKAGE_ABI_POLICY, name);
  if (r && r.transitive === 'fail') return r;
  return undefined;
}
function SHOULD_WARN_SKIP_TRANSITIVE(name) {
  const r = __policyLookupReject(__NIMBUS_PACKAGE_ABI_POLICY, name);
  if (r && r.transitive === 'warn') return r;
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

// ── Semver helpers (pasted from src/npm-resolver.ts:83-202) ─────────────
function PARSE_SEMVER(v) {
  const m = v.replace(/^v/, '').match(/^(\\d+)\\.(\\d+)\\.(\\d+)/);
  return m ? [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])] : null;
}

function COMPARE_SEMVER(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function __SATISFIES_COMPARATOR(version, comparator) {
  const comp = comparator.trim();
  if (!comp || comp === '*' || comp === 'latest' || comp === '' || comp === 'x') return true;
  let op = '';
  let rangeStr = comp;
  const prefixMatch = comp.match(/^([~^]|>=|<=|>|<|=)\\s*/);
  if (prefixMatch) {
    op = prefixMatch[1];
    rangeStr = comp.slice(prefixMatch[0].length);
  }
  rangeStr = rangeStr.replace(/\\.x/g, '.0');
  if (rangeStr.match(/^\\d+$/)) rangeStr += '.0.0';
  else if (rangeStr.match(/^\\d+\\.\\d+$/)) rangeStr += '.0';
  const vParts = PARSE_SEMVER(version);
  const rParts = PARSE_SEMVER(rangeStr);
  if (!vParts || !rParts) return false;
  const cmp = COMPARE_SEMVER(vParts, rParts);
  switch (op) {
    case '^': {
      if (rParts[0] > 0) {
        return vParts[0] === rParts[0] && cmp >= 0;
      }
      if (rParts[1] > 0) {
        return vParts[0] === 0 && vParts[1] === rParts[1] && cmp >= 0;
      }
      return vParts[0] === 0 && vParts[1] === 0 && vParts[2] === rParts[2];
    }
    case '~': {
      return vParts[0] === rParts[0] && vParts[1] === rParts[1] && vParts[2] >= rParts[2];
    }
    case '>=': return cmp >= 0;
    case '>':  return cmp > 0;
    case '<=': return cmp <= 0;
    case '<':  return cmp < 0;
    case '=':  return cmp === 0;
    default: {
      if (comp.match(/^\\d/)) {
        return cmp === 0;
      }
      return cmp === 0;
    }
  }
}

function SATISFIES_RANGE(version, range) {
  const trimmed = range.trim();
  if (!trimmed || trimmed === '*' || trimmed === 'latest' || trimmed === '') return true;
  const orParts = trimmed.split(/\\s*\\|\\|\\s*/);
  for (const orPart of orParts) {
    const hyphen = orPart.match(/^(\\S+)\\s+-\\s+(\\S+)$/);
    if (hyphen) {
      if (__SATISFIES_COMPARATOR(version, '>=' + hyphen[1]) &&
          __SATISFIES_COMPARATOR(version, '<=' + hyphen[2])) {
        return true;
      }
      continue;
    }
    const andParts = orPart.trim().split(/\\s+/);
    const allMatch = andParts.every((part) => __SATISFIES_COMPARATOR(version, part));
    if (allMatch) return true;
  }
  return false;
}

function RESOLVE_VERSION(versions, range) {
  if (!range || range === 'latest' || range === '*' || range === '') return null;
  const matching = versions.filter((v) => {
    if (v.includes('-') && !range.includes('-')) return false;
    return SATISFIES_RANGE(v, range);
  });
  if (matching.length === 0) return null;
  matching.sort((a, b) => {
    const ap = PARSE_SEMVER(a);
    const bp = PARSE_SEMVER(b);
    if (!ap || !bp) return 0;
    return COMPARE_SEMVER(bp, ap);
  });
  return matching[0];
}
// ── end npm-resolve preamble ────────────────────────────────────────────
`;
