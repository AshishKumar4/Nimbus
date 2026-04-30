/**
 * npm-install-facet.ts — NimbusFacetPool entry for parallel tarball install.
 *
 * Exports:
 *   - `fetchAndStagePackage`: the function dispatched to the facet pool
 *     ONCE per package. Must be pure (serializable via fn.toString — no
 *     `this`, no closure variables other than names declared in the
 *     injected preamble or the passed-in arg/env).
 *   - `FacetPackageSpec` / `FacetPackageResult`: the shapes exchanged
 *     between the supervisor and the facet.
 *
 * The facet function references these helpers by name; they come from the
 * preamble src/parallel/generated-workers.ts injects into the worker
 * module at load time:
 *   - `streamTarEntries(asyncIterable)` → yields `{ name, data }`
 *   - `readableStreamToAsyncIterable(readableStream)` → AsyncIterable
 *   - `MAX_FILE_BYTES` const (unused here; present in preamble)
 *
 * It also uses only platform APIs available in workerd: fetch,
 * DecompressionStream, crypto.subtle.digest, Uint8Array, Response,
 * plus `env.SUPERVISOR` (a service binding stub forwarded by the pool).
 *
 * **Stability invariants** (enforced by cloudflare-parallel at serialize time):
 *   - No `this` references (arrow / anonymous async).
 *   - No free variables other than preamble names + explicit args.
 *   - All types are erased at runtime — this TS file is here only so the
 *     supervisor-side code that imports `fetchAndStagePackage` gets nice
 *     typings; the actual string shipped to the facet is `fn.toString()`.
 *
 * See WORKERD-CRASH.md + plan in the H2 commit message for why this runs
 * in a facet rather than in the supervisor DO.
 */

/** Shape of an item submitted to the facet pool. Each field is JSON-serialised. */
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

/** Per-package result returned by the facet. */
export interface FacetPackageResult {
  name: string;
  version: string;
  /** Number of file inodes written (directories not counted). */
  fileCount: number;
  /** Sum of file bytes written. */
  bytesWritten: number;
  /** Wall-clock ms from fetch-start to writeBatch-return. */
  elapsed: number;
  /**
   * Empty on success. Populated on recoverable per-file problems that did
   * NOT stop the install (e.g. a file exceeding MAX_FILE_BYTES that the
   * tar parser skipped). The supervisor logs these but doesn't fail the
   * run.
   */
  warnings: string[];
}

/**
 * The function that runs inside a facet isolate. Passed as the first arg
 * to NimbusFacetPool.map; serialised via fn.toString() by cloudflare-parallel.
 *
 * The preamble (src/parallel/generated-workers.ts -> TAR_STREAM_PREAMBLE)
 * must be injected via the pool's `preamble` option so the body can
 * reference `streamTarEntries` / `readableStreamToAsyncIterable`.
 *
 * Arguments:
 *   spec — the per-package instructions (see FacetPackageSpec).
 *   env  — the bindings auto-injected by NimbusFacetPool. Must contain
 *          env.SUPERVISOR with a `writeBatch(payload)` RPC method. Does
 *          NOT use any other binding.
 *
 * Behaviour summary:
 *   1. Fetch the tarball (inheriting parent network; no proxy).
 *   2. Verify sha512 integrity if provided — fail loudly on mismatch.
 *   3. Streaming gunzip + tar parse, yielding one file at a time.
 *   4. Build a VFS writeBatch payload (inodes + chunks + parent dirs).
 *   5. Call env.SUPERVISOR.writeBatch(payload) exactly once.
 *   6. Return a summary to the supervisor.
 */
export const fetchAndStagePackage = async function fetchAndStagePackage(
  spec: FacetPackageSpec,
  env: { SUPERVISOR: { writeBatch(payload: any): Promise<{ inodes: number; chunks: number }> } },
): Promise<FacetPackageResult> {
  const t0 = Date.now();
  const warnings: string[] = [];

  if (!spec || typeof spec !== 'object') {
    throw new Error('fetchAndStagePackage: missing spec');
  }
  if (!env || !env.SUPERVISOR || typeof env.SUPERVISOR.writeBatch !== 'function') {
    throw new Error('fetchAndStagePackage: env.SUPERVISOR.writeBatch missing');
  }

  // 1. Fetch with retry on 5xx + network errors.
  //
  // The tarball GET hits registry.npmjs.org via Cloudflare's edge. Either
  // hop can produce a transient 5xx; with no retry, a single 503 across
  // 456 packages kills the whole install (observed in prod: lowlight@3.3.0
  // returned 503 once, a direct curl seconds later was 200 HIT). This
  // mirrors the retry behaviour in src/retry.ts — kept INLINE here because
  // `fetchAndStagePackage` is serialized via fn.toString() for dispatch
  // to a separate facet isolate and cannot import from a sibling module.
  // Keep the two retry loops in sync when editing either.
  //
  // Budget: 3 retries, jittered exponential backoff at 500/1500/4500 ms
  // (±25%). Worst-case extra latency per package ≈ 6.5 s if every retry
  // slot is burned. 4xx is NOT retried — 404 means the package/version
  // doesn't exist.
  const FACET_BACKOFF_MS = [500, 1500, 4500];
  const FACET_RETRIES = 3;
  let resp: Response | undefined;
  let lastErr: any;
  for (let attempt = 0; attempt <= FACET_RETRIES; attempt++) {
    try {
      const r = await fetch(spec.tarballUrl);
      if (r.ok || r.status < 500 || r.status > 599) {
        resp = r;
        lastErr = undefined;
        break;
      }
      // 5xx: drain body to release the connection before retrying.
      try { await r.body?.cancel(); } catch { /* best-effort */ }
      lastErr = new Error(`HTTP ${r.status}`);
      if (attempt === FACET_RETRIES) {
        resp = r; // keep final 5xx so we throw with status below
        break;
      }
      const base = FACET_BACKOFF_MS[Math.min(attempt, FACET_BACKOFF_MS.length - 1)];
      const jitter = Math.round(base + (Math.random() * 2 - 1) * base * 0.25);
      const delayMs = Math.max(0, jitter);
      warnings.push(
        `retry ${attempt + 1}/${FACET_RETRIES} after ${delayMs}ms (HTTP ${r.status})`,
      );
      await new Promise<void>((rs) => setTimeout(rs, delayMs));
    } catch (e: any) {
      lastErr = e;
      if (attempt === FACET_RETRIES) break;
      const base = FACET_BACKOFF_MS[Math.min(attempt, FACET_BACKOFF_MS.length - 1)];
      const jitter = Math.round(base + (Math.random() * 2 - 1) * base * 0.25);
      const delayMs = Math.max(0, jitter);
      const reason = e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e));
      warnings.push(
        `retry ${attempt + 1}/${FACET_RETRIES} after ${delayMs}ms (${reason})`,
      );
      await new Promise<void>((rs) => setTimeout(rs, delayMs));
    }
  }
  if (!resp) {
    throw new Error(
      `fetch failed for ${spec.name}@${spec.version}: ${lastErr?.message || String(lastErr)}`,
    );
  }
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} fetching ${spec.name}@${spec.version}`);
  }
  const body = resp.body;
  if (!body) {
    throw new Error(`no response body for ${spec.name}@${spec.version}`);
  }

  // 2. Integrity verification (if supplied). Format: "<algo>-<base64>".
  //    npm publishes sha512 strings for modern packages; older ones have
  //    just a tarball shasum in the packument we don't get here. Skip
  //    silently when absent.
  //    We tee the body stream so we can both hash and parse. The hash
  //    stream drains the whole response; parsing runs in parallel.
  //    (TextEncoder / btoa are available in workerd.)
  let bytesStream: ReadableStream<Uint8Array>;
  let integrityPromise: Promise<void> = Promise.resolve();
  if (spec.integrity && spec.integrity.indexOf('-') !== -1) {
    const dash = spec.integrity.indexOf('-');
    const algo = spec.integrity.slice(0, dash).toLowerCase();
    const expectedB64 = spec.integrity.slice(dash + 1);
    const subtleAlgo =
      algo === 'sha512' ? 'SHA-512'
      : algo === 'sha384' ? 'SHA-384'
      : algo === 'sha256' ? 'SHA-256'
      : algo === 'sha1'   ? 'SHA-1'
      : '';
    if (!subtleAlgo) {
      warnings.push(`unknown integrity algo "${algo}"; skipped verification`);
      bytesStream = body;
    } else {
      const [s1, s2] = body.tee();
      bytesStream = s1;
      integrityPromise = (async () => {
        // Drain s2 into a single buffer (compressed tarballs are bounded;
        // >5 MB packages are rare and still fit here). Hashing in-place
        // without buffering would need a streaming digest; workerd's
        // subtle.digest is one-shot. Buffer it.
        const chunks: Uint8Array[] = [];
        const reader = s2.getReader();
        let total = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) { chunks.push(value); total += value.length; }
        }
        const flat = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) { flat.set(c, o); o += c.length; }
        const digest = await crypto.subtle.digest(subtleAlgo, flat);
        // base64 encode.
        const bytes = new Uint8Array(digest);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const gotB64 = btoa(bin);
        if (gotB64 !== expectedB64) {
          throw new Error(
            `integrity mismatch for ${spec.name}@${spec.version}: expected ${algo}-${expectedB64}, got ${algo}-${gotB64}`,
          );
        }
      })();
    }
  } else {
    bytesStream = body;
  }

  // 3. Decompress + tar parse (streaming).
  const decompressed = bytesStream.pipeThrough(new DecompressionStream('gzip'));
  // `readableStreamToAsyncIterable` / `streamTarEntries` are provided by
  // the pool preamble; TypeScript doesn't see them but workerd will.
  // @ts-ignore — injected at load time.
  const asyncIter = readableStreamToAsyncIterable(decompressed);

  // 4. Build + flush BatchWritePayload(s).
  //
  // Workerd enforces a hard 32 MiB limit on RPC argument+return values.
  // Large packages (TypeScript ~23 MB, next.js, react-native-web, …)
  // produce tarball-extracted payloads that, once wrapped in the
  // writeBatch argument structure (paths + metadata + v8 overhead),
  // can exceed the cap — the user-observed failure was 35,342,531 B
  // on one package, aborting the whole install.
  //
  // Fix: chunk the writeBatch by byte count as entries accumulate. At
  // RPC_FLUSH_THRESHOLD, flush the current inode+chunk buffer to the
  // supervisor, clear locally, and keep streaming. File-write order
  // inside a package doesn't matter (paths are absolute, INSERT OR
  // REPLACE on the DO side), and the supervisor's writeBatch itself
  // runs inside a transactionSync per call — so each partial flush is
  // internally atomic, and the union covers the full package.
  //
  // Directory inodes are collected separately in dirSet and appended
  // in the final flush — they depend on nothing file-side and are
  // cheap.
  const pkgDir = spec.pkgDir;
  type InodeT = {
    path: string;
    parentPath: string;
    isDir: boolean;
    size: number;
    mtime: number;
    mode: number;
    chunkCount: number;
  };
  type ChunkT = { path: string; chunkId: number; data: Uint8Array };

  let inodes: InodeT[] = [];
  let chunks: ChunkT[] = [];
  // Running byte estimate for the current buffer. Dominated by chunk
  // `data` bytes; we add per-chunk/inode fixed overhead to account for
  // path strings + numbers + v8 structured-clone wrapper cost. These
  // constants are rough; the threshold is set conservatively below to
  // absorb inaccuracy.
  const INODE_OVERHEAD = 160; // 7 numeric fields + 2 short path strings
  const CHUNK_OVERHEAD = 96;  // path string + chunkId + Uint8Array wrapper
  // Keep the RPC argument well under workerd's 32 MiB cap. 24 MiB leaves
  // 8 MiB headroom for: the Uint8Array serialization overhead workerd
  // adds for cross-isolate transfer, the inodes array, and whatever
  // additional framing the RPC layer applies.
  const RPC_FLUSH_THRESHOLD = 24 * 1024 * 1024;
  let bufferedBytes = 0;

  // Totals for the returned FacetPackageResult.
  let totalFileInodes = 0;
  let totalBytesWritten = 0;

  const dirSet = new Set<string>();
  const parentOf = (p: string) => (p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '');
  dirSet.add(pkgDir);

  const flush = async () => {
    if (inodes.length === 0 && chunks.length === 0) return;
    await env.SUPERVISOR.writeBatch({ inodes, chunks });
    inodes = [];
    chunks = [];
    bufferedBytes = 0;
  };

  // Skip-observer: converts silent tar-level drops into user-visible
  // warnings the supervisor prints in the install log. Without this,
  // a file bigger than MAX_FILE_BYTES (or a malformed/non-regular
  // header) disappears with no signal — exactly the failure mode that
  // hid the esbuild-wasm wasm miss in Nimbus-in-Nimbus. We only warn
  // on 'too-large'; 'non-regular' fires for every directory and PaxHeader
  // in a normal tarball (dozens per package) and would drown out the
  // signal. 'no-name' is similarly expected for some PaxHeader-style
  // entries. Callers that want full visibility can extend this later.
  const onSkip = (name: string, size: number, reason: string) => {
    if (reason === 'too-large') {
      warnings.push(
        `skipped "${name}" (${size} bytes) — exceeds per-file cap; file not installed`,
      );
    }
  };
  // @ts-ignore — streamTarEntries injected by preamble.
  for await (const entry of streamTarEntries(asyncIter, onSkip)) {
    const filePath = pkgDir + '/' + entry.name;
    // Accumulate every ancestor directory so the VFS has parent inodes.
    const parts = filePath.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirSet.add(parts.slice(0, i).join('/'));
    }
    const data: Uint8Array = entry.data;
    const size = data.length;
    const chunkCount = size === 0 ? 0 : Math.ceil(size / spec.chunkSize);
    inodes.push({
      path: filePath,
      parentPath: parentOf(filePath),
      isDir: false,
      size,
      mtime: spec.mtime,
      mode: 0o644,
      chunkCount,
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

    // Flush BETWEEN files (not mid-file) so each flush is self-consistent:
    // all chunks for a given file are either in the same flush or all in
    // the next. The supervisor's INSERT OR REPLACE handles both orders
    // correctly, but keeping chunks-with-their-inode together makes the
    // flush path easier to reason about if we ever add partial-recovery.
    if (bufferedBytes >= RPC_FLUSH_THRESHOLD) {
      await flush();
    }
  }

  // Wait for integrity verification to finish BEFORE the final flush.
  // A mismatch throws and the supervisor never sees the final (or any
  // pending) payload. Note: if we already flushed partial batches above
  // and integrity later fails, the VFS will carry the partial write
  // until something retries. npm install in Nimbus is idempotent at
  // the package-dir level — a retry of the same spec will re-INSERT
  // OR REPLACE the same paths, so partial-leave-behind is recoverable,
  // not corrupting.
  await integrityPromise;

  // Append all collected directory inodes to the final flush. Directory
  // inode writes are cheap (no chunks) and typically number in the low
  // tens per package, so they always fit in the last flush regardless
  // of how many partial flushes happened above.
  for (const d of dirSet) {
    inodes.push({
      path: d,
      parentPath: parentOf(d),
      isDir: true,
      size: 0,
      mtime: spec.mtime,
      mode: 0o755,
      chunkCount: 0,
    });
    bufferedBytes += INODE_OVERHEAD + d.length * 2;
  }

  // 5. Final flush. Empty buffers skip cleanly (see flush()).
  await flush();

  return {
    name: spec.name,
    version: spec.version,
    fileCount: totalFileInodes,
    bytesWritten: totalBytesWritten,
    elapsed: Date.now() - t0,
    warnings,
  };
};

