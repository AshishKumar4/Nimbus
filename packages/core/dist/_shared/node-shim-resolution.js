/**
 * _shared/node-shim-resolution.ts — what the node facet's shim embeds of
 * Nimbus's resolution, credential and upgrade policy, as source: the shim is a string
 * evaluated inside the facet and cannot import. scripts/bundle-facet-workers.mjs
 * compiles this entry once into NODE_SHIM_RESOLUTION_PREAMBLE (worker
 * loaders/generated-workers.ts), so the shim declares these functions from
 * this code, as the same text whatever toolchain later evaluates the shim.
 */
export { DEFAULT_CJS_CONDITIONS, DEFAULT_ESM_CONDITIONS, packageJsonText, packageSelfReferenceSubpath, resolveExports, resolvePackageEntry, selectPackageMap, createNodePackageMapPolicy, 
// The ESM resolver's preamble calls them by name too (package-map.ts's).
codeOf, nativeResolutionError, } from './exports-resolver.js';
// The ESM resolver's preamble reads a URL's members through these (package-map.ts).
export { urlHash, urlHref, urlPathname, urlProtocol, urlSearch, urlSetHash, urlSetPathname, urlSetSearch } from './package-map.js';
export { createRequireResolver, requireNodeModulePaths, NIMBUS_TYPESCRIPT_REQUIRE_POLICY } from './commonjs-resolver.js';
export { TYPESCRIPT_INDEX_CANDIDATES, stripsTypeScript, typescriptFallbackCandidates } from './typescript-specifiers.js';
export { presentedCredential } from './ai-egress.js';
export { isWebSocketUpgradeRequest } from './websocket-upgrade.js';
