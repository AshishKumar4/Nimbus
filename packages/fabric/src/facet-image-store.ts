/**
 * facet-image-store.ts — materializing resident-process boot images into the
 * content-addressed image store, and sweeping the ones nothing boots from.
 *
 * A resident process's module map is sized by the user's disk, so it does not
 * ride inside the boot spec — the store writes it once and the session keeps
 * only a path (see process-fabric.ts, ResidentCodeSpec.vfsTextModules). This
 * module owns the write protocol: paced slicing so no one turn holds a
 * transaction the platform resets the object over, register-roots-before-
 * first-byte so the sweep can never observe an unrooted image, size-equality
 * as the completeness test, and a mark-sweep rooted off the live process
 * table.
 *
 * The filesystem itself stays the embedder's, reached through the
 * {@link FacetImageBlobStore} port — the store decides what is written where
 * and when; the port decides how bytes land on a disk and with what modes and
 * credentials.
 */

import { MAX_TX_BLOB_BYTES, CHUNK_SIZE } from '@nimbus-sh/platform/limits.js';
import { FACET_IMAGE_DIR, facetImageDigest, facetImagePath } from './process-fabric.js';
import type { TurnBudget } from './turn-budget.js';

/**
 * Bytes of an image written in one storage transaction.
 *
 * The bound is the VFS's own, not a knob: a `writeRange` whose chunks fit
 * inside one transaction is committed in place, and one that does not falls
 * back to copy-on-write — which rewrites every chunk of the file, per slice,
 * making a sliced write quadratic in its size. A whole number of chunks is
 * the other half of that: a slice that ends mid-chunk makes the next one read
 * the partial chunk back to complete it.
 */
export const FACET_IMAGE_WRITE_SLICE_BYTES = Math.floor(MAX_TX_BLOB_BYTES / CHUNK_SIZE) * CHUNK_SIZE;

/**
 * What the store needs from the disk it writes images to — derived from the
 * writes it actually performs, nothing more. Modes, credentials and path
 * normalization are the implementation's: the store passes the same
 * store-relative paths it later roots and sweeps by.
 */
export interface FacetImageBlobStore {
  /** Create a directory (and its parents) if it does not exist. */
  mkdirp(dir: string): void;
  /** The file's current size in bytes, or null when it does not exist. */
  sizeOf(path: string): number | null;
  /** Create or REPLACE the file with exactly these bytes (truncating). */
  writeFile(path: string, bytes: Uint8Array): void;
  /** Write bytes at an offset, growing the file. */
  writeRange(path: string, offset: number, bytes: Uint8Array): void;
  /** Entry names directly under `dir`. Throws when the dir is unreadable. */
  list(dir: string): string[];
  /** Remove a file. Throws when it is already gone. */
  unlink(path: string): void;
}

/**
 * The content-addressed image store of one hosting Durable Object.
 *
 * The store is written by the kernel and read by the process, so nothing
 * here depends on which credential spawned what. Digest collisions are the
 * hash's problem; everything else is idempotent — an image already present
 * at its own digest is already the bytes we were about to write.
 */
export class FacetImageStore {
  /** pid → the boot images its facet loads from; the image sweep's root set. */
  private residentImages = new Map<number, string[]>();
  private dirReady = false;

  /**
   * @param blobs The disk the images land on, resolved per use — the embedder
   *   may not have a filesystem yet when the store is constructed, and throws
   *   from here when a write is asked for without one.
   * @param isLive Whether a pid still names a running process. The root set
   *   is the process table, reached through this one predicate.
   */
  constructor(
    private readonly blobs: () => FacetImageBlobStore,
    private readonly isLive: (pid: number) => boolean,
  ) {}

  /**
   * The image store's directory, created before the first filesystem view is
   * built rather than on the first image write.
   *
   * Lazily created, it made the store perturb the very view every manifest is
   * built from: the root listing gained an entry the moment an image landed,
   * so the next spawn of an identical program generated different text and
   * addressed a different image. Existing before the first walk makes it
   * stable.
   *
   * Sited on the embedder's exec path and not where its filesystem is
   * attached, because that runs while the Durable Object is coming up —
   * including on every wake — and a synchronous filesystem write there costs
   * the session its startup. Measured: a throwaway built that way stopped
   * accepting terminal connections at all, while the same build without it
   * served them.
   */
  ensureDir(): void {
    if (this.dirReady) return;
    this.dirReady = true;
    try { this.blobs().mkdirp(FACET_IMAGE_DIR); }
    catch { /* a session whose disk is not writable has no images to store */ }
  }

  /**
   * Materialize generated module sources in the content-addressed image store
   * and return the module-name → path map naming them.
   *
   * Writing the sources here, once, is what lets the session stop holding
   * them: after this returns, the only thing it keeps is a path.
   */
  async materialize(
    pid: number,
    modules: Record<string, string>,
    pacer: TurnBudget,
  ): Promise<Record<string, string>> {
    const fs = this.blobs();
    const images: Record<string, string> = {};
    const sources = new Map<string, string>();
    for (const [moduleName, source] of Object.entries(modules)) {
      const path = facetImagePath(await facetImageDigest(source));
      images[moduleName] = path;
      sources.set(path, source);
      await pacer.spend(source.length);
    }
    // Register the WHOLE root set here, in one synchronous step, before any
    // byte of it exists on disk. That ordering is the entire protocol between
    // a launch and the sweep: an image is rooted from before it is written, so
    // a sweep can never observe a file this launch has written but not yet
    // claimed. The old loop achieved it by not awaiting at all, which read as
    // "the writes must not be interrupted" — they may be. What must not be
    // interrupted is the gap between writing and rooting, and rooting first
    // closes it for every write that follows, however many turns they span.
    this.residentImages.set(pid, [...sources.keys()]);
    fs.mkdirp(FACET_IMAGE_DIR);
    for (const [path, source] of sources) {
      const stored = path.replace(/^\/+/, '');
      const bytes = new TextEncoder().encode(source);
      // An image at its full size is a COMPLETE one: a write only ever grows
      // the file from offset zero, so a write cut short by a reset leaves a
      // strictly shorter file and fails this test. Size is enough of a check
      // because the reader verifies the digest before the loader sees it.
      if (fs.sizeOf(stored) === bytes.byteLength) {
        await pacer.spend(bytes.byteLength);
        continue;
      }
      // Sliced because the platform resets the object over what ONE TURN has
      // outstanding, not over what it eventually writes — pi's 22.9 MB map
      // went in as a single write and took the session down with it ~25% of
      // the time. Spending between slices is what puts the rest of the image
      // on later turns; the slice bound is what keeps any one of them small.
      let offset = 0;
      do {
        const slice = bytes.subarray(offset, offset + FACET_IMAGE_WRITE_SLICE_BYTES);
        // The first slice REPLACES the file, so an interrupted write's remains
        // are truncated to a known length rather than left as a tail past this
        // content.
        if (offset === 0) fs.writeFile(stored, slice);
        else fs.writeRange(stored, offset, slice);
        offset += slice.byteLength;
        await pacer.spend(slice.byteLength);
      } while (offset < bytes.byteLength);
    }
    this.sweep(fs);
    return images;
  }

  /**
   * Drop every image no running process boots from.
   *
   * Content addressing means a changed program writes a NEW image rather than
   * replacing one, so a watch loop — or simply a session that runs a few
   * different programs — would otherwise leave one bundle-sized file behind
   * per distinct version. The root set is the process table, which is exact:
   * an image is live for precisely as long as the process that boots from it.
   * Nothing is left for a TTL or an eviction heuristic to guess at, and after
   * a DO reset the table is empty so every orphan goes.
   */
  private sweep(fs: FacetImageBlobStore): void {
    const live = new Set<string>();
    for (const [pid, paths] of this.residentImages) {
      if (this.isLive(pid)) {
        for (const path of paths) live.add(path);
      } else {
        this.residentImages.delete(pid);
      }
    }
    let names: string[];
    try { names = fs.list(FACET_IMAGE_DIR); } catch { return; }
    for (const name of names) {
      if (live.has(`/${FACET_IMAGE_DIR}/${name}`)) continue;
      try { fs.unlink(`${FACET_IMAGE_DIR}/${name}`); } catch { /* already gone */ }
    }
  }
}
