/**
 * npm-install-facet.ts — per-package install spec shape.
 *
 * The supervisor↔facet wire shape for one npm package install. Sent
 * as a `FacetPackageSpec[]` over a single RPC call to the install
 * batch facet (src/npm/install-batch-facet.ts), which loops with
 * pLimit(3) and writes each package into the VFS in parallel.
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
