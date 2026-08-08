/**
 * facet-resident-store.ts — the resident set, held in the process facet's own
 * SQLite instead of its isolate heap.
 *
 * A Nimbus process is a DO Facet whose class comes from the Worker Loader, and
 * a facet has its own SQLite (`loaders/process-fabric.ts`). That storage is
 * reachable SYNCHRONOUSLY — `ctx.storage.sql.exec` returns a Cursor, not a
 * Promise — which is the one property that matters here, because a synchronous
 * `fs.readFileSync` cannot block to fetch anything and no JS stack in workerd
 * can be suspended to let it.
 *
 * So the resident set moves off the heap and into that SQLite, and a sync read
 * becomes a point query rather than an admission decision. What that buys is
 * not a faster read — it is a read that cannot MISS: the store holds the whole
 * filesystem rather than a capped prefetch of it, so the first synchronous read
 * of a file the process has never touched is answered instead of raising
 * EAGAIN.
 *
 * Measured on production workerd (account f44999d1…, throwaway
 * `nimbus-facetsql-probe`, 2026-08-08), all client-timed because `Date.now()`
 * does not advance inside a facet across an I/O-free turn:
 *
 *   sync sql in a loader-defined facet   yes, incl. in the CONSTRUCTOR
 *   20,000 sequential reads              no microtask interleaved — one stack
 *   read cost                            ~8 us + ~1.6 us/KiB
 *                                        (10.3 us @ 1.5 KiB, 16.3 us @ 6.4 KiB,
 *                                         33.1 us @ 16 KiB)
 *   pi-shaped 1,588 reads / 10.2 MB      25.8 ms
 *   materialise 45.7 MB                  0.42-0.91 s, flat across 2.8k-30k rows
 *   full wipe 7,141 rows / 58.8 MB       ~45 ms, storage actually reclaimed
 *   max bytes in one value               2,199,981 with a 12-char key;
 *                                        over it, a clean catchable
 *                                        SQLITE_TOOBIG - not a reset
 *
 * WHAT MOVING THE RESIDENT SET DOES NOT BUY — measured, against expectation
 * ─────────────────────────────────────────────────────────────────────────
 * It was proposed that module-map staging is what stalls a large spawn, and
 * that this store deletes that stall. Measured on the same worker (task #122),
 * timing build / loader-compile / boot separately over a synthetic bundle of
 * 6,553 CJS cells:
 *
 *   corpus   source text   build    +compile   +boot(precompile)
 *    8 MiB    8,346,849 B  0.10 s     0.15 s      0.18 s
 *   16 MiB   16,704,474 B  0.12 s     0.19 s      0.69 s
 *   24 MiB   25,062,099 B  0.17 s     0.15 s      0.41 s
 *   32 MiB   33,413,349 B  0.29 s*    0.21 s      0.47 s
 *   40 MiB   41,770,974 B  0.29 s     0.93 s      1.42 s
 *
 * (* one 3.7 s outlier at 32 MiB across the series, not reproduced.)
 *
 * A 40 MiB module map builds, loads, evaluates and `new Function`-precompiles
 * all 6,553 modules in 1.42 s, with zero failures. So a 180 s stall at 40 MiB
 * is NOT workerd staging a large module map, and the `new Function` loop is not
 * the cost either — booting the same bytes with the loop removed is no faster.
 * Whatever the fork path is spending 180 s on is upstream of staging: the VFS
 * walk, the esbuild ESM→CJS pass over thousands of cells, or the per-cell
 * budget accounting. This store does delete that upstream work for data cells,
 * but the claim "it removes a live 24 MiB staging ceiling" is not supported —
 * there is no such ceiling in the staging step.
 *
 * Two numbers that look contradictory and are not: the ~0.6 s materialisation
 * above and the 180 s fork stall describe DIFFERENT operations. The first is
 * SQLite insert throughput inside a facet that already exists, over bytes
 * already in hand. It excludes acquiring those bytes from the session, and any
 * production materialiser pays that separately.
 *
 * WHAT THIS STORE DOES NOT DO, and cannot
 * ───────────────────────────────────────
 * It does not make `require()` of a module outside the precompiled closure
 * work. Measured on the same worker: `new Function` succeeds at MODULE SCOPE
 * and throws "Code generation from strings disallowed for this context" in the
 * DO constructor and at request time. Module evaluation is the only place a
 * string becomes code, and `ctx` — hence SQLite — does not exist there. So code
 * reaches a facet through the Worker Loader's module map or not at all, and
 * that is a platform boundary, not a policy this store could relax.
 *
 * The split falls out of that, and it is the whole architecture:
 *
 *   CODE cells  — the static require closure. Compiled at module eval into
 *                 `__compiledModules`, exactly as today. The source strings are
 *                 not retained afterwards; the compiled functions are the only
 *                 in-heap form, and a later `readFileSync` of a .js file is
 *                 answered from the store like any other file.
 *   EVERY OTHER — held here. Uncapped by admission, bounded only by the
 *      byte      storage budget, so a data read cannot miss.
 *
 * That boundary is drawn where the failures are. The read profile
 * (`scratchpad/node-sync-read-profile.md`) measured 97.07% of sync reads as
 * module loading and put every observed failure in the data population: tsc's
 * `lib/lib.*.d.ts`, cowsay's `cows/*.cow`, create-vite's templates. Those are
 * the reads this store answers.
 *
 * THE MISS RATE IN THAT PROFILE IS NOT USABLE AS A SIZING INPUT, and this store
 * deliberately does not use it. The profile's per-workload residue figures are
 * path-dependent: only `generateEntrypointCode` seeded the VFS coherence
 * cursor, so any resident or long-running workload in the set asked its first
 * `fsAcquire` about a null epoch, which `invalidatedSince` can only answer with
 * a poison. Such a workload lost its entire staged filesystem on its first
 * async fs call and then read every staged path as a miss — so it measured the
 * poison, not admission. Re-measure on top of the shared-cursor-seed fix before
 * treating any residue number as real.
 *
 * It does not matter here, and that is the point rather than a lucky escape:
 * this store admits the whole filesystem, so there is no admission decision for
 * a fault rate to inform. `RESIDENT_CHUNK_BYTES` comes from the measured
 * single-value ceiling and `RESIDENT_MATERIALISE_BATCH_ROWS` from the observed
 * turn reset; neither is a function of how often a read misses. A design whose
 * correctness depends on predicting the miss set is the design this one exists
 * to replace.
 *
 * TWO CONSTRAINTS THIS STORE INHERITS FROM THAT BUG, both structural here
 * ──────────────────────────────────────────────────────────────────────
 * The cursor-seed defect was a coherence preamble hand-copied into three
 * generators, two of which drifted. So: this store is ONE exported source
 * constant, spliced wherever it is needed, with no second implementation to
 * drift — the posture `VFS_WRITE_LEDGER_SOURCE` already takes.
 *
 * And nothing per-spawn is in its text. Both node bodies are content-addressed
 * (one-shot by hash(code+bundle+manifest), resident by facet-image digest), and
 * baking a per-spawn cursor into the generated source broke image dedup when it
 * was tried. `FACET_RESIDENT_STORE_SOURCE` carries only the two constants
 * above; the cursor arrives at runtime through `__residentAdmit`, so the text
 * stays identical across spawns and the digest keeps deduping.
 *
 * One cost this store pays that the heap version does not: a poison is a full
 * repopulation, not a lazy refetch. That raises the price of exactly the defect
 * described above, and is the reason the cursor is PERSISTED beside the rows —
 * a fresh incarnation resumes from a real cursor instead of a null epoch, so it
 * asks for a delta rather than inviting a poison.
 */

/**
 * Bytes of file content in one row.
 *
 * The measured ceiling is 2,199,981 bytes in a single value (bisected, with a
 * 12-char key; the limit is on the row, so a longer path buys less). 1 MiB
 * leaves better than 2x of headroom against a limit whose exact form is not
 * contractual, and keeps the per-read allocation of a large file bounded.
 * Files at or under it — effectively all of them — are one row and one query.
 */
export const RESIDENT_CHUNK_BYTES = 1_048_576;

/**
 * Rows written before the materialiser yields.
 *
 * Not a throughput knob: a single turn that wrote 45.7 MB reset the object once
 * with "Internal error in Durable Object storage caused object to be reset",
 * and the same write then succeeded 12 times out of 12 on retry. So the size
 * alone does not predict it and the reset is not something to catch — it
 * destroys the destination. Yielding bounds what any one turn has outstanding
 * rather than betting on the threshold.
 */
export const RESIDENT_MATERIALISE_BATCH_ROWS = 512;

/**
 * The in-facet store. Spliced into the generated module ahead of the shims, in
 * the same way `VFS_WRITE_LEDGER_SOURCE` is (`facets/manager.ts`), because it
 * has to close over the same module scope the shims read `__vfsBundle` from.
 *
 * It presents a Proxy rather than a new API on purpose. `_bundleLookup`,
 * `_writtenCell`, `__readFileOr`, `__fileExists` and the directory scans all
 * reach the resident set as a plain object — `k in b`, `b[k]`, `Object.keys(b)`,
 * `delete b[k]` — across a dozen call sites in `runtime/node-shims.ts`. A Proxy
 * keeps every one of them correct with no edit, and it is the shape the ledger
 * already uses for `__vfsWrites`, so this is the codebase's existing idiom
 * rather than a new one.
 */
export const FACET_RESIDENT_STORE_SOURCE = `
// The facet's own SQLite, bound once the DO exists. Module scope has no ctx,
// so every trap below runs in handler context, which is also the only context
// that reads the resident set.
let __residentSql = null;
let __residentReady = false;

/**
 * Reads are SEALED until this incarnation has reconciled the store against the
 * authority. This is the whole coherence design, and it is a seal rather than a
 * check because a check gets forgotten.
 *
 * The hazard is specific to putting the resident set in storage, and it is
 * created by the property that makes the design affordable: a facet's SQLite
 * survives a fresh module scope (measured — same facet name, new loader key,
 * new module token, 7,141 rows and 45.7 MB intact). So a new incarnation opens
 * onto rows written by a PREVIOUS one, while every in-heap stamp and cursor
 * that described them is gone. Heap-side provenance cannot survive the thing it
 * is meant to describe, so provenance lives in the rows: 'file.rev' per path,
 * '(epoch, rev)' for the store, both in this SQLite.
 *
 * Sealed is the initial state and \`__residentAdmit\` is the only thing that
 * clears it, so a row cannot be served by an incarnation that has not applied
 * the authority's delta. There is one gate and it is on the only door —
 * \`__residentRequire\`, which every read, scan and write goes through.
 */
let __residentSealed = true;
let __residentSealReason = "the store has not reconciled with the authority in this incarnation";

const __RESIDENT_CHUNK_BYTES = ${RESIDENT_CHUNK_BYTES};
const __RESIDENT_BATCH_ROWS = ${RESIDENT_MATERIALISE_BATCH_ROWS};

/**
 * Cell kinds. A cell is one of the three things __vfsBundle has always held,
 * and the kind is stored rather than inferred so a text file whose bytes happen
 * to be valid UTF-8 does not change shape between a write and a read.
 */
const __RK_TEXT = 0;
const __RK_BINARY = 1;
const __RK_DENIED = 2;

function __residentBind(ctx) {
  const sql = ctx && ctx.storage && ctx.storage.sql;
  if (!sql || typeof sql.exec !== "function") {
    throw new Error(
      "Nimbus: this facet has no synchronous SQLite (ctx.storage.sql); " +
      "the resident set cannot be served and every sync read would raise EAGAIN"
    );
  }
  // 'file' carries one row per path, so existence, size and kind are one query
  // that never touches content. 'chunk' carries the bytes. Splitting them is
  // what makes _statLadder and __fileExists cheap: the common case reads a
  // short row and never pages a megabyte of blob in to answer "is it there".
  sql.exec(
    "CREATE TABLE IF NOT EXISTS file (" +
      "path TEXT PRIMARY KEY, kind INTEGER NOT NULL, size INTEGER NOT NULL, " +
      "chunks INTEGER NOT NULL, rev INTEGER" +
    ")"
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS chunk (" +
      "path TEXT NOT NULL, part INTEGER NOT NULL, txt TEXT, bin BLOB, " +
      "PRIMARY KEY (path, part)" +
    ")"
  );
  // The store's own cursor, in the same storage as the rows it describes, so
  // the two cannot be separated by an isolate restart.
  sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  __residentSql = sql;
  __residentReady = true;
  return sql;
}

function __residentRequire() {
  if (!__residentReady) {
    throw new Error(
      "Nimbus: the resident store was read before its facet bound its SQLite. " +
      "__residentBind(ctx) must run in the process DO constructor, ahead of the program."
    );
  }
  if (__residentSealed) {
    throw new Error(
      "Nimbus: the resident store is sealed — " + __residentSealReason + ". " +
      "__residentAdmit(fsAcquire(...)) must apply the authority's delta before " +
      "the program runs; serving a row now would serve bytes of unknown age."
    );
  }
  return __residentSql;
}

/** The persisted cursor, or null when this store has never been populated. */
function __residentCursor() {
  if (!__residentReady) return null;
  let epoch = null, rev = null;
  for (const row of __residentSql.exec("SELECT k, v FROM meta WHERE k IN ('epoch','rev')")) {
    if (row.k === "epoch") epoch = String(row.v);
    else rev = Number(row.v);
  }
  return epoch === null || rev === null ? null : { epoch, rev };
}

/**
 * Apply one authority delta and unseal.
 *
 * \`result\` is exactly what \`supervisor.fsAcquire(epoch, cursor)\` returns
 * (\`VfsAcquireResult\` — runtime/os-contracts.ts), so this store slots into the
 * ACQUIRE/RELEASE protocol the shims already run rather than beside it. One
 * cache, one invariant.
 *
 * Returns the paths that WERE held and are now gone, which is what
 * \`_acquireAndRefetch\` re-reads live — the same contract \`_acquireBarrier\`
 * already has.
 */
function __residentAdmit(result) {
  if (!__residentReady) throw new Error("Nimbus: __residentAdmit before __residentBind");
  const sql = __residentSql;
  const dropped = [];
  if (!result || result.poison) {
    // Poison means the authority cannot describe the distance from our cursor
    // to now. Nothing held can be vouched for, so nothing is kept. Two
    // statements rather than a delete per path: a poison at pi scale is 7,141
    // rows, and eviction is on the hot path (measured 45 ms whole-store, vs a
    // per-row walk).
    sql.exec("DELETE FROM chunk");
    sql.exec("DELETE FROM file");
  } else if (Array.isArray(result.paths)) {
    for (const entry of result.paths) {
      const path = entry.path;
      // A stamped row at or above the reported revision is this facet's own
      // write coming back; anything else is someone else's and is dropped.
      let held = false, stamped = null;
      for (const row of sql.exec("SELECT rev FROM file WHERE path = ?", path)) {
        held = true; stamped = row.rev == null ? null : Number(row.rev);
      }
      if (!held) continue;
      if (stamped !== null && stamped >= Number(entry.rev)) continue;
      sql.exec("DELETE FROM chunk WHERE path = ?", path);
      sql.exec("DELETE FROM file WHERE path = ?", path);
      dropped.push(path);
    }
  }
  const epoch = result && result.epoch != null ? String(result.epoch) : null;
  const rev = result && result.rev != null ? Number(result.rev) : null;
  if (epoch === null || rev === null) {
    throw new Error(
      "Nimbus: fsAcquire returned no cursor; the resident store stays sealed " +
      "rather than serving rows it cannot date"
    );
  }
  sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('epoch', ?)", epoch);
  sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('rev', ?)", String(rev));
  __residentSealed = false;
  __residentSealReason = "";
  return { dropped, cursor: { epoch, rev } };
}

/** Re-seal — for a store whose backing is being replaced (slot handover). */
function __residentSeal(reason) {
  __residentSealed = true;
  __residentSealReason = String(reason || "resealed");
}

/** One row of 'file', or undefined. The existence/shape query. */
function __residentHead(path) {
  const sql = __residentRequire();
  return __residentHeadOn(sql, path);
}

function __residentHeadOn(sql, path) {
  for (const row of sql.exec("SELECT kind, size, chunks FROM file WHERE path = ?", path)) return row;
  return undefined;
}

/**
 * The synchronous read. THE point of this module: a plain, non-async function
 * that returns content, so a fs.readFileSync call stack never has to yield.
 *
 * Returns exactly what __vfsBundle has always returned — a string, a
 * Uint8Array, or an { error: "EACCES" } denial — or undefined for a cell that
 * is not held.
 */
function __residentGet(path) {
  const head = __residentHead(path);
  if (head === undefined) return undefined;
  const kind = Number(head.kind);
  if (kind === __RK_DENIED) return { error: "EACCES" };
  const sql = __residentRequire();
  const chunks = Number(head.chunks);
  if (chunks === 1) {
    for (const row of sql.exec("SELECT txt, bin FROM chunk WHERE path = ? AND part = 0", path)) {
      return kind === __RK_TEXT ? row.txt : __residentBytes(row.bin);
    }
    return undefined;
  }
  // Chunked: a file past the single-value ceiling. Reassembled here so callers
  // never learn the file was split.
  const parts = [];
  for (const row of sql.exec("SELECT txt, bin FROM chunk WHERE path = ? ORDER BY part", path)) {
    parts.push(kind === __RK_TEXT ? row.txt : __residentBytes(row.bin));
  }
  if (parts.length === 0) return undefined;
  if (kind === __RK_TEXT) return parts.join("");
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

function __residentBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(0);
}

/**
 * Write one cell, chunking past the single-value ceiling.
 *
 * \`rev\` is the authority revision these bytes were read at, and it is what
 * makes the row datable. NULL means the cell is this facet's own unflushed
 * write — always readable (read-your-writes) and never mistaken for something
 * the authority vouched for.
 */
function __residentPut(sql, path, cell, rev) {
  sql.exec("DELETE FROM chunk WHERE path = ?", path);
  if (cell && typeof cell === "object" && cell.error) {
    sql.exec(
      "INSERT OR REPLACE INTO file (path, kind, size, chunks, rev) VALUES (?, ?, 0, 0, ?)",
      path, __RK_DENIED, rev ?? null
    );
    return;
  }
  const isText = typeof cell === "string";
  const kind = isText ? __RK_TEXT : __RK_BINARY;
  const body = isText ? cell : __residentBytes(cell);
  const size = isText ? body.length : body.byteLength;
  // Chunk on the encoded length for text, since the ceiling is on bytes and a
  // multi-byte string would otherwise cross it while measuring short.
  const limit = isText ? Math.floor(__RESIDENT_CHUNK_BYTES / 3) : __RESIDENT_CHUNK_BYTES;
  const chunks = Math.max(1, Math.ceil(size / limit));
  for (let part = 0; part < chunks; part++) {
    const slice = body.slice(part * limit, (part + 1) * limit);
    if (isText) sql.exec("INSERT INTO chunk (path, part, txt) VALUES (?, ?, ?)", path, part, slice);
    else sql.exec("INSERT INTO chunk (path, part, bin) VALUES (?, ?, ?)", path, part, slice);
  }
  sql.exec(
    "INSERT OR REPLACE INTO file (path, kind, size, chunks, rev) VALUES (?, ?, ?, ?, ?)",
    path, kind, size, chunks, rev ?? null
  );
}

function __residentDelete(sql, path) {
  const had = __residentHead(path) !== undefined;
  sql.exec("DELETE FROM chunk WHERE path = ?", path);
  sql.exec("DELETE FROM file WHERE path = ?", path);
  return had;
}

/**
 * The filler's door: write a cell whose provenance is the authority revision it
 * was read at. Legal while SEALED, because populating is exactly what a sealed
 * store is for — the seal stops READS of undated rows, not the writes that date
 * them.
 */
function __residentPopulate(path, cell, rev) {
  if (!__residentReady) throw new Error("Nimbus: __residentPopulate before __residentBind");
  if (typeof rev !== "number") {
    throw new Error(
      "Nimbus: refusing to populate '" + path + "' with no authority revision. " +
      "An undated row cannot be invalidated, so it would be served stale forever."
    );
  }
  __residentPut(__residentSql, path, cell, rev);
}

/**
 * The revision a cell is known-good at — the same stamp __vfsBundleRevisions
 * held in heap, moved into the row it describes so the two cannot drift. Only
 * a flush of this facet's own bytes sets one; the ACQUIRE barrier is the only
 * reader; an unstamped cell is simply evicted. Preserved verbatim from
 * _shared/vfs-write-ledger.ts, because a store that dropped it would make every
 * flush evict the facet's own output.
 */
function __residentStamp(path, rev) {
  __residentSql.exec("UPDATE file SET rev = ? WHERE path = ?", rev, path);
}

function __residentRevision(path) {
  const sql = __residentRequire();
  for (const row of sql.exec("SELECT rev FROM file WHERE path = ?", path)) {
    return row.rev == null ? undefined : Number(row.rev);
  }
  return undefined;
}

/** Every held path. Backs the Object.keys / for-in scans in the shims. */
function __residentKeys() {
  const out = [];
  for (const row of __residentRequire().exec("SELECT path FROM file")) out.push(String(row.path));
  return out;
}

/**
 * Paths under a directory prefix, without materialising the whole key set.
 *
 * The shims scan the resident set by prefix in nine places — readdirSync's
 * union with the manifest, existsSync of a directory, rm -rf, watch globbing.
 * In heap those were for-in loops over every key; here they are an index range
 * scan, which is the one place this store is strictly better rather than
 * merely affordable.
 */
function __residentKeysUnder(prefix) {
  const out = [];
  const like = String(prefix).replace(/([%_\\\\])/g, "\\\\$1") + "%";
  for (const row of __residentRequire().exec(
    "SELECT path FROM file WHERE path >= ? AND path LIKE ? ESCAPE '\\\\'", prefix, like
  )) out.push(String(row.path));
  return out;
}

/**
 * Drop every cell AND the cursor, and re-seal.
 *
 * This is slot handover, not invalidation: a returned slot must not hand the
 * next tenant a filesystem, and dropping the rows while leaving a cursor behind
 * would leave the store claiming to be current at a revision it holds nothing
 * from. Clearing the cursor forces the next incarnation through
 * \`__residentAdmit\` from scratch.
 */
function __residentClear() {
  if (!__residentReady) throw new Error("Nimbus: __residentClear before __residentBind");
  const sql = __residentSql;
  sql.exec("DELETE FROM chunk");
  sql.exec("DELETE FROM file");
  sql.exec("DELETE FROM meta");
  __residentSeal("the store was cleared for slot reuse");
}

function __residentStats() {
  if (!__residentReady) throw new Error("Nimbus: __residentStats before __residentBind");
  const sql = __residentSql;
  let files = 0, bytes = 0;
  for (const row of sql.exec("SELECT count(*) AS n, coalesce(sum(size), 0) AS b FROM file")) {
    files = Number(row.n); bytes = Number(row.b);
  }
  return {
    files, bytes,
    databaseSize: Number(sql.databaseSize ?? 0),
    sealed: __residentSealed,
    cursor: __residentCursor(),
  };
}

/**
 * The resident set, as the shims have always seen it.
 *
 * Every trap is synchronous, because every reader of __vfsBundle is.
 */
const __nimbusResidentBundle = new Proxy(Object.create(null), {
  get(_t, path) {
    if (typeof path !== "string") return undefined;
    return __residentGet(path);
  },
  has(_t, path) {
    if (typeof path !== "string") return false;
    return __residentHead(path) !== undefined;
  },
  set(_t, path, cell) {
    // The program's own write. Undated on purpose: it is not the authority's
    // yet, and the ledger stamps it when the write-back lands.
    if (typeof path !== "string") return true;
    __residentPut(__residentRequire(), path, cell, undefined);
    return true;
  },
  deleteProperty(_t, path) {
    if (typeof path === "string") __residentDelete(__residentRequire(), path);
    return true;
  },
  ownKeys() { return __residentKeys(); },
  getOwnPropertyDescriptor(_t, path) {
    if (typeof path !== "string") return undefined;
    if (__residentHead(path) === undefined) return undefined;
    // Configurable so 'delete' is legal and enumerable so for-in and
    // Object.keys see it — the two things every scan site depends on.
    return { configurable: true, enumerable: true, writable: true, value: __residentGet(path) };
  },
});
`.trim();

/** A cell as the facet holds it — the shape `__vfsBundle` has always carried. */
export type ResidentCell = string | Uint8Array | { error: 'EACCES' };

/**
 * The store as its filler sees it. Deliberately says nothing about WHERE the
 * bytes come from: the materialiser streams them over the supervisor RPC today,
 * and `ctx.facets.clone` would hand the same rows over by reflink if the
 * decoupled-clone work lands. Neither is visible here, so neither is a rewrite.
 */
export interface ResidentStoreFiller {
  put(path: string, cell: ResidentCell, rev?: number): void;
  clear(): void;
  stats(): { files: number; bytes: number; databaseSize: number };
}
