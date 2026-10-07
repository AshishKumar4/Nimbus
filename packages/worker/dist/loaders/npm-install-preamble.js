/**
 * npm-install-preamble.ts — what the install facet (npm/install-batch-facet.ts)
 * shares with the supervisor by source: the registry's retry policy and
 * tarball integrity. The facet is serialized with fn.toString() and cannot
 * import, so the functions are embedded here by their own source, as the
 * resolver's semver is (npm-resolve-preamble.ts): a tarball fetch in the
 * facet and a packument fetch in the supervisor retry alike, and an install
 * checks a tarball with the reading the shared cache addresses it by.
 *
 * Only functions are embedded, each by its own source, and the facet imports
 * the ones it calls: the Worker's bundler may rename a declaration (it does,
 * `retryingRegistryFetch2`, when a module names a global of that name), and
 * a function's source and every reference to it carry the same identifier,
 * where a constant declared here by its source name would not.
 * tests/unit/npm-install-preamble.mjs evaluates the embedded functions
 * against the modules', and bundles the facet as the Worker does.
 */
import { retryDelayMs, retrying } from '@nimbus-sh/platform/retry.js';
import { retryingRegistryFetch } from '../npm/registry-retry.js';
import { sriDigestAlgorithms, sriDigestOf, sriDigestsEqual, sriEntries, strongestSriEntry, } from '@nimbus-sh/core/_shared/tarball-integrity.js';
export const NPM_INSTALL_PREAMBLE = `
// ── Retry (embedded from @nimbus-sh/platform retry.ts, npm/registry-retry.ts) ──
${retryDelayMs.toString()}
${retrying.toString()}
${retryingRegistryFetch.toString()}
// ── Tarball integrity (embedded from @nimbus-sh/core _shared/tarball-integrity.ts) ──────────────
${sriDigestAlgorithms.toString()}
${sriEntries.toString()}
${strongestSriEntry.toString()}
${sriDigestOf.toString()}
${sriDigestsEqual.toString()}
`;
