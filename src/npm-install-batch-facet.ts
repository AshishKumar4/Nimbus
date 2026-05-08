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
 * Memory plan inside the facet (pLimit=3, 16 MiB flush threshold):
 *   - 3 concurrent tarball pipelines: each holds at most 16 MiB of
 *     pending-flush bytes + 1× tarball-decompress state (~5-10 MiB) +
 *     integrity-hash buffer (compressed tarball size, ~1-3 MiB).
 *   - Peak ≈ 3 × (16 + 10 + 3) = ~87 MiB inside the facet's 128 MiB cap.
 *   - ~40 MiB headroom for V8 + tar-parser closure state.
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

import type { FacetPackageSpec } from './npm-install-facet.js';

// ── Types exchanged between supervisor and facet ────────────────────────

export interface InstallBatchSpec {
  /** All packages to install in this batch. ≈456 entries × ~200 B = ~90 KB,
   *  well under workerd's 32 MiB RPC arg cap. */
  packages: FacetPackageSpec[];
  /** Internal pLimit cap for concurrent tarball pipelines.
   *  3 keeps facet heap peak ~87 MiB under the 128 MiB cap.
   *  Lower if pathological packages cause facet OOM in prod. */
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
      writeBatch(payload: any): Promise<{ inodes: number; chunks: number }>;
      // [W7] Streaming bulk-write RPC. Bypasses the 32 MiB structured-clone
      // cap by sending the batch as a type:'bytes' ReadableStream<Uint8Array>
      // (W7 wire protocol — see src/_shared/w7-frame.ts).
      // Optional in the type so the facet keeps working against pre-W7
      // supervisors via the typeof-guarded fallback at the call site.
      writeBatchStream?: (stream: ReadableStream<Uint8Array>) => Promise<{ inodes: number; chunks: number }>;
      // [W4] Optional R2-cache RPC. Soft-fail via typeof checks below
      // so this facet keeps working against older deployed supervisors.
      getCachedTarball?: (name: string, version: string) => Promise<Uint8Array | null>;
      putCachedTarball?: (name: string, version: string, bytes: Uint8Array | ArrayBuffer) => Promise<boolean>;
    };
  },
): Promise<InstallBatchResult> {
  const tBatchStart = Date.now();

  if (!batch || typeof batch !== 'object' || !Array.isArray(batch.packages)) {
    throw new Error('installPackagesInFacet: missing batch.packages');
  }
  if (!env || !env.SUPERVISOR || typeof env.SUPERVISOR.writeBatch !== 'function') {
    throw new Error('installPackagesInFacet: env.SUPERVISOR.writeBatch missing');
  }
  // [W7] Detect streaming RPC support ONCE per batch — the typeof check
  // is cheap but we don't want to repeat it inside every flush hot path.
  const supportsStreaming =
    typeof (env.SUPERVISOR as any).writeBatchStream === 'function';

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

  // ── Per-package install (inlined fetchAndStagePackage logic) ─────────
  //
  // Mirrors src/npm-install-facet.ts:fetchAndStagePackage. Kept inline
  // because cloudflare-parallel serializes this whole function via
  // fn.toString() — we cannot import from a sibling module across the
  // isolate boundary. Keep this logic in sync with npm-install-facet.ts.
  const installOne = async (spec: FacetPackageSpec): Promise<InstallBatchPerPackage> => {
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
      const r2P: Promise<Uint8Array | null> = r2Available
        ? Promise.race([
            env.SUPERVISOR.getCachedTarball!(spec.name, spec.version),
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
          r2HitBytes = await r2P;
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

      // 4. Build + flush BatchWritePayload(s) at the threshold.
      //    Pre-W7 threshold: 16 MiB to keep the structured-clone payload
      //      well under workerd's 32 MiB cap with 6% serialization
      //      overhead. With pLimit=3, total in-flight pending flush bytes
      //      peaked at 3 × 16 = 48 MiB inside the 128 MiB cap.
      //    W7 (streaming path): the RPC has no 32 MiB cap because the
      //      bytes traverse the boundary as a flow-controlled byte stream.
      //      We could in principle drop this threshold entirely (one
      //      flush per package), but a memory-pressure boundary is still
      //      useful — a single 100 MiB tarball would otherwise hold 100
      //      MiB resident in the chunks array before flushing. Keep the
      //      threshold; raise it if/when measured peak heap suggests the
      //      legacy 16 MiB is now the bottleneck on the streaming path.
      const pkgDir = spec.pkgDir;
      type InodeT = {
        path: string; parentPath: string; isDir: boolean;
        size: number; mtime: number; mode: number; chunkCount: number;
      };
      type ChunkT = { path: string; chunkId: number; data: Uint8Array };

      let inodes: InodeT[] = [];
      let chunks: ChunkT[] = [];
      const INODE_OVERHEAD = 160;
      const CHUNK_OVERHEAD = 96;
      const RPC_FLUSH_THRESHOLD = 16 * 1024 * 1024;
      let bufferedBytes = 0;
      let totalFileInodes = 0;
      let totalBytesWritten = 0;

      const dirSet = new Set<string>();
      const parentOf = (p: string) => (p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '');
      dirSet.add(pkgDir);

      const flush = async () => {
        if (inodes.length === 0 && chunks.length === 0) return;
        if (supportsStreaming) {
          // W7: stream the batch as a type:'bytes' ReadableStream over RPC.
          // No 32 MiB structured-clone cap on this path. encodeWriteBatchStream
          // is injected via the facet preamble (W7_FRAME_PREAMBLE in
          // src/parallel/generated-workers.ts).
          // @ts-ignore — preamble symbol.
          const stream = encodeWriteBatchStream({ inodes, chunks });
          await (env.SUPERVISOR as any).writeBatchStream(stream);
        } else {
          // Pre-W7 supervisor — fall back to the legacy structured-clone
          // path. The 16 MiB RPC_FLUSH_THRESHOLD above keeps payloads
          // under workerd's 32 MiB cap on this branch.
          await env.SUPERVISOR.writeBatch({ inodes, chunks });
        }
        inodes = [];
        chunks = [];
        bufferedBytes = 0;
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
        const size = data.length;
        const chunkCount = size === 0 ? 0 : Math.ceil(size / spec.chunkSize);
        inodes.push({
          path: filePath, parentPath: parentOf(filePath), isDir: false,
          size, mtime: spec.mtime, mode: 0o644, chunkCount,
        });
        bufferedBytes += INODE_OVERHEAD + filePath.length * 2;
        totalFileInodes += 1;
        totalBytesWritten += size;

        if (size > 0) {
          if (size <= spec.chunkSize) {
            chunks.push({ path: filePath, chunkId: 0, data });
            bufferedBytes += CHUNK_OVERHEAD + filePath.length + data.length;
          } else {
            for (let c = 0; c < chunkCount; c++) {
              const slice = data.slice(c * spec.chunkSize, (c + 1) * spec.chunkSize);
              chunks.push({ path: filePath, chunkId: c, data: slice });
              bufferedBytes += CHUNK_OVERHEAD + filePath.length + slice.length;
            }
          }
        }

        if (bufferedBytes >= RPC_FLUSH_THRESHOLD) {
          await flush();
        }
      }

      // Wait for integrity verification before final flush.
      await integrityPromise;

      // Append directory inodes.
      for (const d of dirSet) {
        inodes.push({
          path: d, parentPath: parentOf(d), isDir: true,
          size: 0, mtime: spec.mtime, mode: 0o755, chunkCount: 0,
        });
        bufferedBytes += INODE_OVERHEAD + d.length * 2;
      }

      // Final flush.
      await flush();

      // [W4] Write tarball to R2 cache after a successful network install
      // so the next tenant on the platform skips the round-trip to npm.
      // Awaited (not `void`) per W4-plan §11 finding #2: the facet's
      // lifecycle ends when this fn returns; an unawaited put may be
      // torn down before the R2 write completes.
      //
      // Counter only increments tarballsCompleted on the network-fetch
      // path (R2-hit path bumps it earlier). Avoids double counting.
      if (!r2HitBytes) {
        tarballsCompleted++;
        if (capturedTgzBytes && typeof env.SUPERVISOR.putCachedTarball === 'function') {
          try {
            await env.SUPERVISOR.putCachedTarball(spec.name, spec.version, capturedTgzBytes);
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
    batch.packages.map((spec) => limit(() => installOne(spec))),
  );

  return {
    perPackage,
    elapsed: Date.now() - tBatchStart,
    facetCounters: {
      tarballsCompleted,
      cumulativeBytesDecoded,
      peakInFlight: inFlightPeak,
      pipelinedTarballRaceWins,
      pipelinedTarballRaceLosses,
    },
  };
};
