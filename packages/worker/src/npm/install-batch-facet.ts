/**
 * npm-install-batch-facet.ts — single-facet batch installer.
 *
 * What this is
 * ────────────
 * One install shard: a facet that receives a FacetPackageSpec[] and loops
 * internally with pLimit(3), so a shard costs one Dynamic Worker however
 * many packages it holds. The installer's Fanout runs the shards on the
 * session's Dynamic Worker headroom, or across sibling DOs when there are
 * more shards than that.
 *
 * The shard writes through one wave writer (@nimbus-sh/platform
 * wave-writer.ts), which cuts waves at W7's path and byte bounds; the
 * supervisor's weighted credit pool and transaction builder remain the
 * authoritative hard bounds.
 *
 * The per-package logic (fetch + integrity-verify + gunzip + tar-parse +
 * writeBatch flush) stays in this function because cloudflare-parallel
 * serializes it via fn.toString() and cannot import sibling modules across
 * the isolate boundary.
 *
 * Stability invariants (cloudflare-parallel):
 *   - No `this` references.
 *   - No closure capture other than args + preamble names.
 *   - Preamble symbols (streamPackageEntries, streamTarEntries,
 *     readableStreamToAsyncIterable, MAX_FILE_BYTES) referenced via
 *     @ts-ignore; __nimbusWaveWriter declared below.
 */

import type { FacetPackageSpec } from './install-facet.js';
import type { WriteBatchStreamResult } from '@nimbus-sh/core/vfs/sqlite-vfs.js';

declare const __nimbusWaveWriter: typeof import('@nimbus-sh/platform/wave-writer.js');

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
  /** The spec's identity: one version may land at two directories. Absent from pre-placement shards. */
  pkgDir?: string;
  fileCount: number;
  bytesWritten: number;
  elapsed: number;
  warnings: string[];
  /** When set, the package failed; caller surfaces this in install log. */
  errorText?: string;
  /**
   * Which tier served this tarball, and how long acquiring it took. The
   * supervisor reports both verbatim in its `npm http` lines, so they must
   * stay measurements — absent when the tarball was never acquired.
   */
  tarballSource?: 'cache' | 'registry';
  tarballElapsedMs?: number;
}

export interface InstallBatchResult {
  /** One entry per input spec, in input order. */
  perPackage: InstallBatchPerPackage[];
  /** Wall-clock ms inside the facet (whole batch). */
  elapsed: number;
  /** Counter snapshot at end of batch. Mirrors @nimbus-sh/platform/diag-counters.js shape
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
    /** Longest wait on the R2 leg in this shard, and how many registry
     *  requests the shard issued alongside those waits. Separates cache-tier
     *  latency from registry latency, and says how much of the speculative
     *  network work the cache tier made redundant. */
    r2WaitMsMax: number;
    speculativeFetches: number;
    /** Write waves this shard published, and the ms its writes waited for
     *  the wave in flight to publish: time the shard's tar pipelines were
     *  stopped on writing — the term that separates write cost from
     *  download cost. */
    sharedWaves: number;
    sharedWaveMs: number;
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
// Runs inside a IsolatePool isolate. Serialised via fn.toString();
// the helpers it references at top-level scope (streamPackageEntries,
// streamTarEntries, readableStreamToAsyncIterable, MAX_FILE_BYTES) are NOT
// in the facet's lexical scope — the pool injects them via the preamble.
// No static imports of those names; references are bare identifiers.

export const installPackagesInFacet = async function installPackagesInFacet(
  batch: InstallBatchSpec,
  env: {
    SUPERVISOR: {
      // [W7] Streaming bulk-write RPC. Bypasses the 32 MiB structured-clone
      // cap by sending the batch as a type:'bytes' ReadableStream<Uint8Array>
      // (W7 wire protocol — see src/_shared/w7-frame.ts).
      writeBatchStream: (stream: ReadableStream<Uint8Array>) => Promise<WriteBatchStreamResult>;
      // [W4] Optional R2-cache RPC, addressed by the tarball's npm
      // integrity digest. The supervisor re-hashes whatever the shared
      // bucket returned before handing it back, so `bytes` need no
      // further verification here.
      getCachedTarball?: (
        integrity: string,
      ) => Promise<{
        bytes: Uint8Array | null;
        events: Array<
          | { kind: 'hit'; tier: string; cacheKind: string; bytes: number }
          | { kind: 'miss'; tier: string; cacheKind: string }
        >;
      }>;
      putCachedTarball?: (integrity: string, bytes: Uint8Array | ArrayBuffer) => Promise<boolean>;
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

  // [W4] How long the R2 leg gets on its own before the network leg is issued
  // as a hedge. A hit or an explicit miss answers inside this window and costs
  // no registry request; past it the leg is stalled, and the remaining
  // R2_RACE_TIMEOUT_MS - SPECULATIVE_FETCH_DELAY_MS would otherwise be dead
  // air before the download could start.
  const SPECULATIVE_FETCH_DELAY_MS = 75;

  // How long a package waits on its best-effort R2 cache write. A tarball is
  // at most MAX_R2_TARBALL_BYTES (30 MiB); a write still unanswered past this
  // is abandoned, and the next install that misses the cache writes it.
  const CACHE_WRITE_DEADLINE_MS = 30_000;

  const concurrency = Math.max(1, Math.min(batch.concurrency ?? 3, 8));

  // ── pLimit (inlined; preamble doesn't carry a limiter helper) ────────
  // Waiting package tasks enter in arrival order.
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
  // Speculation accounting: how long the slowest package waited on the R2 leg,
  // and how many registry requests were issued alongside those waits.
  let r2WaitMsMax = 0;
  let speculativeFetches = 0;
  // cache-obs-2: per-tier event accumulator. Filled in the L2/L3
  // (supervisor RPC return.events) and L4 (post-network-fetch)
  // branches. Returned in result.cacheStatEvents at the end of the
  // batch. installer.ts folds these into the DO-side cache-stats
  // singleton via recordCacheStatEvents — same pattern as
  // recordR2RaceCounters at installer.ts:1168.
  const cacheStatEvents: InstallBatchResult['cacheStatEvents'] = [];

  // ── The shard's writes: one wave writer ─────────────────────────────
  //
  // Every package in the shard writes through one writer (the platform's
  // wave writer, a preamble symbol), so a shard sends a few large W7 waves
  // rather than one per package: an install that once sent 620+ write RPCs
  // aged the coordinator's input-gate queue into overload. The writer
  // derives each wave's directories up to the install root (never above it:
  // those pre-exist, and re-staging them trips the write check on
  // user-unwritable system directories), and re-sends a wave whose
  // transport was lost. A wave the session refused fails the packages it
  // carried: their later writes reject, and their records still buffered
  // are not sent. Waves publish in order, so a package's package.json,
  // written after its files, is durable only if they are: it is the
  // package's completion marker for the next install's diff.
  const installRoot = batch.packages[0]?.installRoot ?? '';
  for (const spec of batch.packages) {
    if (spec.installRoot !== installRoot || spec.mtime !== batch.packages[0]!.mtime) {
      throw new Error('installPackagesInFacet: a batch has one install root and one mtime');
    }
  }
  // Which wave carried each package's records last, and how many it has
  // written that no wave has carried yet. Records carry their package
  // (meta): a wave the session refused fails the packages it carried, and
  // the writer goes on for the rest.
  const lastWaveOf = new Map<number, number>();
  const uncut = new Map<number, number>();
  let lastPublishedWave = 0;
  const writer = __nimbusWaveWriter.createWaveWriter<number>({
    supervisor: env.SUPERVISOR,
    root: installRoot,
    mtimeMs: batch.packages[0]?.mtime,
    failPerOwner: true,
    onCut(cut) {
      for (const file of cut.files) {
        if (file.meta === undefined) continue;
        lastWaveOf.set(file.meta, cut.wave);
        uncut.set(file.meta, (uncut.get(file.meta) ?? 1) - 1);
      }
    },
    onWave(report) {
      lastPublishedWave = report.wave;
    },
  });
  const writeOwnedFile = async (ownerId: number, path: string, data: Uint8Array): Promise<void> => {
    uncut.set(ownerId, (uncut.get(ownerId) ?? 0) + 1);
    await writer.file(path, 0o644, data, ownerId);
  };

  // A tarball placed twice in this shard is acquired once: the first owner
  // publishes its bytes here, later owners of the URL wait for them. `null`
  // means it had nothing to share and the waiter acquires on its own.
  // Owners register on entry, so no waiter blocks an unstarted owner.
  const tarballBytesByUrl = new Map<string, Promise<Uint8Array | null>>();

  // ── Per-package install (inlined fetchAndStagePackage logic) ─────────
  //
  // Kept inline because cloudflare-parallel serializes this whole function
  // via fn.toString(); it cannot import a sibling module across the isolate
  // boundary. Retry behavior matches resolve-one-facet and _shared/retry.
  const installOne = async (
    spec: FacetPackageSpec,
    ownerId: number,
  ): Promise<InstallBatchPerPackage> => {
    const t0 = Date.now();
    const warnings: string[] = [];

    inFlight++;
    if (inFlight > inFlightPeak) inFlightPeak = inFlight;

    let publishTarballBytes: (bytes: Uint8Array | null) => void = () => {};
    let sharedBytes: Uint8Array | null = null;
    const owner = tarballBytesByUrl.get(spec.tarballUrl);
    if (owner) {
      sharedBytes = await owner;
    } else {
      tarballBytesByUrl.set(spec.tarballUrl, new Promise((rs) => { publishTarballBytes = rs; }));
    }
    // [W4] Compressed bytes for R2 write-back, captured by the integrity
    // tee below (null without integrity); published to duplicates on exit.
    let capturedTgzBytes: Uint8Array | null = null;
    let r2HitBytes: Uint8Array | null = sharedBytes;

    // [W4] 1a. R2 cache lookup, hedged by the network fetch.
    //
    // The R2 GET is bounded by R2_RACE_TIMEOUT_MS. That bound guards against a
    // slow or hung leg rather than describing the normal cost: a hit and an
    // explicit miss both answer well inside it, and only a stalled leg spends
    // the whole budget. So the network leg is a hedge rather than a co-start —
    // issued only once R2 has failed to answer within
    // SPECULATIVE_FETCH_DELAY_MS, which is exactly the window in which the
    // bounded wait would otherwise be dead air.
    //
    // Issuing it up front instead made every cache hit pay for a registry
    // request it then threw away. That is the common case on a warm install,
    // and it cost more than the miss path the speculation was meant to speed
    // up.
    //
    // Soft-fail: if env.SUPERVISOR.getCachedTarball isn't defined (older
    // supervisor deployment) the R2 leg becomes a noop and there is nothing to
    // overlap with, so no hedge is armed — the retry loop's own first fetch is
    // already the first thing that happens.
    const r2Available = sharedBytes === null && typeof env.SUPERVISOR.getCachedTarball === 'function';
    const r2WaitStart = Date.now();
    const r2P: Promise<{ bytes: Uint8Array | null; events: any[] } | null> = r2Available
      ? Promise.race([
          __nimbusUseRpcResult(
            env.SUPERVISOR.getCachedTarball!(spec.integrity),
            (result) => result,
          ),
          new Promise<null>((rs) => setTimeout(() => rs(null), R2_RACE_TIMEOUT_MS)),
        ]).catch(() => null)
      : Promise.resolve(null);
    let pendingNetwork: Promise<Response> | null = null;
    let hedgeTimer: ReturnType<typeof setTimeout> | null = null;
    const hedgeAbort = new AbortController();
    const clearHedgeTimer = (): void => {
      if (hedgeTimer === null) return;
      clearTimeout(hedgeTimer);
      hedgeTimer = null;
    };
    if (r2Available) {
      hedgeTimer = setTimeout(() => {
        hedgeTimer = null;
        speculativeFetches++;
        pendingNetwork = fetch(spec.tarballUrl, { signal: hedgeAbort.signal });
        // Rejections are re-awaited and rethrown in order by takeNetworkResponse;
        // this sink only stops a failure that lands while the R2 leg is still
        // outstanding from surfacing as an unhandled rejection.
        pendingNetwork.catch(() => { /* consumed by takeNetworkResponse or discarded */ });
      }, SPECULATIVE_FETCH_DELAY_MS);
    }
    const takeNetworkResponse = async (): Promise<Response> => {
      clearHedgeTimer();
      const pending = pendingNetwork;
      pendingNetwork = null;
      return pending ? await pending : await fetch(spec.tarballUrl);
    };
    const discardPendingNetwork = (): void => {
      clearHedgeTimer();
      if (!pendingNetwork) return;
      pendingNetwork = null;
      // Abort rather than await-then-cancel the body: a `.then()` that cancels
      // only runs once the registry's response headers arrive, so it holds the
      // connection open for exactly the round-trip the cache hit avoided.
      hedgeAbort.abort();
    };

    try {

      // Acquisition span, measured from the first cache probe to the moment
      // the tarball body is in hand.
      let tarballElapsedMs = 0;

      // 1b. Try R2 first (bounded wait).
      if (r2Available) {
        try {
          const r2Result = await r2P;
          const r2WaitMs = Date.now() - r2WaitStart;
          if (r2WaitMs > r2WaitMsMax) r2WaitMsMax = r2WaitMs;
          if (r2Result) {
            r2HitBytes = r2Result.bytes;
            // cache-obs-2: splice supervisor's per-tier events into
            // the facet's accumulator. Filter to known tiers/kinds
            // so a future supervisor schema change doesn't poison
            // the result.
            if (Array.isArray(r2Result.events)) {
              for (const e of r2Result.events) {
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
          }
        } catch {
          r2HitBytes = null;
        }
      }

      // ── R2 HIT path ──────────────────────────────────────────────
      // We have bytes from the shared cache. They were re-hashed
      // against spec.integrity at the storage boundary, so synthesize
      // a body stream and skip the network entirely.
      let resp: Response | undefined;
      // Definitely-assigned by either the R2-hit branch OR the network
      // branch below; explicit `!` keeps TS happy without runtime cost.
      let bytesStream!: ReadableStream<Uint8Array>;
      let integrityPromise: Promise<void> = Promise.resolve();

      if (r2HitBytes && r2HitBytes.length > 0) {
        // Cache HIT. The cross-tenant store is content-addressed and
        // re-hashes on every read, so bytes that come back are already
        // proven to be spec.integrity's tarball — there is exactly one
        // verification point and it is not here. Bytes shared by another
        // placement were verified by their owner; not an R2 outcome.
        discardPendingNetwork();
        tarballElapsedMs = Date.now() - r2WaitStart;
        if (!sharedBytes) pipelinedTarballRaceWins++;
        tarballsCompleted++;
        cumulativeBytesDecoded += r2HitBytes.length;
        // Synthesize a Response body from the R2 bytes so the existing
        // decompress + tar pipeline below works unchanged.
        bytesStream = new Response(r2HitBytes).body!;
        resp = new Response(r2HitBytes, { status: 200 });
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
            const r = await takeNetworkResponse();
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
            name: spec.name, version: spec.version, pkgDir: spec.pkgDir,
            fileCount: 0, bytesWritten: 0, elapsed: Date.now() - t0, warnings,
            errorText: `fetch failed: ${lastErr?.message || String(lastErr)}`,
          };
        }
        if (!resp.ok) {
          return {
            name: spec.name, version: spec.version, pkgDir: spec.pkgDir,
            fileCount: 0, bytesWritten: 0, elapsed: Date.now() - t0, warnings,
            errorText: `HTTP ${resp.status}`,
          };
        }
        const body = resp.body;
        if (!body) {
          return {
            name: spec.name, version: spec.version, pkgDir: spec.pkgDir,
            fileCount: 0, bytesWritten: 0, elapsed: Date.now() - t0, warnings,
            errorText: 'no response body',
          };
        }
        tarballElapsedMs = Date.now() - r2WaitStart;

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

      // 4. Write the entries through the shard's writer. Per-package totals
      //    stay local to the result object.
      const pkgDir = spec.pkgDir;
      let totalFileInodes = 0;
      let totalBytesWritten = 0;

      let completionMarker: { path: string; data: Uint8Array } | null = null;

      const enqueueFile = async (filePath: string, data: Uint8Array): Promise<void> => {
        await writeOwnedFile(ownerId, filePath, data);
        totalFileInodes += 1;
        totalBytesWritten += data.length;
      };

      const onSkip = (name: string, size: number, reason: string) => {
        if (reason === 'too-large') {
          warnings.push(`skipped "${name}" (${size} bytes) — exceeds per-file cap; file not installed`);
        }
      };

      // @ts-ignore — preamble symbol.
      for await (const entry of streamPackageEntries(asyncIter, onSkip)) {
        // entry.name is canonicalized (no "."/".." segments) and stripped of
        // the archive's single top-level directory by streamPackageEntries,
        // so joining under the canonical pkgDir yields a canonical path the
        // w7-frame writer accepts.
        const filePath = pkgDir + '/' + entry.name;
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

      // package.json is the durable completion marker used by the installer
      // diff path, written once the tarball verified and after every other
      // file of the package: waves publish in order, so it is durable only
      // if they are.
      if (!completionMarker) {
        throw new Error(`package tarball missing root package.json: ${spec.name}@${spec.version}`);
      }
      await writeOwnedFile(ownerId, completionMarker.path, completionMarker.data);
      totalFileInodes += 1;
      totalBytesWritten += completionMarker.data.length;

      // Write tarballs to R2 only after a successful network install so the
      // next tenant can skip the round-trip to npm. This is awaited, because
      // the facet lifecycle ends when this function returns, but only for
      // CACHE_WRITE_DEADLINE_MS: the write is best-effort, and an RPC the
      // transport drops without a word (as writeBatchStream's were, above)
      // would otherwise hold this package, and the install, until the
      // batch deadline.
      //
      // Counter only increments tarballsCompleted on the network-fetch
      // path (R2-hit path bumps it earlier). Avoids double counting.
      if (!r2HitBytes) {
        tarballsCompleted++;
        if (capturedTgzBytes && typeof env.SUPERVISOR.putCachedTarball === 'function') {
          // Best-effort cache write — never fail the install on R2 errors.
          const write = __nimbusUseRpcResult(
            env.SUPERVISOR.putCachedTarball(spec.integrity, capturedTgzBytes),
            () => undefined,
          ).catch(() => {});
          let deadline: ReturnType<typeof setTimeout> | null = null;
          await Promise.race([
            write,
            new Promise<void>((resolve) => { deadline = setTimeout(resolve, CACHE_WRITE_DEADLINE_MS); }),
          ]);
          clearTimeout(deadline);
        }
      }

      return {
        name: spec.name, version: spec.version, pkgDir: spec.pkgDir,
        fileCount: totalFileInodes, bytesWritten: totalBytesWritten,
        elapsed: Date.now() - t0, warnings,
        tarballSource: r2HitBytes ? 'cache' : 'registry',
        tarballElapsedMs: tarballElapsedMs,
      };
    } catch (e: any) {
      return {
        name: spec.name, version: spec.version, pkgDir: spec.pkgDir,
        fileCount: 0, bytesWritten: 0, elapsed: Date.now() - t0, warnings,
        errorText: e?.message || String(e),
      };
    } finally {
      // No-op once the retry loop has taken it; closes every early return.
      discardPendingNetwork();
      publishTarballBytes(capturedTgzBytes ?? r2HitBytes);
      inFlight = Math.max(0, inFlight - 1);
    }
  };

  // ── Dispatch all packages with internal pLimit ───────────────────────
  const perPackage = await Promise.all(
    batch.packages.map((spec, ownerId) => limit(() => installOne(spec, ownerId))),
  );

  // Everything written is published, or the writer stopped at a refused
  // wave. A package succeeded only if every record it wrote was carried by
  // a wave that published.
  let flushError: string | null = null;
  try { await writer.flush(); } catch (error) { flushError = error instanceof Error ? error.message : String(error); }
  const reconciledPerPackage = perPackage.map((result, ownerId) => {
    if (result.errorText) return result;
    const failure = writer.failureOf(ownerId)?.message ?? flushError;
    const published = failure === null
      && (uncut.get(ownerId) ?? 0) === 0
      && (lastWaveOf.get(ownerId) ?? 0) <= lastPublishedWave;
    if (published) return result;
    return {
      ...result,
      fileCount: 0,
      bytesWritten: 0,
      errorText: failure ?? `package files were not published: ${result.name}@${result.version}`,
    };
  });
  const waveStats = writer.stats();

  return {
    perPackage: reconciledPerPackage,
    elapsed: Date.now() - tBatchStart,
    facetCounters: {
      tarballsCompleted,
      cumulativeBytesDecoded,
      peakInFlight: inFlightPeak,
      pipelinedTarballRaceWins,
      pipelinedTarballRaceLosses,
      r2WaitMsMax,
      speculativeFetches,
      sharedWaves: waveStats.waves,
      sharedWaveMs: waveStats.producerWaitMs,
    },
    cacheStatEvents,
  };
};
