/**
 * Bringing the store to the authority: the boot a process takes before its
 * first instruction, the ACQUIRE answers its barriers apply, the reconcile
 * that repairs a poison, and the listings and fetches all of them make.
 *
 * WHAT EXISTS has to come from the authority, not from anything the facet was
 * shipped. That was measured rather than assumed: for a working tree holding a
 * 25 MiB file outside the cwd, the spawn-time stat table this replaced arrived
 * with FOUR entries ("home", "opt", "var", "home/user"), every one a
 * directory. A launch ships only what it staged plus its ancestors; a store
 * that enumerated from that would hold only what the bundle already had, which
 * is the admission problem it exists to delete.
 *
 * One cost this store pays that a heap cache does not: LOSING the rows means
 * repopulating them, not lazily refetching on a miss. That is why the cursor is
 * PERSISTED beside the rows — a fresh incarnation resumes from a real cursor
 * instead of a null epoch, so it asks for a delta rather than inviting a poison
 * — and why a poison RECONCILES the rows against absolute per-path revisions
 * instead of dropping them. The invalidation log a delta rides on is
 * deliberately small (sqlite-vfs.ts, INVALIDATION_LOG_MAX_BYTES) and ordinary
 * write churn trims it past a live cursor as a matter of course, so "poison ⇒
 * full repopulation" made an npm install re-buy the whole filesystem over and
 * over — measured past the DO CPU limit at pi scale. See `synchronize`.
 */

import {
  FS_LIST_PAGE_LIMIT,
  FS_LIST_TREE_MAX_ENTRIES,
  FS_READ_BATCH_PATH_LIMIT,
  FS_READ_BATCH_REQUEST_BYTES,
} from '@nimbus-sh/core/constants.js';
import type { ResidentEntry, ResidentNamespace } from '@nimbus-sh/core/runtime/wasi/resident-filesystem.js';
import type { Admission } from './admission.js';
import type { Admitted, Cells } from './cells.js';
import { RESIDENT_ROW_BYTES, namespaceRowBytes, residentBytes, residentCellCost, type ResidentCell } from './cell-cost.js';
import type { Coherence, Cursor } from './coherence.js';
import { nsDescribes, nsKey, nsRowAt, nsSplit, type Namespace } from './namespace.js';
import type { ResidentCred } from './permissions.js';
import { RESIDENT_CHUNK_BYTES } from '../facet-resident-limits.js';
import type { AcquireAnswer, ListEntry, ResidentStat, ResidentSupervisor } from './supervisor.js';
import { NS_DIR, NS_FILE, NS_LINK, RK_BINARY, RK_OWN_WRITE, type ResidentTables } from './tables.js';

/**
 * The `fsReadBatch` bounds, as the filler must respect them.
 *
 * These are not the store's to choose — they belong to the supervisor, and a
 * filler that guessed at them does not degrade gracefully: `_rpcFsReadBatch`
 * validates with zod and rejects the WHOLE call, so one over-packed batch
 * loses every path in it.
 */
const BATCH_PATHS = FS_READ_BATCH_PATH_LIMIT;
const BATCH_BYTES = FS_READ_BATCH_REQUEST_BYTES;
/**
 * Pages one enumeration may take before it gives up.
 *
 * A bound rather than an unbounded loop because `fsList` is a network call in
 * a boot path: a supervisor that never reported a null `next` would spin here
 * forever and the process would never start. At the page size above this
 * admits filesystems into the tens of millions of paths, so it bounds a defect
 * rather than a workload.
 */
const MAX_LIST_PAGES = 4096;
/** Dependencies and VCS state: written in bulk, read through the module map or not at all. */
const PUSH_EXCLUDE = ['node_modules', '.git'];
/** The most a lookup reads of the file it ends at, so the open that follows a stat costs no trip of its own. */
const LOOKUP_CONTENT_BYTES = 256 * 1024;

/** A file to fetch: its listed size and revision, the epoch they are on, and its content key. */
interface WantedFile { path: string; size: number; rev: number; epoch: string; ckey?: string | null; stat?: ResidentStat | null }

export interface FillReport { requested: number; filled: number; failed: number; bytes?: number; ranges?: number; copied?: number }

export interface SyncReport extends FillReport {
  skipped?: string;
  incomplete?: string;
  kept?: number;
  rekeyed?: number;
  dropped?: number;
  own?: { path: string; rev: number | null }[];
  reconciled?: boolean;
  complete?: boolean;
  cursor?: Cursor | null;
}

export interface Sync {
  boot(takeBundle: () => Record<string, ResidentCell> | null | undefined, moduleCursor: unknown, supervisor: ResidentSupervisor | null | undefined, moduleBytes?: number): Promise<{ cursor: Cursor | null; failure: string | null }>;
  setPushRoots(roots: unknown): void;
  pushable(path: string): boolean;
  acquireOptions(): { namespace: true; push?: { roots: string[]; exclude: string[] } };
  applyAcquire(supervisor: ResidentSupervisor | null | undefined, result: AcquireAnswer): Promise<Admitted>;
  relist(supervisor: ResidentSupervisor | null | undefined, dir: string): Promise<void>;
  bootLazy(supervisor: ResidentSupervisor | null | undefined): Promise<boolean>;
  namespaceView(supervisor: ResidentSupervisor, device: number, cred: ResidentCred): ResidentNamespace;
  setPlan(paths: unknown): void;
  setManifests(manifests: unknown): void;
  adoptModuleBundle(bundle: Record<string, ResidentCell> | null | undefined, moduleCursor: unknown): Cursor | null;
  fetchFiles(supervisor: ResidentSupervisor, files: WantedFile[]): Promise<Required<Omit<FillReport, 'bytes' | 'ranges' | 'copied'>> & { bytes: number; ranges: number; copied: number }>;
  synchronize(supervisor: ResidentSupervisor | null | undefined): Promise<SyncReport>;
  refillFromNamespace(supervisor: ResidentSupervisor, dropped: readonly string[]): Promise<FillReport>;
  requireNamespace(supervisor: ResidentSupervisor | null | undefined, bootFailure: string | null): Promise<string | null>;
}

const messageOf = (e: unknown): string => ((e as { message?: string } | null)?.message) || String(e);

export function createSync(coherence: Coherence, admission: Admission, namespace: Namespace, cells: Cells): Sync {
  /**
   * The acquire options this store asks for: stats with every delta entry, and
   * the content of files changed under the push roots — the process's working
   * tree and /tmp, where what a peer writes after launch is what it goes on to
   * read (build output, manifests, temp files), less dependencies and VCS state.
   */
  let pushRoots: string[] = [];
  /**
   * The launch's data plan (facets/data-plan.ts): the paths whose content a
   * synchronous read may want, held from boot beside the module map. A launch
   * with none (a re-entry by an inbound request) holds what it already had.
   */
  let plan = new Set<string>();
  /**
   * Every package.json the launch's listing names, held from boot: the data
   * plan's `package-json` rule (facets/data-plan.ts) for a launch the session
   * plans without a listing (a one-shot). Package resolution reads manifests
   * synchronously, for whatever names a program resolves, which no closure
   * walk bounds: vite's config load resolves every import of the config to
   * decide what to externalize, and took each manifest it was refused for a
   * package that is not installed.
   *
   * The launch hands over the manifests the session read once per install
   * (manager.ts _installedManifests), by path, each with its content key. A
   * listed manifest whose content key is its copy's, and whose listed mode and
   * owner let this credential read it, is held from the copy, so a copy is
   * never older than the file nor readable where the file is not; any other
   * is fetched with the plan.
   * Null: no such rule (a resident's plan names its manifests itself).
   */
  let manifests: Map<string, unknown> | null = null;
  const isManifest = (path: string): boolean => (path === 'package.json' || path.endsWith('/package.json')) && !('/' + path).includes('/.git/');

  const pushable = (path: string): boolean => {
    for (const root of pushRoots) {
      if (root !== '' && path !== root && !path.startsWith(root + '/')) continue;
      const rest = root === '' ? path : path.slice(root.length + 1);
      if (!rest.split('/').some((seg) => PUSH_EXCLUDE.includes(seg))) return true;
    }
    return false;
  };

  const acquireOptions = (): { namespace: true; push?: { roots: string[]; exclude: string[] } } => (pushRoots.length > 0
    ? { namespace: true, push: { roots: pushRoots, exclude: PUSH_EXCLUDE } }
    : { namespace: true });

  /**
   * Re-read the names beneath `dir` from the authority: a directory that just
   * became searchable, whose descendants no delta will ever name.
   */
  const relist = async (supervisor: ResidentSupervisor | null | undefined, dir: string): Promise<void> => {
    const t = coherence.tables('relist');
    if (!supervisor || typeof supervisor.fsList !== 'function') { namespace.markReady(t, false, 'the session cannot list its filesystem'); return; }
    const prefix = dir + '/';
    const seen: ListEntry[] = [];
    let replaceBytes = 0;
    let incomingBytes = 0;
    if (admission.inHeap) {
      for (const row of t.nsKeys()) {
        const key = row.parent ? row.parent + '/' + row.name : row.name;
        if (!key.startsWith(prefix)) continue;
        replaceBytes += namespaceRowBytes(row.parent, row.name, t.nsGet(row.parent, row.name)?.target);
      }
    }
    let after = prefix;
    let done = false;
    for (let page = 0; page < MAX_LIST_PAGES && !done; page++) {
      let listed;
      try { listed = await supervisor.fsList(after, FS_LIST_PAGE_LIMIT); }
      catch (e) { namespace.markReady(t, false, 'a listing of /' + dir + ' failed (' + messageOf(e) + ')'); return; }
      if (!listed || !Array.isArray(listed.entries)) { namespace.markReady(t, false, 'a listing of /' + dir + ' came back without entries'); return; }
      for (const entry of listed.entries) {
        const k = nsKey(entry.path);
        if (!k.startsWith(prefix)) {
          if (k > prefix) { done = true; break; }
          continue;
        }
        if (entry.stat) {
          if (admission.inHeap && admission.cap !== null) {
            const [parent, name] = nsSplit(k);
            incomingBytes += namespaceRowBytes(parent, name, entry.linkTarget ?? entry.unlisted);
            const refused = admission.namespaceRefusal(incomingBytes - replaceBytes);
            if (refused !== null) {
              namespace.markReady(t, false, refused);
              return;
            }
          }
          seen.push(entry);
        }
      }
      if (listed.next === null || listed.next === undefined) done = true;
      else after = listed.next;
    }
    if (!done) { namespace.markReady(t, false, 'a listing of /' + dir + ' did not finish'); return; }
    if (!seen.every((entry) => nsDescribes(entry.stat))) { namespace.markReady(t, false, 'a listing of /' + dir + ' named an entry without its stat'); return; }
    // Exactly what the listing has under the directory: a name it no longer
    // shows (hidden now, or gone) leaves, one it shows is written.
    namespace.deleteTree(t, dir, false);
    for (const entry of seen) namespace.put(t, nsKey(entry.path), entry.stat!, entry.rev, entry.linkTarget, entry.unlisted ?? null);
  };

  /**
   * Apply one ACQUIRE answer to the store: room for what it pushes (N18), the
   * delta itself, then the directories it says no delta will itemise — relisted
   * now where the namespace is enumerated, forgotten where it is listed on
   * demand, so the next lookup there lists it again. The store's catch-up and a
   * WASI process's barrier run it; node-shims.ts's barriers run the same three
   * steps inline.
   */
  const applyAcquire = async (supervisor: ResidentSupervisor | null | undefined, result: AcquireAnswer): Promise<Admitted> => {
    await admission.roomForPushed(result);
    const applied = cells.admit(result);
    for (const dir of applied.relist) {
      if (namespace.lazy) namespace.forgetListed(dir);
      else await relist(supervisor, dir);
    }
    return applied;
  };

  /**
   * Fetch these files from the authority and install them, each dated at the
   * revision the listing reported it at.
   *
   * THE BATCH BOUNDS ARE THE SUPERVISOR'S AND ARE NOT NEGOTIABLE HERE.
   * `_rpcFsReadBatch` validates with zod and rejects the WHOLE call, so an
   * over-packed batch loses every path in it rather than degrading. Three
   * separate bounds apply at once and the packing below respects all three:
   *
   *   paths per call      BATCH_PATHS            (FS_READ_BATCH_PATH_LIMIT)
   *   requested bytes     BATCH_BYTES            (FS_READ_BATCH_REQUEST_BYTES)
   *   bytes per range     RESIDENT_CHUNK_BYTES   (the single-value ceiling)
   *
   * Every file is split into RESIDENT_CHUNK_BYTES ranges — most files are one
   * short range — and the ranges are packed into calls. That makes the large
   * file the SAME path as the small one rather than a special case, and it means
   * no whole-file buffer is ever held: each range is written straight into its
   * own chunk row as it lands, and the head row follows only once every range of
   * that file has.
   *
   * A row is stamped with its OWN listed revision rather than with the global
   * cursor. Both are conservative — a write landing mid-fetch reports a revision
   * above the stamp, so the next ACQUIRE evicts and refetches, while stamping
   * newer than the bytes would keep a stale row forever — but the per-path
   * revision is the tighter of the two, and it is the one that survives a
   * reconcile: a row dated at the global cursor is indistinguishable from a row
   * whose path moved at that same revision.
   */
  const fetchFiles = async (supervisor: ResidentSupervisor, wantedFiles: WantedFile[]) => {
    // Content already held under another path, or wanted twice in this batch,
    // is fetched once: equal keys are equal bytes (the second copy is local).
    const t = coherence.tables('fetchFiles');
    const requested = wantedFiles.length;
    let copied = 0;
    const files: WantedFile[] = [];
    const later: WantedFile[] = [];
    const fetching = new Set<string>();
    for (const file of wantedFiles) {
      if (file.ckey != null) {
        if (cells.copyByKey(t, file.path, file.ckey, file.rev)) { copied++; continue; }
        if (fetching.has(file.ckey)) { later.push(file); continue; }
        fetching.add(file.ckey);
      }
      files.push(file);
    }
    // One flat list of ranges across all files, so packing is a single pass and
    // a 25 MiB file and a 40-byte one are the same shape.
    const ranges: { path: string; rev: number; epoch: string; part: number; parts: number; offset: number; length: number; size: number; ckey: string | null }[] = [];
    for (const file of files) {
      const parts = Math.max(1, Math.ceil(file.size / RESIDENT_CHUNK_BYTES));
      for (let part = 0; part < parts; part++) {
        const offset = part * RESIDENT_CHUNK_BYTES;
        ranges.push({
          path: file.path,
          rev: file.rev,
          epoch: file.epoch,
          part,
          parts,
          offset,
          length: Math.min(RESIDENT_CHUNK_BYTES, Math.max(0, file.size - offset)),
          size: file.size,
          ckey: file.ckey ?? null,
        });
      }
    }

    // Per-file landed-part counts, so a head row is written only once every
    // range of that file is in. See cells.putHead.
    const landed = new Map<string, number>();
    let filled = 0, failed = 0, fetchedBytes = 0;
    const failedPaths = new Set<string>();

    for (let at = 0; at < ranges.length;) {
      const batch: typeof ranges = [];
      let bytes = 0;
      while (
        at < ranges.length
        && batch.length < BATCH_PATHS
        && (batch.length === 0 || bytes + ranges[at]!.length <= BATCH_BYTES)
      ) {
        bytes += ranges[at]!.length;
        batch.push(ranges[at]!);
        at++;
      }
      // N18: room for the batch first; what the ledger will not admit is read
      // through the session instead of held.
      if (!(await admission.ensureRoom(bytes + batch.length * RESIDENT_ROW_BYTES))) {
        for (const r of batch) failedPaths.add(r.path);
        continue;
      }
      let results;
      try {
        results = await supervisor.fsReadBatch!(
          batch.map((r) => ({ path: r.path, offset: r.offset, length: r.length, expectedEpoch: r.epoch, expectedRevision: r.rev })),
        );
      } catch {
        for (const r of batch) failedPaths.add(r.path);
        continue;
      }
      for (let i = 0; i < batch.length; i++) {
        const range = batch[i]!;
        const entry = results && results[i];
        if (!entry || entry.error) {
          // A denial is a real answer and is stored as one, so a later read
          // reports EACCES synchronously instead of missing. Anything else is a
          // path this store will not hold, and a read of it falls through to
          // exactly the miss it would have had before.
          const code = entry && typeof entry.error === 'object' && entry.error !== null ? entry.error.code : undefined;
          if (code === 'EACCES' && range.part === 0) {
            cells.put(t, range.path, { error: 'EACCES' }, range.rev);
            filled++;
          } else failedPaths.add(range.path);
          continue;
        }
        if (entry.bytes === null || entry.bytes === undefined) { failedPaths.add(range.path); continue; }
        const chunk = residentBytes(entry.bytes);
        if (chunk.byteLength !== range.length) { failedPaths.add(range.path); continue; }
        fetchedBytes += chunk.byteLength;
        if (!cells.putChunk(t, range.path, range.part, chunk)) { failedPaths.add(range.path); continue; }
        const seen = (landed.get(range.path) || 0) + 1;
        landed.set(range.path, seen);
        if (seen === range.parts && !failedPaths.has(range.path)) {
          cells.putHead(t, range.path, RK_BINARY, range.size, range.parts, range.rev, range.ckey);
          filled++;
        }
      }
    }

    // A file whose ranges did not all land has chunk rows and no head, so it is
    // unreadable rather than short. Drop them so the slot does not carry bytes
    // nothing will ever serve.
    for (const path of failedPaths) {
      failed++;
      t.chunkDelete(path);
      t.fileDelete(path);
    }

    for (const file of later) {
      if (cells.copyByKey(t, file.path, file.ckey, file.rev)) copied++;
      else failed++;
    }
    if (ranges.length > 0) await admission.reportSize();
    return {
      requested, filled: filled + copied, failed,
      bytes: fetchedBytes, ranges: ranges.length, copied,
    };
  };

  /**
   * One delta from a listing's cursor, applied before the program runs. A
   * listing's pages are walked at successive revisions, so the namespace it
   * builds can mix states no single revision had (a rename seen on both sides
   * or neither); the delta from its cursor names every path that moved during
   * the walk, and leaves the table exact at the delta's revision. At boot there
   * are no own writes, so nothing here needs the ledger's report notes.
   */
  const catchUp = async (supervisor: ResidentSupervisor | null | undefined, cursor: Cursor): Promise<Cursor> => {
    if (!supervisor || typeof supervisor.fsAcquire !== 'function') return cursor;
    let result;
    try { result = await supervisor.fsAcquire(cursor.epoch, cursor.rev, acquireOptions()); }
    catch { result = null; }
    if (!result || result.poison || typeof result.rev !== 'number' || typeof result.epoch !== 'string') {
      // Unanswered: the namespace keeps the listing's revision, which the
      // program's first barrier brings forward like any other.
      return cursor;
    }
    const applied = await applyAcquire(supervisor, result);
    // A dropped row was held, so it is wanted again at its new revision.
    const refetch: WantedFile[] = [];
    for (const path of applied.dropped) {
      const found = namespace.resolve(path, false);
      if (!found || found === 'ELOOP' || found.row.kind !== NS_FILE) continue;
      refetch.push({ path, size: found.row.size, rev: found.row.rev, epoch: applied.cursor.epoch });
    }
    if (refetch.length > 0) await fetchFiles(supervisor, refetch);
    return applied.cursor;
  };

  /**
   * Enumerate the whole filesystem, one page at a time.
   *
   * Every page is dated, and a page whose epoch differs from the first ABORTS
   * the listing. The supervisor was replaced mid-walk, so the pages already
   * collected describe a filesystem that no longer exists and the revision they
   * would be dated at is meaningless. Returning short is safe — the rows simply
   * are not there and the reads miss — while stitching the two halves together
   * would date one incarnation's bytes at another's clock.
   */
  const enumerate = async (supervisor: ResidentSupervisor) => {
    const t = coherence.tables('enumerate');
    const entries: WantedFile[] = [];
    // Every name, whatever its kind: the namespace is built from these.
    const names: ListEntry[] = [];
    let namespaceBytes = 0;
    let after: string | null = null;
    let cursor: Cursor | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const listed = await supervisor.fsList!(after, FS_LIST_PAGE_LIMIT);
      if (!listed || !Array.isArray(listed.entries)) {
        throw new Error('Nimbus: fsList returned no page');
      }
      if (cursor === null) {
        cursor = { epoch: String(listed.epoch), rev: Number(listed.rev) };
      } else if (String(listed.epoch) !== cursor.epoch) {
        return { entries, names, cursor, complete: false, reason: 'the supervisor changed incarnation mid-enumeration' };
      }
      for (const entry of listed.entries) {
        if (entry.stat) {
          if (admission.inHeap && admission.cap !== null) {
            const key = nsKey(entry.path);
            const [parent, name] = nsSplit(key);
            if (key) namespaceBytes += namespaceRowBytes(parent, name, entry.linkTarget ?? entry.unlisted);
            const heap = coherence.heap;
            const refused = admission.namespaceRefusal(namespaceBytes - (heap === null ? 0 : heap.nsBytes()));
            if (refused !== null) namespace.refuse(t, refused);
          }
          names.push(entry);
        }
        // Directories carry no content, and a symlink's size is its TARGET's
        // length rather than the resolved file's — reading one by that size
        // would store a truncated file and call it whole. Content is fetched
        // by the path a symlink resolves to.
        if (entry.kind !== 'file') continue;
        const path = nsKey(entry.path);
        if (!path) continue;
        const size = Number(entry.size);
        // The path's own last-mutation revision. It is what makes a held row
        // verifiable without fetching its bytes, and so what makes a poison
        // repairable rather than fatal — see synchronize.
        const rev = Number(entry.rev);
        if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(rev) || rev < 0) {
          throw new Error("Nimbus: fsList returned unusable metadata for '" + path + "'");
        }
        // Its stat, for the bytes the store already has: who may read them (namespace.readable).
        entries.push({ path, size, rev, epoch: cursor.epoch, ckey: entry.contentKey == null ? null : String(entry.contentKey), stat: entry.stat ?? null });
      }
      if (listed.next === null || listed.next === undefined) {
        return { entries, names, namespaceBytes, cursor, complete: true, reason: null };
      }
      after = listed.next;
    }
    return { entries, names, cursor, complete: false, reason: 'the filesystem exceeded the enumeration page bound' };
  };

  /**
   * Bring the store to the authority's current state — the one repair path, used
   * both to populate a facet before its first instruction and to recover a
   * poisoned cursor.
   *
   * It turns "a capped prefetch" into "the filesystem", which is what makes a
   * first synchronous read of an untouched file succeed, and it is the only
   * blocking step: the waiting is done here so the reads that follow never have
   * to.
   *
   * WHY A POISON DOES NOT DROP THE ROWS. A poison says only that
   * `invalidatedSince` cannot describe the distance from our cursor to now —
   * the invalidation log is bounded at 256 KiB (sqlite-vfs.ts) and ordinary
   * write churn trims it past a live cursor as a matter of course. It says
   * nothing about the rows, and the rows are the asset: at pi scale ~16k files
   * and ~96 MB that dropping forces back over the wire, awaited inside the
   * ACQUIRE barrier, on every poison. That is a cost defect, not a coherence
   * one, and it was measured taking an agent turn past the DO CPU limit.
   *
   * `fsList` does not touch the log and reports every path's ABSOLUTE
   * revision, which is strictly more information than a delta. So the rows are
   * RECONCILED instead: a row at or above its listed revision is proven current
   * and kept, a row below it or no longer listed goes, and only what actually
   * moved is refetched. Every surviving row is vouched for by revision, so the
   * no-stale-byte guarantee is exactly as unconditional as it was on the drop
   * path — the delta is simply not the only way to establish it.
   *
   * The comparison is sound ONLY within one supervisor incarnation and ONLY
   * against a complete enumeration:
   *
   *   - revisions from different epochs are unrelated clocks, and after a
   *     restart an untouched path lists at rev 0, which would vouch for anything;
   *   - a truncated listing cannot tell a path that was REMOVED from one that
   *     was never walked, so dropping unlisted rows against it would delete a
   *     live cache for no reason.
   *
   * Neither is verifiable ⇒ nothing is dropped and nothing is vouched for; the
   * pass degrades to filling what the store does not hold, which is exactly what
   * it did before rows could be verified. The caller keeps whatever cursor it
   * had, and a poisoned caller has already taken its cold cache through
   * cells.admit.
   *
   * A row stamped RK_OWN_WRITE is this facet's own unacknowledged bytes —
   * newer than anything the authority can report — and is kept whether listed
   * or not, the same read-your-writes rule the delta path applies. But the
   * pass moves the cursor without a delta, so the report a delta would have
   * carried for such a path is returned instead (`own`): the listed revision,
   * or the listing's own cursor for a path it no longer lists, which bounds
   * whatever removed it. The write or mutation that owns the row adjudicates it
   * when its revision arrives, exactly as it does a delta's report. Across
   * incarnations, or against a short listing, no report can be dated and each
   * comes back null.
   *
   * Writes landing DURING the pass are covered the way they always were: the
   * published cursor is the one read BEFORE the walk, so they report revisions
   * above it and the next ACQUIRE evicts whatever they touched.
   */
  const synchronize = async (supervisor: ResidentSupervisor | null | undefined): Promise<SyncReport> => {
    const t = coherence.tables('synchronize');
    if (!supervisor || typeof supervisor.fsReadBatch !== 'function') {
      return { requested: 0, filled: 0, failed: 0, skipped: 'no fsReadBatch on this supervisor' };
    }
    if (typeof supervisor.fsList !== 'function') {
      // Without the enumeration the store cannot know what it is missing, so it
      // fills nothing beyond the adopted bundle and every read behaves exactly
      // as it did before this store existed — a smaller resident set, never a
      // wrong one. That is the failure direction to keep.
      return { requested: 0, filled: 0, failed: 0, skipped: 'supervisor cannot enumerate the filesystem (no fsList)' };
    }

    let listing;
    try {
      listing = await enumerate(supervisor);
    } catch (e) {
      return { requested: 0, filled: 0, failed: 0, skipped: 'fsList failed: ' + messageOf(e) };
    }
    if (!listing.cursor) {
      return { requested: 0, filled: 0, failed: 0, skipped: 'fsList reported no authority cursor' };
    }

    const held = coherence.cursor();
    // May a row this pass cannot prove current be DROPPED? Only against a
    // complete enumeration: a truncated one cannot tell a path that was removed
    // from one that was never walked.
    const judgeable = listing.complete;
    const describable = judgeable && listing.names.every((entry) => nsDescribes(entry.stat));
    // May a held revision be COMPARED with a listed one? Only inside one
    // supervisor incarnation: across a restart the clocks are unrelated, and an
    // untouched path lists at rev 0, which would vouch for anything.
    const comparable = judgeable && !!held && held.epoch === listing.cursor.epoch;
    // A file listed at revision 0 has none the store can compare: a mounted
    // file's (its backend keeps no revision on the session's clock; a file
    // SQLite holds was written at a generation past 0). Its row is never
    // vouched for, so a reconcile refetches what the mount holds now.
    const vouches = (entry: WantedFile | undefined, rev: number): boolean => comparable && entry !== undefined && entry.rev > 0 && rev >= entry.rev;

    const listed = new Map<string, WantedFile>();
    for (const file of listing.entries) listed.set(file.path, file);

    const rows = t.fileRows();
    const current = new Set<string>();
    const dropped: string[] = [];
    const own: { path: string; rev: number | null }[] = [];
    let rekeyed = 0;
    for (const row of rows) {
      const entry = listed.get(row.path);
      if (row.rev === RK_OWN_WRITE) {
        current.add(row.path);
        own.push({
          path: row.path,
          rev: !comparable ? null : entry !== undefined ? entry.rev : listing.cursor.rev,
        });
        continue;
      }
      const keep = vouches(entry, row.rev) || !judgeable;
      if (keep) { current.add(row.path); continue; }
      // The listing names the same bytes (a revision moved, the content did
      // not, or another epoch): kept and dated at the listing, while its stat
      // says this credential may read them (a chmod or chown moves the
      // revision and no byte). Equal keys are equal bytes, so this needs no
      // comparable clock.
      if (entry !== undefined && row.ckey !== null && entry.ckey != null && row.ckey === entry.ckey && namespace.readable(entry.stat)) {
        t.fileSetRev(row.path, entry.rev);
        current.add(row.path);
        rekeyed++;
        continue;
      }
      dropped.push(row.path);
    }
    // Cells held in the heap (own writes the store had no room for) are judged
    // as file rows are, on every path a file row is (N18). Undated, a write-back
    // still in flight: newer than anything listed, it stays and is reported as
    // own. Dated: kept only where the listing proves it current; otherwise it
    // goes, and is fetched again like any dropped row, so a sync read of it is
    // a miss rather than bytes the authority has replaced.
    for (const [path, rev] of cells.heldRevisions()) {
      if (current.has(path)) continue;
      const entry = listed.get(path);
      if (rev === RK_OWN_WRITE) {
        current.add(path);
        own.push({ path, rev: !comparable ? null : entry !== undefined ? entry.rev : listing.cursor.rev });
        continue;
      }
      if (vouches(entry, rev) || !judgeable) { current.add(path); continue; }
      cells.forget(path);
      dropped.push(path);
    }
    // Sweep what could not be vouched for. When NOTHING could — a new supervisor
    // incarnation, whose revisions say nothing about ours — that is every row but
    // this facet's own unflushed writes, and at pi scale a per-path delete would
    // be ~32,000 statements in one turn against an object that has been observed
    // resetting under exactly that load. So it is a predicate there, and per path
    // where a reconcile has made the set small by construction.
    if (dropped.length > 0 && !comparable && rekeyed === 0) {
      t.dropDatedFiles();
    } else {
      for (const path of dropped) {
        t.chunkDelete(path);
        t.fileDelete(path);
      }
    }

    // What to hold: the launch's data plan, every row this pass had to drop as
    // stale — it was held for a reason — and what the pushes a poison lost
    // would have carried: files under the push roots changed since the cursor
    // (all of them there, when the revisions are not comparable).
    const wanted = new Set(dropped);
    const fetch: WantedFile[] = [];
    const copied: { file: WantedFile; text: string }[] = [];
    for (const file of listing.entries) {
      if (current.has(file.path)) continue;
      if (manifests !== null && isManifest(file.path)) {
        // A copy is the file's bytes (equal content keys) and is held only
        // where the listing says this credential may read them; otherwise the
        // session is asked, and answers.
        const copy = manifests.get(file.path);
        if (Array.isArray(copy) && file.ckey !== null && copy[0] === file.ckey && namespace.readable(file.stat)) copied.push({ file, text: String(copy[1]) });
        else fetch.push(file);
        continue;
      }
      if (plan.has(file.path) || wanted.has(file.path)
        || (pushable(file.path) && (!comparable || file.rev > held!.rev))) fetch.push(file);
    }
    // Reserve mandatory metadata growth while optional data is fetched, but
    // retain the existing namespace publication order across the await.
    const heap = coherence.heap;
    const namespaceGrowth = admission.inHeap && describable && heap !== null ? Math.max(0, listing.namespaceBytes! - heap.nsBytes()) : 0;
    const refused = admission.namespaceRefusal(namespaceGrowth);
    if (refused !== null) namespace.refuse(t, refused);
    const giveBack = admission.reserveNamespace(namespaceGrowth);
    let filled;
    try {
      // A copy holds the bytes the listing names (equal content keys), dated at
      // its revision; one the store has no room for is fetched like the rest.
      let copiedBytes = 0;
      for (const { text } of copied) copiedBytes += residentCellCost(text);
      if (copiedBytes > 0) await admission.ensureRoom(copiedBytes);
      for (const { file, text } of copied) {
        if (!cells.put(t, file.path, text, file.rev, file.ckey)) fetch.push(file);
      }
      filled = await fetchFiles(supervisor, fetch);
    }
    finally { giveBack(); }

    // The cursor may only advance to a state the rows actually describe, and
    // after a truncated listing they do not: a path in an unwalked page could
    // have moved since the held cursor and would never be reported again.
    if (judgeable) {
      // A listing that cannot describe every name restores the rows it vouches
      // for and the cursor, but not the namespace (see nsDescribes).
      if (describable) namespace.replace(t, listing.names);
      coherence.writeCursor(t, listing.cursor);
      namespace.markReady(t, describable, "the session's listing named an entry without its stat");
      coherence.setUndated(false);
      coherence.unseal();
    }

    return {
      requested: filled.requested,
      filled: filled.filled,
      failed: filled.failed,
      bytes: filled.bytes,
      ranges: filled.ranges,
      kept: current.size,
      rekeyed,
      dropped: dropped.length,
      own,
      reconciled: comparable,
      complete: listing.complete,
      cursor: judgeable ? listing.cursor : null,
      ...(listing.reason ? { incomplete: listing.reason } : {}),
    };
  };

  /**
   * Adopt the module map's bundle into an EMPTY store — the first fill, and the
   * one that costs nothing extra, because those bytes are already in the facet.
   * The cursor the bundle was read at becomes the store's.
   *
   * Returns the cursor the caller should publish, so there is one answer to
   * "what state does this facet cache" rather than two that can disagree.
   */
  const adoptModuleBundle = (bundle: Record<string, ResidentCell> | null | undefined, moduleCursor: unknown): Cursor | null => {
    const t = coherence.tables('adoptModuleBundle');
    if (coherence.cursor() !== null) {
      // Adopting over a kept store would re-date its rows at this spawn's
      // cursor without checking one of them. boot reconciles a kept
      // store, or empties it first.
      throw new Error('Nimbus: a module bundle is adopted only into an empty store');
    }
    const given = moduleCursor as { epoch?: unknown; rev?: unknown } | null | undefined;
    if (!given || given.epoch == null || given.rev == null) {
      // An undated snapshot. Adopt NOTHING and serve an empty store.
      //
      // Not a throw, because this is a real path rather than a misuse: a facet
      // whose first contact is an inbound HTTP request runs
      // `__nimbusEnsureStarted(env, ctx)` with no start args, so it has no
      // cursor to offer. Refusing would turn a served port into a dead one.
      //
      // Not an adopt either, because rows nothing can date are the stale-read
      // bug. An EMPTY store is safe to serve for the reason the seal exists at
      // all — it has no row whose age could be wrong — and a miss is an answer
      // the shims already handle, falling through to the supervisor exactly as
      // they do today after a poison. So this is strictly no worse than the
      // current behaviour and cannot serve a stale byte.
      coherence.setUndated(true);
      coherence.unseal();
      return null;
    }
    const rev = Number(given.rev);
    for (const path of Object.keys(bundle || {})) {
      cells.put(t, path, bundle![path]!, rev);
    }
    return cells.admit({ poison: false, paths: [], epoch: String(given.epoch), rev }).cursor;
  };

  /**
   * Start a namespace with no names at `cursor`, to be listed on demand. Every
   * row and held file goes: nothing here is dated against the new cursor.
   */
  const beginLazy = (t: ResidentTables, cursor: Cursor): void => {
    namespace.beginLazy();
    t.clear();
    cells.dropHeld(true);
    coherence.writeCursor(t, cursor);
    coherence.unseal();
    coherence.setUndated(false);
    namespace.markReady(t, true);
  };

  /**
   * Boot a lazily listed namespace: the authority's current cursor (an ACQUIRE
   * from no cursor is a poison by construction, which carries it) and no
   * names. False when no cursor came back: the process then asks the
   * authority for everything, as it did before this store.
   */
  const bootLazy = async (supervisor: ResidentSupervisor | null | undefined): Promise<boolean> => {
    if (!supervisor || typeof supervisor.fsAcquire !== 'function') return false;
    let answer = null;
    try { answer = await supervisor.fsAcquire(null, 0, { namespace: true }); }
    catch { return false; }
    if (!answer || typeof answer.epoch !== 'string' || typeof answer.rev !== 'number') return false;
    // Sealed until now, and this is what unseals it: nothing is held to date.
    beginLazy(coherence.tables('bootLazy'), { epoch: answer.epoch, rev: answer.rev });
    return true;
  };

  /**
   * The ACQUIRE barrier of a lazily listed namespace, taken where input from
   * outside the process enters it (the runtime decides where; see the core
   * README's process model). An answer is applied as every barrier applies one
   * (applyAcquire). One that cannot be — a poison, a delta without
   * stats, no answer — dates nothing the store holds, and the namespace starts
   * again from nothing at the authority's cursor: names are listed again on
   * demand, never served from a state the cursor has left.
   */
  const lazyBarrier = async (supervisor: ResidentSupervisor): Promise<boolean> => {
    const t = coherence.tables('lazyBarrier');
    const cursor = coherence.cursor();
    let answer: AcquireAnswer | null | undefined = null;
    if (cursor !== null) {
      try { answer = await supervisor.fsAcquire!(cursor.epoch, cursor.rev, { namespace: true }); }
      catch { answer = null; }
    }
    if (answer && !answer.poison && typeof answer.epoch === 'string' && typeof answer.rev === 'number') {
      await applyAcquire(supervisor, answer);
      if (namespace.ready()) return true;
      const now = coherence.cursor()!;
      answer = { epoch: now.epoch, rev: now.rev };
    }
    if (answer && typeof answer.epoch === 'string' && typeof answer.rev === 'number') {
      beginLazy(t, { epoch: answer.epoch, rev: answer.rev });
      return true;
    }
    return bootLazy(supervisor);
  };

  /**
   * Learn the names along one path in one round trip: an lstat of each key, in
   * order from the shallowest. A path ten directories deep costs one batch
   * rather than a listing of each directory on the way. A key below a symlink
   * names what the session reached THROUGH the link, which is not that key's
   * row, so nothing past the first link (or the first missing name) is written:
   * the walk follows the link and asks again. A missing name is not recorded as
   * absent; only a listed directory says what is not in it.
   *
   * With `contentBytes`, the same trip reads the last key's bytes and lstats it
   * again: a program that stats a file opens it next (a compiler's header
   * search, an interpreter's import), and a small file then costs nothing more.
   * The bytes are kept only when both lstats show the same file at the same
   * revision, so no write came between them and the read, and only when they
   * are all of it.
   */
  const lookupKeys = async (supervisor: ResidentSupervisor, keys: string[], contentBytes: number): Promise<boolean> => {
    if (!supervisor || typeof supervisor.fsReadBatch !== 'function' || keys.length === 0) return false;
    const t = coherence.require();
    const batch = keys.slice(0, BATCH_PATHS - 2);
    const last = batch[batch.length - 1]!;
    const withContent = contentBytes > 0 && batch.length === keys.length;
    const requests: { path: string; lstat?: boolean; offset?: number; length?: number }[] = batch.map((k) => ({ path: '/' + k, lstat: true }));
    if (withContent) requests.push({ path: '/' + last, offset: 0, length: contentBytes }, { path: '/' + last, lstat: true });
    let answers;
    try { answers = await supervisor.fsReadBatch(requests); }
    catch { return false; }
    if (!Array.isArray(answers) || answers.length !== requests.length) return false;
    let reachedLast = false;
    for (let i = 0; i < batch.length; i++) {
      const answer = answers[i];
      if (!answer || answer.error || answer.stat === null || answer.stat === undefined || !nsDescribes(answer.stat)) break;
      let target;
      if (answer.stat.type === 'symlink') {
        try { target = await supervisor.readlink!('/' + batch[i]); }
        catch { break; }
        if (typeof target !== 'string') break;
      }
      if (!namespace.tryPut(t, batch[i]!, answer.stat, Number(answer.stat.revision) || 0, target)) return false;
      if (i === batch.length - 1) reachedLast = true;
      if (answer.stat.type !== 'directory') break;
    }
    if (withContent && reachedLast) {
      const before = answers[batch.length - 1]!.stat!;
      const read = answers[batch.length];
      const after = answers[batch.length + 1];
      const bytes = read && !read.error && read.bytes ? residentBytes(read.bytes) : null;
      if (
        before.type === 'file' && bytes !== null && bytes.byteLength === Number(before.size)
        && after && !after.error && after.stat && after.stat.type === 'file'
        && Number(after.stat.ino) === Number(before.ino) && Number(after.stat.revision) === Number(before.revision)
        && await admission.ensureRoom(bytes.byteLength + RESIDENT_ROW_BYTES)
      ) {
        // Whatever was held there is replaced whole, never left headless or with stray parts.
        t.fileDelete(last);
        t.chunkDelete(last);
        if (cells.putChunk(t, last, 0, bytes)) cells.putHead(t, last, RK_BINARY, bytes.byteLength, 1, Number(before.revision) || 0, null);
      }
    }
    return true;
  };

  /**
   * List the entries directly under `dir`: its names (readdir) and each one's
   * stat (an lstat batch), then each symlink's target. Two round trips for a
   * directory of any size up to the batch bound, where a stat per name would be
   * one each. A name that went between the two is not written; one that came is
   * reported by the next delta, since the store's cursor predates both.
   * Returns false when the directory cannot be listed (gone, not a directory,
   * not readable): the caller asks the authority instead.
   */
  const listDirectory = async (supervisor: ResidentSupervisor, dir: string): Promise<boolean> => {
    if (!supervisor || typeof supervisor.readdir !== 'function' || typeof supervisor.fsReadBatch !== 'function') return false;
    const t = coherence.require();
    let names;
    try { names = await supervisor.readdir('/' + dir); }
    catch { return false; }
    if (!Array.isArray(names)) return false;
    const keys = names.map((entry) => (dir === '' ? '' : dir + '/') + String(entry.name));
    const stats = new Map<string, ResidentStat & { type: string }>();
    for (let i = 0; i < keys.length; i += BATCH_PATHS) {
      const batch = keys.slice(i, i + BATCH_PATHS);
      let answers;
      try { answers = await supervisor.fsReadBatch(batch.map((k) => ({ path: '/' + k, lstat: true }))); }
      catch { return false; }
      if (!Array.isArray(answers) || answers.length !== batch.length) return false;
      for (let j = 0; j < batch.length; j++) {
        const answer = answers[j];
        if (!answer || answer.error) return false;
        if (answer.stat === null || answer.stat === undefined) continue;
        if (!nsDescribes(answer.stat)) return false;
        stats.set(batch[j]!, answer.stat);
      }
    }
    const targets = new Map<string, string>();
    for (const [k, stat] of stats) {
      if (stat.type !== 'symlink') continue;
      let target;
      try { target = await supervisor.readlink!('/' + k); }
      catch { return false; }
      if (typeof target !== 'string') return false;
      targets.set(k, target);
    }
    // Only what the directory holds now: a row for a name it no longer shows goes.
    for (const child of namespace.children(dir)) {
      const k = (dir === '' ? '' : dir + '/') + child.name;
      if (!stats.has(k)) namespace.deleteTree(t, k, true);
    }
    for (const [k, stat] of stats) {
      if (!namespace.tryPut(t, k, stat, Number(stat.revision) || 0, targets.get(k))) return false;
    }
    namespace.markListed(dir);
    return true;
  };

  /**
   * List everything beneath `dir` in one answer (fsListTree): what a walker
   * of the tree (git status, a build, an interpreter's startup) is about to
   * look at, in one round trip instead of two per directory, every entry
   * current at one revision. A subtree larger than the listing's bound is
   * refused there (E2BIG), and listed one directory at a time instead.
   * True when `dir` was listed whole.
   */
  const listSubtree = async (supervisor: ResidentSupervisor, dir: string): Promise<boolean> => {
    if (!supervisor || typeof supervisor.fsListTree !== 'function') return false;
    const t = coherence.require();
    let tree;
    try { tree = await supervisor.fsListTree('/' + dir, FS_LIST_TREE_MAX_ENTRIES); }
    catch { return false; }
    if (!tree || !Array.isArray(tree.entries)) return false;
    const listed = [dir];
    const written = new Set<string>();
    for (const entry of tree.entries) {
      const k = nsKey(entry.path);
      if (!entry.stat || !nsDescribes(entry.stat)) return false;
      if (!namespace.tryPut(t, k, entry.stat, entry.rev, entry.linkTarget, entry.unlisted ?? null)) return false;
      written.add(k);
      if (entry.kind === 'directory' && !entry.unlisted) listed.push(k);
    }
    // A name the listing no longer shows under a directory it listed goes.
    for (const directory of listed) {
      for (const child of namespace.children(directory)) {
        const k = (directory === '' ? '' : directory + '/') + child.name;
        if (!written.has(k)) namespace.deleteTree(t, k, true);
      }
    }
    for (const directory of listed) namespace.markListed(directory);
    return true;
  };

  const fail = (pass: SyncReport | null): string | null => (pass && (pass.skipped || pass.incomplete)) || null;

  return {
    /**
     * Make this incarnation's store servable before the program's first
     * instruction. The one boot path the resident body takes.
     *
     * A COLD store — no persisted cursor — adopts this spawn's own snapshot, the
     * module bundle dated at the cursor it was read at, and then fills the rest of
     * the filesystem from the authority. Its rows are current as of the spawn
     * whether or not the fill completes, which is all the protocol asks of a
     * process's first block (§5.3); the first ACQUIRE's delta brings them the rest
     * of the way.
     *
     * A KEPT store holds a PREVIOUS process's rows, dated against a cursor this
     * incarnation has never applied. A durable application's facet is one: it
     * keeps its `app-slot-` name across launches and its release never deletes
     * storage, so every relaunch or re-drive of the application opens what its
     * last process left. The rows are the asset — inside one supervisor
     * incarnation a relaunch fetches what changed, not the filesystem; across two,
     * whose revisions are unrelated, the reconcile rebuilds every dated row — and
     * they are also arbitrarily old: only the reconcile says which of them still
     * describe the filesystem, and nothing else runs before the program's first
     * synchronous reads. So the store stays SEALED through the reconcile, and a
     * reconcile that cannot vouch for its rows — the listing failed, came back
     * short, or there is no supervisor to ask — does not open it. The kept store
     * is emptied instead and this launch boots exactly as a cold one does: the
     * rare failure costs a relaunch its speedup, never a stale byte.
     *
     * The previous process's own unacknowledged rows are the one thing the
     * reconcile cannot judge, since it keeps own rows whatever the listing says.
     * store.bind drops them before any of this runs.
     *
     * `takeBundle` hands over the module bundle and drops the module's own
     * reference to it. The parsed bundle is the largest allocation in the facet
     * before the program starts, so a cold boot releases it the moment it is
     * adopted, and a kept store that reconciles never adopts it at all. A cell
     * may be a getter that reads its text as it is taken (a node process's code
     * cells, read back from the module map); `moduleBytes`, when the launch
     * costed the bundle already, spares reading each twice.
     *
     * Returns the cursor to publish and, when the boot fell short of the whole
     * filesystem, why.
     */
    async boot(takeBundle, moduleCursor, supervisor, moduleBytes) {
      coherence.tables('boot');
      let failure: string | null = null;
      if (coherence.cursor() !== null) {
        let pass: SyncReport | null = null;
        try { pass = await synchronize(supervisor); }
        catch (e) { failure = messageOf(e); }
        if (pass && pass.cursor) return { cursor: await catchUp(supervisor, pass.cursor), failure: null };
        failure = 'a kept store could not be reconciled ('
          + (failure || fail(pass) || 'the listing vouched for nothing')
          + '); it was emptied and this launch booted from its own snapshot';
      }
      // A store with no cursor holds nothing any incarnation can date.
      cells.clear();
      const bundle = takeBundle();
      // The module map is the program's code: it is held whole or the launch
      // fails. Spawn admitted it (N18); this is room for it now, asked for when
      // the store's cap does not already cover it.
      let bytes = moduleBytes;
      if (typeof bytes !== 'number') {
        bytes = 0;
        for (const path of Object.keys(bundle || {})) bytes += residentCellCost(bundle![path]);
      }
      if (!(await admission.ensureRoom(bytes))) {
        throw Object.assign(new Error(
          'ENOSPC: workspace storage is full: this process\'s modules (' + Math.ceil(bytes / 1048576)
            + ' MiB) do not fit in what is left of the session\'s storage',
        ), { code: 'ENOSPC' });
      }
      const adopted = adoptModuleBundle(bundle, moduleCursor);
      // The pass that just failed is not retried. The store now holds what a
      // cold launch whose fill failed holds, and its first ACQUIRE's delta
      // brings it current the same way.
      if (failure !== null) return { cursor: adopted, failure };
      let pass: SyncReport | null = null;
      try { pass = await synchronize(supervisor); }
      catch (e) { failure = messageOf(e); }
      if (pass && pass.cursor) return { cursor: await catchUp(supervisor, pass.cursor), failure };
      return { cursor: adopted, failure: failure || fail(pass) };
    },
    setPushRoots(roots) {
      pushRoots = (Array.isArray(roots) ? roots : []).map((r) => String(r).replace(/^\/+|\/+$/g, ''));
    },
    /** Whether a changed file at `path` is one the push roots would carry. */
    pushable,
    acquireOptions,
    applyAcquire,
    relist,
    bootLazy,
    /**
     * The store as a WASI process's filesystem adapter reads it (core
     * runtime/wasi/resident-filesystem.ts, ResidentNamespace): names as lstats,
     * listed on demand, file bytes held or fetched, and the barrier. `device` is
     * the session's SQLite device, the only one the adapter answers for.
     */
    namespaceView(supervisor, device, cred) {
      namespace.setCred(cred);
      const encoder = new TextEncoder();
      const typeOf = (kind: number): ResidentEntry['type'] => (kind === NS_DIR ? 'directory' : kind === NS_LINK ? 'symlink' : 'file');
      const view: ResidentNamespace = {
        device: Number(device),
        cred: { uid: Number(cred.uid), gid: Number(cred.gid), groups: (cred.groups || []).map(Number) },
        ready: () => namespace.lazy && namespace.ready(),
        entry(k) {
          const row = nsRowAt(coherence.require(), k);
          if (row === undefined) return namespace.listedAt(k) ? null : undefined;
          return {
            type: typeOf(row.kind), dev: row.dev || 0, ino: row.ino, nlink: row.nlink || 1,
            size: row.size, atime: row.atime, mtime: row.mtime, ctime: row.ctime,
            mode: row.mode, uid: row.uid, gid: row.gid, revision: row.rev,
            target: row.target == null ? null : String(row.target),
          };
        },
        children(k) {
          if (!namespace.isListed(k)) return undefined;
          return namespace.children(k).map((child) => ({ name: child.name, type: typeOf(child.kind) }));
        },
        list: (k) => listDirectory(supervisor, k),
        lookup: (keys, content) => lookupKeys(supervisor, keys, content ? LOOKUP_CONTENT_BYTES : 0),
        listTree: (k) => listSubtree(supervisor, k),
        content(k) {
          const cell = cells.get(k);
          if (cell === undefined || (typeof cell === 'object' && 'error' in cell)) return undefined;
          return typeof cell === 'string' ? encoder.encode(cell) : cell;
        },
        async fill(k, entry) {
          const cursor = coherence.cursor();
          if (cursor === null) return null;
          await fetchFiles(supervisor, [{ path: k, size: entry.size, rev: entry.revision, epoch: cursor.epoch, ckey: null }]);
          const bytes = view.content(k);
          return bytes === undefined ? null : bytes;
        },
        barrier: () => lazyBarrier(supervisor),
        reserve: (bytes) => admission.pin(bytes),
        release: (bytes) => admission.unpin(bytes),
      };
      return view;
    },
    setPlan(paths) {
      plan = new Set(Array.isArray(paths) ? paths.map((p) => nsKey(p)) : []);
    },
    setManifests(given) {
      const files = given && typeof given === 'object' && (given as { files?: unknown }).files && typeof (given as { files?: unknown }).files === 'object'
        ? (given as { files: Record<string, unknown> }).files : null;
      manifests = files === null ? null : new Map(Object.entries(files));
    },
    adoptModuleBundle,
    fetchFiles,
    synchronize,
    /**
     * Refetch, after a delta the store applied without a listing, what it should
     * hold and does not: the paths the delta dropped and the launch's data plan.
     * The namespace (current as of that delta) gives each one's size and
     * revision, as a listing entry would.
     */
    async refillFromNamespace(supervisor, dropped) {
      const t = coherence.tables('refillFromNamespace');
      const cursor = coherence.cursor();
      if (cursor === null) return { requested: 0, filled: 0, failed: 0, bytes: 0 };
      const fetch: WantedFile[] = [];
      const seen = new Set<string>();
      for (const path of [...dropped, ...plan]) {
        if (seen.has(path)) continue;
        seen.add(path);
        if (cells.has(path)) continue;
        const row = nsRowAt(t, path);
        if (row === undefined || row.kind !== NS_FILE) continue;
        fetch.push({ path, size: row.size, rev: row.rev, epoch: cursor.epoch, ckey: null });
      }
      return fetchFiles(supervisor, fetch);
    },
    /**
     * The launch's last step before user code: the namespace must answer, since
     * every synchronous stat, exists and readdir reads it. A boot that left it
     * unready (its listing failed, came back short, or could not describe every
     * name) is repaired once more. Resolves to null when it answers, or to the
     * launch's failure, naming why; nothing is ever run on a namespace that
     * does not.
     */
    async requireNamespace(supervisor, bootFailure) {
      if (namespace.ready()) return null;
      // What stopped the repair, else the boot: why the namespace still does not answer.
      let failure = bootFailure;
      try {
        const repaired = await synchronize(supervisor);
        failure = fail(repaired) || failure;
      } catch (e) { failure = messageOf(e); }
      if (namespace.ready()) return null;
      return 'node: the process was not started: its view of the filesystem could not be listed ('
        + (failure || namespace.notReadyCause()) + ')';
    },
  };
}
