/**
 * npm-install-facet.ts — per-package install spec shape.
 *
 * The supervisor↔facet wire shape for one npm package install. Sent
 * as a `FacetPackageSpec[]` over a single RPC call to the install
 * batch facet (src/npm/install-batch-facet.ts), which loops with
 * pLimit(3) and writes each package into the VFS in parallel.
 */
export {};
