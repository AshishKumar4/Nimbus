/**
 * npm-install-preamble.ts — what the install facet (npm/install-batch-facet.ts)
 * shares with the supervisor by source: the registry's retry policy and
 * tarball integrity. The facet is serialized with fn.toString() and cannot
 * import, so the functions are embedded here by their own source, as the
 * resolver's semver is (npm-resolve-preamble.ts): a tarball fetch in the
 * facet and a packument fetch in the supervisor retry alike, and an install
 * checks a tarball with the reading the shared cache addresses it by.
 * tests/unit/npm-install-preamble.mjs evaluates the embedded functions
 * against the modules'.
 */

import { retryDelayMs, retrying } from '@nimbus-sh/platform/retry.js';
import { REGISTRY_RETRY_BACKOFF_MS, retryingRegistryFetch } from '../npm/registry-retry.js';
import {
  SRI_DIGEST_ALGORITHMS,
  sriDigestOf,
  sriDigestsEqual,
  sriEntries,
  strongestSriEntry,
} from '../npm/tarball-integrity.js';

export const NPM_INSTALL_PREAMBLE: string = `
// ── Retry (embedded from @nimbus-sh/platform retry.ts, npm/registry-retry.ts) ──
const REGISTRY_RETRY_BACKOFF_MS = ${JSON.stringify(REGISTRY_RETRY_BACKOFF_MS)};
${retryDelayMs.toString()}
${retrying.toString()}
${retryingRegistryFetch.toString()}
// ── Tarball integrity (embedded from npm/tarball-integrity.ts) ──────────────
const SRI_DIGEST_ALGORITHMS = ${JSON.stringify(SRI_DIGEST_ALGORITHMS)};
${sriEntries.toString()}
${strongestSriEntry.toString()}
${sriDigestOf.toString()}
${sriDigestsEqual.toString()}
`;
