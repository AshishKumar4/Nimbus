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
export declare const NPM_INSTALL_PREAMBLE: string;
//# sourceMappingURL=npm-install-preamble.d.ts.map