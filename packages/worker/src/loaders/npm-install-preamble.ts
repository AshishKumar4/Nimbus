/** Registry retries and integrity helpers compiled with their lexical dependencies. */
import { NPM_INSTALL_HELPERS_SOURCE } from './compiled-bodies.generated.js';

export const NPM_INSTALL_PREAMBLE: string = `const {
  retryDelayMs, retrying, retryingRegistryFetch,
  sriDigestAlgorithms, sriEntries, strongestSriEntry, sriDigestOf, sriDigestsEqual,
} = ${NPM_INSTALL_HELPERS_SOURCE};`;
