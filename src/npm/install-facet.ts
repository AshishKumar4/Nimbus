/**
 * npm-install-facet.ts — per-package install spec shape.
 *
 * Pre-Phase-2 this module exported `fetchAndStagePackage`, a
 * `(spec, env) => result` function that ran inside a NimbusLoaderPool
 * worker dispatched once per package via `pool.map(fn, specs)`. With
 * 4-way concurrency it hit the workerd per-DO dynamic-worker cap
 * (resolver-facet + fetch-proxy + 4 install-pool slots + pre-bundle =
 * 7 workers) and surfaced the "Too many concurrent dynamic workers"
 * error documented in WORKERD-CRASH.md.
 *
 * Phase 2 A'.1 collapsed the install to a single dispatch via
 * src/npm-install-batch-facet.ts. The batch facet receives the WHOLE
 * `FacetPackageSpec[]` and loops internally with `pLimit(3)`,
 * spending one loader entry instead of N. The per-package
 * `fetchAndStagePackage` function and the `FacetPackageResult`
 * interface were both deleted along with the legacy pool path.
 *
 * Only the `FacetPackageSpec` interface remains — both
 * `npm-installer.ts` and `npm-install-batch-facet.ts` use it as the
 * supervisor↔facet wire shape for one package.
 */

/** Per-package install spec the supervisor sends to the install
 *  batch facet. One per package; the spec list rides as a single
 *  argument across one RPC call. */
export interface FacetPackageSpec {
  name: string;
  version: string;
  tarballUrl: string;
  /**
   * npm subresource-integrity string, e.g. "sha512-...base64...".
   * When present, the facet verifies it before extraction.
   * Empty/missing = skip verification (older packages on npm don't publish it).
   */
  integrity: string;
  /** Absolute path inside the VFS where this package is installed. */
  pkgDir: string;
  /** mtime for every inode written by this package (ms since epoch). */
  mtime: number;
  /** Chunk size used by the VFS (must match sqlite-vfs.ts CHUNK_SIZE). */
  chunkSize: number;
}
