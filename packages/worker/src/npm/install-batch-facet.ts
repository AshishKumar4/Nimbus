/**
 * npm-install-batch-facet.ts — single-facet batch installer.
 *
 * Why this exists
 * ───────────────
 * The previous architecture (src/npm-install-facet.ts + pool.map) spawned
 * ONE dynamic worker per pool slot. With concurrency=4, that's 4 permanent
 * loader entries in workerd's loader cache (each `loader.get(id, …)` call
 * is cached by id and the cache is never released — confirmed in
 * src/parallel/facet-pool.ts:328-348). Combine with:
 *   - resolver-facet pool: 1 loader entry
 *   - fetch-proxy: 1 loader entry
 *   - pre-bundle pool: 1 effective entry
 *   - install pool.map: 4 entries
 * = 7 concurrent dynamic workers, tripping workerd's per-DO cap with
 * "Too many concurrent dynamic workers" the moment install-pool tries
 * to spawn its 4th slot.
 *
 * The fix: ONE facet for the whole install batch. The facet receives
 * the full FacetPackageSpec[] and loops internally with pLimit(3),
 * producing 1 loader entry instead of 4. Same architectural shape as
 * src/npm-resolve-facet.ts — proven to work in production (commit 9194998).
 *
 * The shared producer wave pre-flushes before 4 MiB or 128 paths. One
 * oversize file may occupy a wave by itself; the supervisor's weighted
 * credit pool and transaction builder remain the authoritative hard bounds.
 *
 * The per-package logic (fetch + integrity-verify + gunzip + tar-parse +
 * writeBatch flush) is identical to src/npm-install-facet.ts — kept
 * inlined here as a closure rather than imported because cloudflare-parallel
 * serializes via fn.toString() and we cannot import from sibling modules
 * across the isolate boundary. If the per-package logic in the legacy
 * facet changes, mirror the change here.
 *
 * Stability invariants (cloudflare-parallel):
 *   - No `this` references.
 *   - No closure capture other than args + preamble names.
 *   - Preamble symbols (streamTarEntries, readableStreamToAsyncIterable,
 *     MAX_FILE_BYTES) referenced via @ts-ignore.
 */

import type { FacetPackageSpec } from './install-facet.js';
import type { WriteBatchStreamResult } from '../vfs/sqlite-vfs.js';

declare const __nimbusUseRpcResult: <T, R>(
  promise: Promise<T>,
  use: (value: T) => R | Promise<R>,
) => Promise<R>;

// ── Types exchanged between supervisor and facet ────────────────────────

export interface InstallBatchSpec {
  /** All packages to install in this batch. ≈456 entries × ~200 B = ~90 KB,
   *  well under workerd's 32 MiB RPC arg cap. */
  packages: FacetPackageSpec[];
  /** Internal pLimit cap for concurrent tarball download/decompression pipelines. */
  concurrency: number;
}

export interface InstallBatchPerPackage {
  name: string;
  version: string;
  fileCount: number;
  bytesWritten: number;
  elapsed: number;
  warnings: string[];
  /** When set, the package failed; caller surfaces this in install log. */
  errorText?: string;
}

export interface InstallBatchResult {
  /** One entry per input spec, in input order. */
  perPackage: InstallBatchPerPackage[];
  /** Wall-clock ms inside the facet (whole batch). */
  elapsed: number;
  /** Counter snapshot at end of batch. Mirrors src/diag-counters.ts shape
   *  for the install-facet subset (commit 3 surfaces these in /api/_diag/memory). */
  facetCounters: {
    tarballsCompleted: number;
    cumulativeBytesDecoded: number;
    peakInFlight: number;
    /** W4: pipelined-RPC race outcomes for tarballs. Folded into the
     *  supervisor's diag.r2.pipelinedTarballRace* counters via
     *  recordR2RaceCounters() in npm-installer. */
    pipelinedTarballRaceWins: number;
    pipelinedTarballRaceLosses: number;
  };
  /**
   * cache-obs-2: per-tier cache events captured during this batch.
   *
   * Each entry records a single L2/L3/L4 hit-or-miss observed when
   * fetching a tarball. L2/L3 events flow up from the supervisor RPC
   * return values (getCachedTarball.events); L4 events are pushed
   * directly by the facet after a successful registry fetch.
   *
   * Folded into the DO-side cache-stats singleton by installer.ts via
   * recordCacheStatEvents — same pattern as recordR2RaceCounters.
   */
  cacheStatEvents: Array<
    | { kind: 'hit'; tier: 'L2' | 'L3' | 'L4'; cacheKind: 'tarball'; bytes: number }
    | { kind: 'miss'; tier: 'L2' | 'L3' | 'L4'; cacheKind: 'tarball' }
  >;
}

// ── Facet function ──────────────────────────────────────────────────────
//
// Runs inside a NimbusLoaderPool isolate. Serialised via fn.toString();
// the helpers it references at top-level scope (streamTarEntries,
// readableStreamToAsyncIterable, MAX_FILE_BYTES) are NOT in the facet's
// lexical scope — the pool injects them via the preamble. No static
// imports of those names; references are bare identifiers.

export const installPackagesInFacet = async function installPackagesInFacet(
  batch: InstallBatchSpec,
  env: {
    SUPERVISOR: {
      // [W7] Streaming bulk-write RPC. Bypasses the 32 MiB structured-clone
      // cap by sending the batch as a type:'bytes' ReadableStream<Uint8Array>
      // (W7 wire protocol — see src/_shared/w7-frame.ts).
      writeBatchStream: (stream: ReadableStream<Uint8Array>) => Promise<WriteBatchStreamResult>;
      // [W4 + cache-obs-2] Optional R2-cache RPC. Return shape evolved:
      //   v1 (deployed): Uint8Array | null
      //   cache-obs-2:   { bytes: Uint8Array | null, events: ... }
      // The facet adapts to BOTH shapes via runtime check (older
      // supervisor deployments still return the v1 bare bytes shape).
      // Once main has cache-obs-2 for >7d we can drop the v1 branch.
      getCachedTarball?: (
        name: string,
        version: string,
      ) => Promise<
        | Uint8Array
        | null
        | {
            bytes: Uint8Array | null;
            events: Array<
              | { kind: 'hit'; tier: string; cacheKind: string; bytes: number }
              | { kind: 'miss'; tier: string; cacheKind: string }
            >;
          }
      >;
      putCachedTarball?: (name: string, version: string, bytes: Uint8Array | ArrayBuffer) => Promise<boolean>;
    };
  },
): Promise<InstallBatchResult> {
  const tBatchStart = Date.now();

  if (!batch || typeof batch !== 'object' || !Array.isArray(batch.packages)) {
    throw new Error('installPackagesInFacet: missing batch.packages');
  }
  if (!env || !env.SUPERVISOR || typeof env.SUPERVISOR.writeBatchStream !== 'function') {
    throw new Error('installPackagesInFacet: env.SUPERVISOR.writeBatchStream missing');
  }

  // [W4] Cap on how long we wait for the R2 cache before committing to
  // the network response. 300 ms is generous enough for a regional R2
  // GET (typically 30-100 ms) but bounds worst-case loss on a miss.
  // Tunable; if cache hit-rate plateau is high in prod, raising this
  // slightly may capture more wins on slow colos.
  const R2_RACE_TIMEOUT_MS = 300;

  const concurrency = Math.max(1, Math.min(batch.concurrency ?? 3, 8));

  // ── pLimit (inlined; preamble doesn't carry a limiter helper) ────────
  // Identical semantics to src/npm-resolver.ts:31-50 / src/npm-resolve-facet.ts.
  let active = 0;
  const queue: (() => void)[] = [];
  const limit = <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const run = async () => {
        active++;
        try { resolve(await fn()); }
        catch (e) { reject(e); }
        finally {
          active--;
          if (queue.length > 0) queue.shift()!();
        }
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
  };

  // ── Counters (facet-local; folded into result.facetCounters at end) ──
  let inFlight = 0;
  let inFlightPeak = 0;
  let cumulativeBytesDecoded = 0; // bytes of tarball body successfully read
  let tarballsCompleted = 0;
  // [W4] Pipelined-RPC race outcomes, folded back into supervisor diag.
  let pipelinedTarballRaceWins = 0;
  let pipelinedTarballRaceLosses = 0;
  // cache-obs-2: per-tier event accumulator. Filled in the L2/L3
  // (supervisor RPC return.events) and L4 (post-network-fetch)
  // branches. Returned in result.cacheStatEvents at the end of the
  // batch. installer.ts folds these into the DO-side cache-stats
  // singleton via recordCacheStatEvents — same pattern as
  // recordR2RaceCounters at installer.ts:1168.
  const cacheStatEvents: InstallBatchResult['cacheStatEvents'] = [];

  // ── [COORDINATOR-OVERLOAD P0a wave 2] Shared flush buffer ────────────
  //
  // core WASI fix (semaphore + adaptive shard cap to 16) was insufficient:
  // post-deploy Markflow 620 install still produced 270 overload errors
  // because each installOne() had its OWN inodes/chunks/flush scope, so
  // every package emitted at least one writeBatchStream RPC at end-of-
  // tarball — 620 packages = 620+ RPCs. Workerd's input-gate queue-age
  // guard fires when this many RPCs queue up at the coordinator.
  //
  // filesystem WASI fix: share the inode/chunk accumulator across ALL packages
  // in a peer's shard. Flushes are per-peer-shard, not per-package, so
  // a 39-pkg-per-peer install emits ~3-5 RPCs (depending on tarball
  // sizes) instead of 39+. Total RPCs across the install drop from
  // ~620 to ~50, well under the queue-age threshold.
  //
  // Concurrency: the inner pLimit(3) calls installOne concurrently;
  // installOne body always awaits flush() inline (never spawns into
  // a separate microtask), and flush() is itself async-mutex-style
  // ordered by JS event-loop turns. To prevent two concurrent installs
  // from both calling flush() and racing on the shared arrays, we
  // serialize flushes through a single in-flight promise (sharedFlushP).
  type InodeT = {
    path: string; parentPath: string; isDir: boolean;
    size: number; mtime: number; mode: number; chunkCount: number;
  };
  type ChunkT = { path: string; chunkId: number; data: Uint8Array };
  type SharedWaveOutcome =
    | { ok: true }
    | { ok: false; message: string };
  // Shared-buffer flushes happen across packages, so smaller chunks keep
  // individual write transactions short and avoid aging the parent RPC.
  const SHARED_RPC_FLUSH_THRESHOLD = 4 * 1024 * 1024;
  const SHARED_RPC_PATH_LIMIT = 128;
  const INODE_OVERHEAD = 160;
  const CHUNK_OVERHEAD = 96;
  let sharedInodes = new Map<string, InodeT>();
  let sharedChunks: ChunkT[] = [];
  let sharedBufferedBytes = 0;
  let sharedOwners = new Set<number>();
  const ownerWaves = new Map<number, Set<Promise<SharedWaveOutcome>>>();
  const ownersWithCompletionMarker = new Set<number>();
  const completionMarkers = new Map<number, {
    path: string;
    data: Uint8Array;
    mtime: number;
    chunkSize: number;
  }>();
  // Mutex: only one flush runs at a time. Concurrent installs awaiting
  // flush() will line up behind this promise and resolve in arrival
  // order — the W7 frame is opaque to ordering so this is safe.
  let sharedFlushInFlight: Promise<void> | null = null;
  let sharedMutationInFlight: Promise<void> = Promise.resolve();
  const withSharedMutation = async <T>(action: () => Promise<T>): Promise<T> => {
    const prior = sharedMutationInFlight;
    let release!: () => void;
    sharedMutationInFlight = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await action(); }
    finally { release(); }
  };
  const doSharedFlush = async (): Promise<void> => {
    if (sharedInodes.size === 0 && sharedChunks.length === 0) return;
    // Snapshot current contents and reset the buffer BEFORE awaiting
    // the RPC so a concurrent install can start filling the next batch.
    const inodesNow = [...sharedInodes.values()];
    const chunksNow = sharedChunks;
    sharedInodes = new Map<string, InodeT>();
    sharedChunks = [];
    sharedBufferedBytes = 0;
    const ownersNow = sharedOwners;
    sharedOwners = new Set<number>();

    // One promise owns this exact wave. Register the SAME settled outcome
    // with every contributing package before awaiting the RPC, so a package
    // cannot report success while another package happens to be the caller
    // that triggered its shared flush.
    const wave = (async (): Promise<SharedWaveOutcome> => {
      try {
        // @ts-ignore — preamble symbol.
        const stream = encodeWriteBatchStream({ inodes: inodesNow, chunks: chunksNow });
        return await __nimbusUseRpcResult(
          env.SUPERVISOR.writeBatchStream(stream),
          (result): SharedWaveOutcome => {
            if (result.ok) return { ok: true };
            return {
              ok: false,
              message:
                `writeBatchStream failed after group ${result.committedGroupSequence} ` +
                `(${result.committedPathCount} committed paths): ${result.error.message}`,
            };
          },
        );
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    })();
    for (const owner of ownersNow) {
      let waves = ownerWaves.get(owner);
      if (!waves) {
        waves = new Set<Promise<SharedWaveOutcome>>();
        ownerWaves.set(owner, waves);
      }
      waves.add(wave);
    }

    await wave;
  };
  const sharedFlush = async (): Promise<void> => {
    // Serialize: wait for any in-flight flush to complete first; then
    // start ours. Subsequent waiters chain after this one. Promise
    // chain is unbounded but each link is awaited once — no leaks.
    const prior = sharedFlushInFlight;
    const myFlush = (async () => {
      if (prior) {
        // The prior wave's outcome is already attached to every owner that
        // contributed to it. Continue draining this independent buffer so its
        // owners receive their own outcome as well.
        try { await prior; } catch { /* owner reconciliation surfaces it */ }
      }
      await doSharedFlush();
    })();
    sharedFlushInFlight = myFlush;
    try { await myFlush; }
    finally {
      // If we're still the head of the chain, clear the slot so memory
      // doesn't grow unbounded over a long install.
      if (sharedFlushInFlight === myFlush) sharedFlushInFlight = null;
    }
  };

  const preflushSharedMutation = async (
    path: string,
    additionalBytes: number,
  ): Promise<void> => {
    if (sharedInodes.has(path)) {
      throw new Error(`duplicate path in npm write wave: ${path}`);
    }
    while (sharedInodes.size > 0 && (
      sharedBufferedBytes + additionalBytes > SHARED_RPC_FLUSH_THRESHOLD
      || sharedInodes.size + 1 > SHARED_RPC_PATH_LIMIT
    )) {
      await sharedFlush();
    }
  };

  const enqueueSharedFile = (
    ownerId: number,
    filePath: string,
    data: Uint8Array,
    mtime: number,
    chunkSize: number,
  ): Promise<void> => withSharedMutation(async () => {
    const size = data.length;
    const chunkCount = size === 0 ? 0 : Math.ceil(size / chunkSize);
    const additionalBytes = INODE_OVERHEAD + filePath.length * 2
      + size + (chunkCount * (CHUNK_OVERHEAD + filePath.length));
    await preflushSharedMutation(filePath, additionalBytes);
    sharedOwners.add(ownerId);
    sharedInodes.set(filePath, {
      path: filePath,
      parentPath: filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '',
      isDir: false,
      size,
      mtime,
      mode: 0o644,
      chunkCount,
    });
    sharedBufferedBytes += INODE_OVERHEAD + filePath.length * 2;
    if (size <= 0) return;
    if (size <= chunkSize) {
      sharedChunks.push({ path: filePath, chunkId: 0, data });
      sharedBufferedBytes += CHUNK_OVERHEAD + filePath.length + data.length;
      return;
    }
    for (let chunkId = 0; chunkId < chunkCount; chunkId++) {
      const slice = data.slice(
        chunkId * chunkSize,
        (chunkId + 1) * chunkSize,
      );
      sharedChunks.push({ path: filePath, chunkId, data: slice });
      sharedBufferedBytes += CHUNK_OVERHEAD + filePath.length + slice.length;
    }
  });

  const enqueueSharedDirectory = (
    ownerId: number,
    path: string,
    mtime: number,
  ): Promise<void> => withSharedMutation(async () => {
    const existing = sharedInodes.get(path);
    if (existing) {
      if (!existing.isDir) throw new Error(`file/directory collision in npm write wave: ${path}`);
      sharedOwners.add(ownerId);
      return;
    }
    const additionalBytes = INODE_OVERHEAD + path.length * 2;
    await preflushSharedMutation(path, additionalBytes);
    sharedOwners.add(ownerId);
    sharedInodes.set(path, {
      path,
      parentPath: path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '',
      isDir: true,
      size: 0,
      mtime,
      mode: 0o755,
      chunkCount: 0,
    });
    sharedBufferedBytes += additionalBytes;
  });

  // ── Per-package install (inlined fetchAndStagePackage logic) ─────────
  //
  // Mirrors src/npm-install-facet.ts:fetchAndStagePackage. Kept inline
  // because cloudflare-parallel serializes this whole function via
  // fn.toString() — we cannot import from a sibling module across the
  // isolate boundary. Keep this logic in sync with npm-install-facet.ts.
  const installOne = async (
    spec: FacetPackageSpec,
    ownerId: number,
  ): Promise<InstallBatchPerPackage> => {
    const t0 = Date.now();
    const warnings: string[] = [];

    inFlight++;
    if (inFlight > inFlightPeak) inFlightPeak = inFlight;

    try {
      // [W4] 1a. Race R2 cache lookup against network fetch.
      //
      // Strategy: kick BOTH off concurrently. Wait at most R2_RACE_TIMEOUT_MS
      // for the R2 GET; if R2 returns first AND the bytes pass integrity,
      // we use them and the network leg gets cancelled. Otherwise the
      // network response (which has been making progress in the
      // background) takes over.
      //
      // Soft-fail: if env.SUPERVISOR.getCachedTarball isn't defined
      // (older supervisor deployment), the R2 leg becomes a noop and
      // we go straight to the network path with no overhead.
      const r2Available = typeof env.SUPERVISOR.getCachedTarball === 'function';
      // cache-obs-2: supervisor return shape evolved from `Uint8Array
      // | null` to `{ bytes, events }`. The race wrapper handles both:
      // a v1 supervisor returns bare bytes (or null); a v2 supervisor
      // returns the envelope. The downstream code only needs `bytes`
      // — the envelope's events are spliced into cacheStatEvents.
      const r2P: Promise<
        | Uint8Array
        | null
        | { bytes: Uint8Array | null; events: any[] }
      > = r2Available
        ? Promise.race([
            __nimbusUseRpcResult(
              env.SUPERVISOR.getCachedTarball!(spec.name, spec.version),
              (result) => result,
            ),
            new Promise<null>((rs) => setTimeout(() => rs(null), R2_RACE_TIMEOUT_MS)),
          ]).catch(() => null)
        : Promise.resolve(null);

      // [W4] Captured compressed bytes for write-back to R2 on miss.
      // Populated by the integrity-tee path below; remains null when
      // integrity isn't present (rare; we only writeback when we can
      // verify on next read). Hoisted to installOne scope per W4-plan
      // §11 finding #4 lifecycle correctness.
      let capturedTgzBytes: Uint8Array | null = null;
      let r2HitBytes: Uint8Array | null = null;

      // 1b. Try R2 first (bounded wait).
      if (r2Available) {
        try {
          const r2Result = await r2P;
          // Adapt to BOTH supervisor return shapes:
          //   v1: Uint8Array | null
          //   v2: { bytes: Uint8Array | null, events: [...] }
          if (r2Result && typeof r2Result === 'object' && !(r2Result instanceof Uint8Array)) {
            const env2 = r2Result as { bytes: Uint8Array | null; events: any[] };
            r2HitBytes = env2.bytes;
            // cache-obs-2: splice supervisor's per-tier events into
            // the facet's accumulator. Filter to known tiers/kinds
            // so a future supervisor schema change doesn't poison
            // the result.
            if (Array.isArray(env2.events)) {
              for (const e of env2.events) {
                if (!e || (e.kind !== 'hit' && e.kind !== 'miss')) continue;
                if (e.tier !== 'L2' && e.tier !== 'L3') continue;
                if (e.cacheKind !== 'tarball') continue;
                if (e.kind === 'hit') {
                  cacheStatEvents.push({
                    kind: 'hit',
                    tier: e.tier,
                    cacheKind: 'tarball',
                    bytes: typeof e.bytes === 'number' ? e.bytes : 0,
                  });
                } else {
                  cacheStatEvents.push({ kind: 'miss', tier: e.tier, cacheKind: 'tarball' });
                }
              }
            }
          } else {
            r2HitBytes = r2Result as Uint8Array | null;
          }
        } catch {
          r2HitBytes = null;
        }
      }

      // ── R2 HIT path ──────────────────────────────────────────────
      // We have bytes from R2. Verify integrity if supplied; on
      // mismatch fall through to network. On success, synthesize a
      // body stream and skip network entirely.
      let resp: Response | undefined;
      // Definitely-assigned by either the R2-hit branch OR the network
      // branch below; explicit `!` keeps TS happy without runtime cost.
      let bytesStream!: ReadableStream<Uint8Array>;
      let integrityPromise: Promise<void> = Promise.resolve();

      if (r2HitBytes && r2HitBytes.length > 0) {
        // Integrity-verify the R2 bytes ONCE before we use them. If
        // mismatch, treat as a cache miss + best-effort delete.
        let integrityOk = true;
        if (spec.integrity && spec.integrity.indexOf('-') !== -1) {
          const dash = spec.integrity.indexOf('-');
          const algo = spec.integrity.slice(0, dash).toLowerCase();
          const expectedB64 = spec.integrity.slice(dash + 1);
          const subtleAlgo =
            algo === 'sha512' ? 'SHA-512'
            : algo === 'sha384' ? 'SHA-384'
            : algo === 'sha256' ? 'SHA-256'
            : algo === 'sha1' ? 'SHA-1'
            : '';
          if (subtleAlgo) {
            const digest = await crypto.subtle.digest(subtleAlgo, r2HitBytes);
            const dBytes = new Uint8Array(digest);
            let bin = '';
            for (let i = 0; i < dBytes.length; i++) bin += String.fromCharCode(dBytes[i]);
            const gotB64 = btoa(bin);
            if (gotB64 !== expectedB64) {
              integrityOk = false;
              warnings.push(`R2 cache integrity mismatch for ${spec.name}@${spec.version}; falling through to network`);
            }
          }
        }

        if (integrityOk) {
          pipelinedTarballRaceWins++;
          tarballsCompleted++;
          cumulativeBytesDecoded += r2HitBytes.length;
          // Synthesize a Response body from the R2 bytes so the
          // existing decompress+tar pipeline below works unchanged.
          // No tee needed: integrity already verified.
          bytesStream = new Response(r2HitBytes).body!;
          resp = new Response(r2HitBytes, { status: 200 });
        } else {
          // Integrity-mismatch: drop R2 hit; fall through to network
          // after best-effort cache delete.
          r2HitBytes = null;
        }
      }

      if (!r2HitBytes) {
        pipelinedTarballRaceLosses++;
        // 1c. Fetch with retry on 5xx + network errors.
        //     Budget: 3 retries, jittered backoff 500/1500/4500 ms ±25%.
        const FACET_BACKOFF_MS = [500, 1500, 4500];
        const FACET_RETRIES = 3;
        let lastErr: any;
        for (let attempt = 0; attempt <= FACET_RETRIES; attempt++) {
          try {
            const r = await fetch(spec.tarballUrl);
            if (r.ok || r.status < 500 || r.status > 599) {
              resp = r;
              lastErr = undefined;
              break;
            }
            try { await r.body?.cancel(); } catch { /* best-effort */ }
            lastErr = new Error(`HTTP ${r.status}`);
            if (attempt === FACET_RETRIES) { resp = r; break; }
            const base = FACET_BACKOFF_MS[Math.min(attempt, FACET_BACKOFF_MS.length - 1)];
            const jitter = Math.round(base + (Math.random() * 2 - 1) * base * 0.25);
            const delayMs = Math.max(0, jitter);
            warnings.push(`retry ${attempt + 1}/${FACET_RETRIES} after ${delayMs}ms (HTTP ${r.status})`);
            await new Promise<void>((rs) => setTimeout(rs, delayMs));
          } catch (e: any) {
            lastErr = e;
            if (attempt === FACET_RETRIES) break;
            const base = FACET_BACKOFF_MS[Math.min(attempt, FACET_BACKOFF_MS.length - 1)];
            const jitter = Math.round(base + (Math.random() * 2 - 1) * base * 0.25);
            const delayMs = Math.max(0, jitter);
            const reason = e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e));
            warnings.push(`retry ${attempt + 1}/${FACET_RETRIES} after ${delayMs}ms (${reason})`);
            await new Promise<void>((rs) => setTimeout(rs, delayMs));
          }
        }
        if (!resp) {
          return {
            name: spec.name, version: spec.version,
            fileCount: 0, bytesWritten: 0, elapsed: Date.now() - t0, warnings,
            errorText: `fetch failed: ${lastErr?.message || String(lastErr)}`,
          };
        }
        if (!resp.ok) {
          return {
            name: spec.name, version: spec.version,
            fileCount: 0, bytesWritten: 0, elapsed: Date.now() - t0, warnings,
            errorText: `HTTP ${resp.status}`,
          };
        }
        const body = resp.body;
        if (!body) {
          return {
            name: spec.name, version: spec.version,
            fileCount: 0, bytesWritten: 0, elapsed: Date.now() - t0, warnings,
            errorText: 'no response body',
          };
        }

        // cache-obs-2: record the L4 (registry.npmjs.org) hit. We're
        // about to stream the body — the byte count is known either
        // via the response's Content-Length header OR we can sum it
        // as we read. Prefer the header for accuracy (it's the
        // authoritative size); fall back to 0 when missing (some
        // registry mirrors omit it for chunked responses).
        const l4ContentLength = (() => {
          const cl = resp.headers.get('content-length');
          if (!cl) return 0;
          const n = parseInt(cl, 10);
          return Number.isFinite(n) && n > 0 ? n : 0;
        })();
        cacheStatEvents.push({
          kind: 'hit',
          tier: 'L4',
          cacheKind: 'tarball',
          bytes: l4ContentLength,
        });

        // 2. Integrity verify (if supplied) AND capture bytes for R2 write-back.
        if (spec.integrity && spec.integrity.indexOf('-') !== -1) {
          const dash = spec.integrity.indexOf('-');
          const algo = spec.integrity.slice(0, dash).toLowerCase();
          const expectedB64 = spec.integrity.slice(dash + 1);
          const subtleAlgo =
            algo === 'sha512' ? 'SHA-512'
            : algo === 'sha384' ? 'SHA-384'
            : algo === 'sha256' ? 'SHA-256'
            : algo === 'sha1' ? 'SHA-1'
            : '';
          if (!subtleAlgo) {
            warnings.push(`unknown integrity algo "${algo}"; skipped verification`);
            bytesStream = body;
          } else {
            const [s1, s2] = body.tee();
            bytesStream = s1;
            integrityPromise = (async () => {
              const chunks: Uint8Array[] = [];
              const reader = s2.getReader();
              let total = 0;
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value) { chunks.push(value); total += value.length; }
              }
              cumulativeBytesDecoded += total;
              const flat = new Uint8Array(total);
              let o = 0;
              for (const c of chunks) { flat.set(c, o); o += c.length; }
              const digest = await crypto.subtle.digest(subtleAlgo, flat);
              const bytes = new Uint8Array(digest);
              let bin = '';
              for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
              const gotB64 = btoa(bin);
              if (gotB64 !== expectedB64) {
                throw new Error(
                  `integrity mismatch for ${spec.name}@${spec.version}: expected ${algo}-${expectedB64}, got ${algo}-${gotB64}`,
                );
              }
              // [W4] Capture for R2 write-back. Lifecycle: this assignment
              // happens before integrityPromise resolves, which is awaited
              // before flush() finishes. installOne then awaits the put
              // before returning, so capturedTgzBytes is always populated
              // by the time we reach the write-back code below.
              capturedTgzBytes = flat;
            })();
          }
        } else {
          bytesStream = body;
        }
      } else {
        // Already have bytesStream from R2 hit; just suppress
        // unused-variable warning on resp.
        void resp;
      }

      // 3. Decompress + tar parse (streaming).
      const decompressed = bytesStream.pipeThrough(new DecompressionStream('gzip'));
      // @ts-ignore — preamble symbol.
      const asyncIter = readableStreamToAsyncIterable(decompressed);

      // 4. Add entries to the shared producer wave. Ordinary waves pre-flush
      //    before crossing 4 MiB or 128 paths; the receiver's transaction
      //    limits and global credit pool remain the authoritative bounds.
      const pkgDir = spec.pkgDir;

      // Use the shard-level inode/chunk buffer so flushes are per shard,
      // not per package. Per-package totals stay local to the result object.
      let totalFileInodes = 0;
      let totalBytesWritten = 0;

      const dirSet = new Set<string>();
      dirSet.add(pkgDir);
      let completionMarker: { path: string; data: Uint8Array } | null = null;

      const enqueueFile = async (filePath: string, data: Uint8Array): Promise<void> => {
        const size = data.length;
        await enqueueSharedFile(ownerId, filePath, data, spec.mtime, spec.chunkSize);
        totalFileInodes += 1;
        totalBytesWritten += size;
      };

      const onSkip = (name: string, size: number, reason: string) => {
        if (reason === 'too-large') {
          warnings.push(`skipped "${name}" (${size} bytes) — exceeds per-file cap; file not installed`);
        }
      };
      // @ts-ignore — preamble symbol.
      for await (const entry of streamTarEntries(asyncIter, onSkip)) {
        const filePath = pkgDir + '/' + entry.name;
        const parts = filePath.split('/');
        for (let i = 1; i < parts.length; i++) {
          dirSet.add(parts.slice(0, i).join('/'));
        }
        const data: Uint8Array = entry.data;
        if (entry.name === 'package.json') {
          if (completionMarker) {
            throw new Error(`package tarball contains duplicate root package.json: ${spec.name}@${spec.version}`);
          }
          completionMarker = { path: filePath, data };
        } else {
          await enqueueFile(filePath, data);
        }
      }

      // Wait for integrity verification before final flush.
      await integrityPromise;

      // Append directory inodes to the SHARED buffer. Don't flush per-
      // package end — let the threshold-based flush coalesce across
      // packages. The end-of-batch flush below catches anything left.
      for (const d of dirSet) {
        await enqueueSharedDirectory(ownerId, d, spec.mtime);
      }

      // package.json is the durable completion marker used by the installer
      // diff path. Hold it outside every content wave. Batch reconciliation
      // publishes it only after all of this owner's content waves succeed.
      if (!completionMarker) {
        throw new Error(`package tarball missing root package.json: ${spec.name}@${spec.version}`);
      }
      completionMarkers.set(ownerId, {
        path: completionMarker.path,
        data: completionMarker.data,
        mtime: spec.mtime,
        chunkSize: spec.chunkSize,
      });
      totalFileInodes += 1;
      totalBytesWritten += completionMarker.data.length;

      // Write tarballs to R2 only after a successful network install so the
      // next tenant can skip the round-trip to npm. This must be awaited:
      // the facet lifecycle ends when this function returns.
      //
      // Counter only increments tarballsCompleted on the network-fetch
      // path (R2-hit path bumps it earlier). Avoids double counting.
      if (!r2HitBytes) {
        tarballsCompleted++;
        if (capturedTgzBytes && typeof env.SUPERVISOR.putCachedTarball === 'function') {
          try {
            await __nimbusUseRpcResult(
              env.SUPERVISOR.putCachedTarball(spec.name, spec.version, capturedTgzBytes),
              () => undefined,
            );
          } catch {
            // Best-effort cache write — never fail the install on R2 errors.
          }
        }
      }

      return {
        name: spec.name, version: spec.version,
        fileCount: totalFileInodes, bytesWritten: totalBytesWritten,
        elapsed: Date.now() - t0, warnings,
      };
    } catch (e: any) {
      return {
        name: spec.name, version: spec.version,
        fileCount: 0, bytesWritten: 0, elapsed: Date.now() - t0, warnings,
        errorText: e?.message || String(e),
      };
    } finally {
      inFlight = Math.max(0, inFlight - 1);
    }
  };

  // ── Dispatch all packages with internal pLimit ───────────────────────
  const perPackage = await Promise.all(
    batch.packages.map((spec, ownerId) => limit(() => installOne(spec, ownerId))),
  );

  // [P0a wave-2] End-of-batch shared flush. Drains the last buffered
  // contributions (the per-package flush is threshold-based — anything
  // below the threshold sits here until end-of-batch).
  try { await sharedFlush(); } catch { /* owner reconciliation surfaces it */ }
  // Wait for any chained flush still in-flight from the threshold path.
  if (sharedFlushInFlight) {
    try { await sharedFlushInFlight; } catch { /* errored flushes already surfaced */ }
  }

  // Only owners whose complete content history succeeded may publish the
  // package.json marker used by the next install's diff/skip decision.
  for (const [ownerId, marker] of completionMarkers) {
    const result = perPackage[ownerId];
    if (result.errorText) continue;
    const outcomes = await Promise.all([...(ownerWaves.get(ownerId) ?? [])]);
    if (outcomes.some((outcome) => !outcome.ok)) continue;
    await enqueueSharedFile(
      ownerId,
      marker.path,
      marker.data,
      marker.mtime,
      marker.chunkSize,
    );
    ownersWithCompletionMarker.add(ownerId);
  }
  try { await sharedFlush(); } catch { /* owner reconciliation surfaces it */ }

  const reconciledPerPackage = await Promise.all(perPackage.map(async (result, ownerId) => {
    const outcomes = await Promise.all([...(ownerWaves.get(ownerId) ?? [])]);
    const failedWave = outcomes.find((outcome): outcome is Extract<SharedWaveOutcome, { ok: false }> => !outcome.ok);
    const errors: string[] = [];
    if (result.errorText) errors.push(result.errorText);
    if (failedWave) errors.push(failedWave.message);
    if (!result.errorText && !ownersWithCompletionMarker.has(ownerId)) {
      errors.push(`package completion marker was not queued: ${result.name}@${result.version}`);
    }
    if (errors.length === 0) return result;
    return {
      ...result,
      fileCount: 0,
      bytesWritten: 0,
      errorText: [...new Set(errors)].join('; '),
    };
  }));

  return {
    perPackage: reconciledPerPackage,
    elapsed: Date.now() - tBatchStart,
    facetCounters: {
      tarballsCompleted,
      cumulativeBytesDecoded,
      peakInFlight: inFlightPeak,
      pipelinedTarballRaceWins,
      pipelinedTarballRaceLosses,
    },
    cacheStatEvents,
  };
};
