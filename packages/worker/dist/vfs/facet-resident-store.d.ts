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
 * WHAT IT ACTUALLY FREES, re-measured — smaller than first claimed
 * ────────────────────────────────────────────────────────────────
 * The figure that motivated this work — "38.5 MiB, 18.5% of the 208 MiB facet
 * ceiling, before the program allocates anything" — does not survive
 * re-measurement, and the error is worth keeping because it is easy to repeat:
 * it is a SUPERVISOR-side cost (one cached LRU entry, against a 128 MiB isolate)
 * quoted as a FACET-side one (against a 208 MiB ceiling). Two budgets, two
 * numbers, and they happen to land within 0.5% of each other by coincidence of
 * magnitude.
 *
 * Re-measured on this tree against a real 16,357-file pi install through the
 * real `buildPrefetchBundle` / `generateEntrypointCode` path:
 *
 *   facet module map (main module)        12.50 MiB
 *   parsed __MODULE_VFS_BUNDLE             8.22 MiB
 *   both co-resident at module eval        20.72 MiB   (not 38.5)
 *   supervisor co-resident at LOADER.load  21.01 MiB   (in a 128 MiB isolate)
 *
 * So adopting the bundle and releasing the parsed object frees **8.22 MiB** of
 * facet heap, not 38.5. The module source text is owned by the loader's module
 * registry and this code cannot free it; whether workerd retains it after
 * evaluation is a workerd internal that nothing in this repo decides, and it is
 * not guessed at here.
 *
 * The heap saving is therefore the SMALLEST of this store's three effects, and
 * a poor reason to adopt it on its own. The two that matter:
 *
 *   1. A data read cannot miss, because the store is not capped by admission.
 *      That is the constraint this exists to satisfy.
 *   2. Data cells need not enter the module map AT ALL. Only cells that must be
 *      `new Function`-compiled have to travel as module text; everything else
 *      can be filled straight into SQLite from the supervisor. That is what can
 *      take the 12.50 MiB main module down toward the size of the require
 *      closure alone — a far larger win than releasing the parsed object, and
 *      the one the filler below exists for.
 *
 * A related mechanism, confirmed rather than refuted: an entry larger than the
 * whole `PREFETCH_CACHE_MAX_BYTES` bound is admitted anyway and evicts every
 * other entry (`facets/manager.ts` — the `if (oldest === key) continue` branch).
 * Demonstrated: a 21.50 MiB entry left the cache 5.77 MB over its own 16 MiB
 * bound with all four prior entries gone. Whether pi specifically crosses that
 * bound is UNRESOLVED — a real pi 0.78.1 tree retains 12.04 MiB, comfortably
 * under it, and the original 21.65 MiB was measured on 0.84.1 with a warm
 * residency profile and a 119-package session. Do not repeat the pi number
 * without re-measuring it on a live session.
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
export declare const RESIDENT_CHUNK_BYTES = 1048576;
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
export declare const RESIDENT_MATERIALISE_BATCH_ROWS = 512;
/**
 * The `fsReadBatch` bounds, as the filler must respect them.
 *
 * These are not this module's to choose — they belong to the supervisor, and a
 * filler that guessed at them does not degrade gracefully: `_rpcFsReadBatch`
 * validates with zod and rejects the WHOLE call, so one over-packed batch
 * loses every path in it. Imported rather than restated as fresh literals so
 * the generated source cannot drift from the endpoint it calls.
 */
export declare const RESIDENT_FILL_BATCH_PATHS = 1024;
export declare const RESIDENT_FILL_BATCH_BYTES: number;
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
export declare const FACET_RESIDENT_STORE_SOURCE: string;
/** A cell as the facet holds it — the shape `__vfsBundle` has always carried. */
export type ResidentCell = string | Uint8Array | {
    error: 'EACCES';
};
/**
 * The store as its filler sees it. Deliberately says nothing about WHERE the
 * bytes come from: the materialiser streams them over the supervisor RPC today,
 * and `ctx.facets.clone` would hand the same rows over by reflink if the
 * decoupled-clone work lands. Neither is visible here, so neither is a rewrite.
 */
export interface ResidentStoreFiller {
    put(path: string, cell: ResidentCell, rev?: number): void;
    clear(): void;
    stats(): {
        files: number;
        bytes: number;
        databaseSize: number;
    };
}
//# sourceMappingURL=facet-resident-store.d.ts.map