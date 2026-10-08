/**
 * image-store.ts — materializing resident-process boot images into the
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
 * {@link ImageBlobStore} port — the store decides what is written where
 * and when; the port decides how bytes land on a disk and with what modes and
 * credentials.
 */

import { sha256Incremental } from '@nimbus-sh/core/_shared/crypto.js';
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
export interface ImageBlobStore {
  /** Create a directory (and its parents) if it does not exist. */
  mkdirp(dir: string): void;
  /** The file's current size in bytes, or null when it does not exist. */
  sizeOf(path: string): number | null;
  /**
   * Create or REPLACE the file with exactly these bytes (truncating). The
   * bytes are taken during the call: the store reuses their buffer after.
   */
  writeFile(path: string, bytes: Uint8Array): void;
  /** Write bytes at an offset, growing the file; taken during the call, as writeFile's. */
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
export class ImageStore {
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
    private readonly blobs: () => ImageBlobStore,
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
   * Takes the images as a SEQUENCE, produced on demand and released as each
   * one's slices land, so exactly one image's text is resident here. The old
   * record-shaped parameter held every source for the whole call, and the
   * caller held its own copy beside it: measured on a real-vite launch, the
   * second image reported not one slice — ~25 MB of module text as UTF-16 in
   * two places, plus the first image's just-freed 10.36 MB encode buffer, on a
   * 128 MiB isolate. Yielding and dropping is what makes the peak one image
   * instead of all of them; it is not a pacing question, and a fresh turn does
   * not shrink a live heap.
   *
   * Writing the sources here, once, is what lets the session stop holding
   * them: after this returns, the only thing it keeps is a path.
   *
   * An image given as parts (a code pack: process-fabric.ts
   * encodeCommonJsPack) is never encoded whole: it is digested a part at a
   * time, and written a part at a time only if no complete image is stored
   * at that digest, each part released (emptied in place) as it is written.
   * Encoded whole, an astro project's second launch held its pack's 33.6 MiB
   * of strings and their 25 MiB of UTF-8 at once, and reset the session's
   * isolate.
   */
  async materialize(
    pid: number,
    images: AsyncIterable<readonly [string, string | string[]]> | Iterable<readonly [string, string | string[]]>,
    pacer: TurnBudget,
  ): Promise<Record<string, string>> {
    const fs = this.blobs();
    const paths: Record<string, string> = {};
    // The root set is this ARRAY, held by the sweep's map from before the
    // first byte and appended to as each image is named. Rooting an image
    // before its own first byte is the whole of the protocol: a sweep that
    // runs while this launch is suspended sees every image already written as
    // rooted, and an image not yet written is not yet a file. The array
    // identity is what makes an append visible — do not replace it.
    const rooted: string[] = [];
    this.residentImages.set(pid, rooted);
    fs.mkdirp(FACET_IMAGE_DIR);
    let count = 0;
    for await (const [moduleName, source] of images) {
      if (typeof source !== 'string') {
        const { path, written } = await this.materializeParts(fs, source, rooted, pacer);
        paths[moduleName] = path;
        count++;
        console.log(
          '[image-store] pid=' + pid + ' image ' + count + ' ' + moduleName + ' → '
          + path.slice(-12) + ' ' + written + ' bytes in parts, slice=' + FACET_IMAGE_WRITE_SLICE_BYTES
          + ' turns=' + pacer.chunks,
        );
        continue;
      }
      const bytes = new TextEncoder().encode(source);
      const path = facetImagePath(await facetImageDigest(bytes));
      paths[moduleName] = path;
      rooted.push(path);
      count++;
      const stored = path.replace(/^\/+/, '');
      console.log(
        '[image-store] pid=' + pid + ' image ' + count + ' ' + moduleName + ' → '
        + path.slice(-12) + ' ' + bytes.byteLength + ' bytes, slice=' + FACET_IMAGE_WRITE_SLICE_BYTES
        + ' turns=' + pacer.chunks,
      );
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
    console.log('[image-store] pid=' + pid + ' materialized ' + count + ' image(s) in ' + pacer.chunks + ' turn(s)');
    return paths;
  }

  /**
   * One image given as parts: its digest read a part at a time, then, unless
   * a complete image is already stored there, its bytes written a slice at a
   * time from one slice-sized buffer, each part emptied as it is encoded. The
   * root is claimed before the first byte, as every image's is. What it holds
   * at once is one part's encoding and one slice, whatever the image's size.
   */
  private async materializeParts(
    fs: ImageBlobStore,
    parts: string[],
    rooted: string[],
    pacer: TurnBudget,
  ): Promise<{ path: string; written: number }> {
    const encoder = new TextEncoder();
    const digest = sha256Incremental();
    let length = 0;
    for (const part of parts) {
      const bytes = encoder.encode(part);
      length += bytes.byteLength;
      await digest.update(bytes);
    }
    const path = facetImagePath(await digest.hex());
    rooted.push(path);
    const stored = path.replace(/^\/+/, '');
    // A complete image is already these bytes (see materialize).
    if (fs.sizeOf(stored) === length) {
      parts.fill('');
      await pacer.spend(length);
      return { path, written: length };
    }
    const slice = new Uint8Array(Math.min(FACET_IMAGE_WRITE_SLICE_BYTES, Math.max(length, 1)));
    let filled = 0;
    let offset = 0;
    const flush = async () => {
      const bytes = slice.subarray(0, filled);
      // The first slice REPLACES the file, as materialize's does.
      if (offset === 0) fs.writeFile(stored, bytes);
      else fs.writeRange(stored, offset, bytes);
      offset += filled;
      filled = 0;
      await pacer.spend(bytes.byteLength);
    };
    for (let i = 0; i < parts.length; i++) {
      const bytes = encoder.encode(parts[i]);
      parts[i] = '';
      for (let at = 0; at < bytes.byteLength;) {
        const n = Math.min(bytes.byteLength - at, slice.byteLength - filled);
        slice.set(bytes.subarray(at, at + n), filled);
        filled += n;
        at += n;
        if (filled === slice.byteLength) await flush();
      }
    }
    if (filled > 0 || offset === 0) await flush();
    if (offset !== length) throw new Error(`Nimbus: an image's parts encoded to ${offset} bytes, digested as ${length}`);
    return { path, written: length };
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
  private sweep(fs: ImageBlobStore): void {
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
