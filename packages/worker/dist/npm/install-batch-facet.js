/**
 * npm-install-batch-facet.ts — single-facet batch installer.
 *
 * Why this exists
 * ───────────────
 * The previous per-package pool.map architecture spawned
 * ONE dynamic worker per pool slot. With concurrency=4, that's 4 permanent
 * loader entries in workerd's loader cache (each `loader.get(id, …)` call
 * is cached by id and the cache is never released — confirmed in
 * src/loaders/loader-pool.ts). Combine with:
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
 * writeBatch flush) stays in this function because cloudflare-parallel
 * serializes it via fn.toString() and cannot import sibling modules across
 * the isolate boundary.
 *
 * Stability invariants (cloudflare-parallel):
 *   - No `this` references.
 *   - No closure capture other than args + preamble names.
 *   - Preamble symbols (streamTarEntries, readableStreamToAsyncIterable,
 *     MAX_FILE_BYTES) referenced via @ts-ignore.
 */
// ── Facet function ──────────────────────────────────────────────────────
//
// Runs inside a NimbusLoaderPool isolate. Serialised via fn.toString();
// the helpers it references at top-level scope (streamTarEntries,
// readableStreamToAsyncIterable, MAX_FILE_BYTES) are NOT in the facet's
// lexical scope — the pool injects them via the preamble. No static
// imports of those names; references are bare identifiers.
export const installPackagesInFacet = async function installPackagesInFacet(batch, env) {
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
    const queue = [];
    const limit = (fn) => {
        return new Promise((resolve, reject) => {
            const run = async () => {
                active++;
                try {
                    resolve(await fn());
                }
                catch (e) {
                    reject(e);
                }
                finally {
                    active--;
                    if (queue.length > 0)
                        queue.shift()();
                }
            };
            if (active < concurrency)
                run();
            else
                queue.push(run);
        });
    };
    // ── Counters (facet-local; folded into result.facetCounters at end) ──
    let inFlight = 0;
    let inFlightPeak = 0;
    let cumulativeBytesDecoded = 0; // bytes of tarball body successfully read
    let tarballsCompleted = 0;
    let sharedWaves = 0;
    let sharedWaveMs = 0;
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
    const cacheStatEvents = [];
    // Shared-buffer flushes happen across packages, so smaller chunks keep
    // individual write transactions short and avoid aging the parent RPC.
    const SHARED_RPC_FLUSH_THRESHOLD = 4 * 1024 * 1024;
    const SHARED_RPC_PATH_LIMIT = 128;
    const INODE_OVERHEAD = 160;
    const CHUNK_OVERHEAD = 96;
    let sharedInodes = new Map();
    let sharedChunks = [];
    let sharedBufferedBytes = 0;
    let sharedOwners = new Set();
    const ownerWaves = new Map();
    const ownersWithCompletionMarker = new Set();
    const completionMarkers = new Map();
    // A wave RPC that workerd shed rather than ran is re-sendable: the
    // coordinator's input gate rejected it because its queue was too deep or
    // the object was reset mid-request, so none of the wave's writes landed.
    // Re-sending is safe even if some did — writeBatchStream is keyed by path
    // and the bytes are identical. Without this the first shed permanently
    // failed every package that contributed to the wave, which is how a
    // 119-package install came back with 88 packages.
    // ~42s of absorption. The coordinator's own verdict is "requests queued
    // for too long", so the schedule has to outlast a queue that deep; the
    // whole-batch timeout is 10 minutes, which bounds it.
    const WAVE_RETRY_BACKOFF_MS = [250, 1000, 3000, 6000, 12000, 20000];
    const isSheddableWaveError = (message) => {
        const m = message.toLowerCase();
        return m.includes('overloaded')
            || m.includes('reset because its code was updated')
            || m.includes('starting up durable object storage')
            || (m.includes('storage operation') && m.includes('reset'));
    };
    // Mutex: only one flush runs at a time. Concurrent installs awaiting
    // flush() will line up behind this promise and resolve in arrival
    // order — the W7 frame is opaque to ordering so this is safe.
    let sharedFlushInFlight = null;
    let sharedMutationInFlight = Promise.resolve();
    const withSharedMutation = async (action) => {
        const prior = sharedMutationInFlight;
        let release;
        sharedMutationInFlight = new Promise((resolve) => { release = resolve; });
        await prior;
        try {
            return await action();
        }
        finally {
            release();
        }
    };
    const doSharedFlush = async () => {
        if (sharedInodes.size === 0 && sharedChunks.length === 0)
            return;
        // Snapshot current contents and reset the buffer BEFORE awaiting
        // the RPC so a concurrent install can start filling the next batch.
        const inodesNow = [...sharedInodes.values()];
        const chunksNow = sharedChunks;
        sharedInodes = new Map();
        sharedChunks = [];
        sharedBufferedBytes = 0;
        const ownersNow = sharedOwners;
        sharedOwners = new Set();
        sharedWaves++;
        const waveT0 = Date.now();
        // One promise owns this exact wave. Register the SAME settled outcome
        // with every contributing package before awaiting the RPC, so a package
        // cannot report success while another package happens to be the caller
        // that triggered its shared flush.
        const wave = (async () => {
            for (let attempt = 0;; attempt++) {
                try {
                    // Each attempt encodes its OWN bytes. The encoder hands chunk
                    // buffers straight to a byte stream and workerd transfers them on
                    // enqueue, so `chunksNow` would be detached after the first send —
                    // a retry re-encoding it fails validation ("chunk 0 must contain N
                    // bytes") instead of re-sending the wave.
                    // @ts-ignore — preamble symbol.
                    const stream = encodeWriteBatchStream({
                        inodes: inodesNow,
                        chunks: chunksNow.map((c) => ({ ...c, data: c.data.slice() })),
                    });
                    // A typed non-ok result is the storage layer's verdict on these
                    // exact bytes, so it is returned as-is: only a shed RPC retries.
                    return await __nimbusUseRpcResult(env.SUPERVISOR.writeBatchStream(stream), (result) => {
                        if (result.ok)
                            return { ok: true };
                        return {
                            ok: false,
                            message: `writeBatchStream failed after group ${result.committedGroupSequence} ` +
                                `(${result.committedPathCount} committed paths): ${result.error.message}`,
                        };
                    });
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    if (attempt >= WAVE_RETRY_BACKOFF_MS.length || !isSheddableWaveError(message)) {
                        return { ok: false, message };
                    }
                    const base = WAVE_RETRY_BACKOFF_MS[attempt];
                    const delayMs = Math.max(0, Math.round(base + (Math.random() * 2 - 1) * base * 0.25));
                    await new Promise((rs) => setTimeout(rs, delayMs));
                }
            }
        })();
        for (const owner of ownersNow) {
            let waves = ownerWaves.get(owner);
            if (!waves) {
                waves = new Set();
                ownerWaves.set(owner, waves);
            }
            waves.add(wave);
        }
        await wave;
        sharedWaveMs += Date.now() - waveT0;
    };
    const sharedFlush = async () => {
        // Serialize: wait for any in-flight flush to complete first; then
        // start ours. Subsequent waiters chain after this one. Promise
        // chain is unbounded but each link is awaited once — no leaks.
        const prior = sharedFlushInFlight;
        const myFlush = (async () => {
            if (prior) {
                // The prior wave's outcome is already attached to every owner that
                // contributed to it. Continue draining this independent buffer so its
                // owners receive their own outcome as well.
                try {
                    await prior;
                }
                catch { /* owner reconciliation surfaces it */ }
            }
            await doSharedFlush();
        })();
        sharedFlushInFlight = myFlush;
        try {
            await myFlush;
        }
        finally {
            // If we're still the head of the chain, clear the slot so memory
            // doesn't grow unbounded over a long install.
            if (sharedFlushInFlight === myFlush)
                sharedFlushInFlight = null;
        }
    };
    const preflushSharedMutation = async (path, additionalBytes) => {
        if (sharedInodes.has(path)) {
            throw new Error(`duplicate path in npm write wave: ${path}`);
        }
        while (sharedInodes.size > 0 && (sharedBufferedBytes + additionalBytes > SHARED_RPC_FLUSH_THRESHOLD
            || sharedInodes.size + 1 > SHARED_RPC_PATH_LIMIT)) {
            await sharedFlush();
        }
    };
    const enqueueSharedFile = (ownerId, filePath, data, mtime, chunkSize) => withSharedMutation(async () => {
        const size = data.length;
        const chunkCount = size === 0 ? 0 : Math.ceil(size / chunkSize);
        // Re-enqueue of the same path is last-write-wins. This happens both when
        // two owners write the same shared file in a parallel install, and when a
        // single package tarball carries the same canonical path twice — e.g.
        // agent-base ships both "package/./dist/index.js" and
        // "package/dist/index.js", which collapse to one path. npm's own semantics
        // are last-entry-wins, so we replace rather than fail. Fully undo the prior
        // enqueue: drop its chunks (sharedChunks is append-only, else the inode's
        // chunkCount would disagree with the buffered chunks and the W7 encoder
        // rejects the wave "expected N chunks, got M") AND delete its inode, so the
        // preflushSharedMutation duplicate-path guard below doesn't trip on our own
        // intentional replacement. Mirror the dedup enqueueSharedDirectory performs.
        const existing = sharedInodes.get(filePath);
        if (existing) {
            if (existing.isDir)
                throw new Error(`file/directory collision in npm write wave: ${filePath}`);
            sharedBufferedBytes -= INODE_OVERHEAD + filePath.length * 2;
            for (let i = sharedChunks.length - 1; i >= 0; i--) {
                if (sharedChunks[i].path !== filePath)
                    continue;
                sharedBufferedBytes -= CHUNK_OVERHEAD + filePath.length + sharedChunks[i].data.length;
                sharedChunks.splice(i, 1);
            }
            sharedInodes.delete(filePath);
        }
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
        if (size <= 0)
            return;
        if (size <= chunkSize) {
            sharedChunks.push({ path: filePath, chunkId: 0, data });
            sharedBufferedBytes += CHUNK_OVERHEAD + filePath.length + data.length;
            return;
        }
        for (let chunkId = 0; chunkId < chunkCount; chunkId++) {
            const slice = data.slice(chunkId * chunkSize, (chunkId + 1) * chunkSize);
            sharedChunks.push({ path: filePath, chunkId, data: slice });
            sharedBufferedBytes += CHUNK_OVERHEAD + filePath.length + slice.length;
        }
    });
    const enqueueSharedDirectory = (ownerId, path, mtime) => withSharedMutation(async () => {
        const existing = sharedInodes.get(path);
        if (existing) {
            if (!existing.isDir)
                throw new Error(`file/directory collision in npm write wave: ${path}`);
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
    // Kept inline because cloudflare-parallel serializes this whole function
    // via fn.toString(); it cannot import a sibling module across the isolate
    // boundary. Retry behavior matches resolve-one-facet and _shared/retry.
    const installOne = async (spec, ownerId) => {
        const t0 = Date.now();
        const warnings = [];
        inFlight++;
        if (inFlight > inFlightPeak)
            inFlightPeak = inFlight;
        // [W4] 1a. Race the R2 cache lookup against the network fetch.
        //
        // Both legs start here. The R2 GET is bounded by R2_RACE_TIMEOUT_MS; if it
        // returns bytes first the network leg is cancelled, and otherwise the
        // network response has been in flight for the whole bounded wait rather
        // than starting from zero once the R2 leg gives up.
        //
        // Soft-fail: if env.SUPERVISOR.getCachedTarball isn't defined (older
        // supervisor deployment) the R2 leg becomes a noop and there is nothing to
        // overlap with, so the speculative fetch is not worth issuing — the retry
        // loop's own first fetch is already the first thing that happens.
        const r2Available = typeof env.SUPERVISOR.getCachedTarball === 'function';
        const r2WaitStart = Date.now();
        const r2P = r2Available
            ? Promise.race([
                __nimbusUseRpcResult(env.SUPERVISOR.getCachedTarball(spec.integrity), (result) => result),
                new Promise((rs) => setTimeout(() => rs(null), R2_RACE_TIMEOUT_MS)),
            ]).catch(() => null)
            : Promise.resolve(null);
        let pendingNetwork = null;
        if (r2Available) {
            speculativeFetches++;
            pendingNetwork = fetch(spec.tarballUrl);
            // Rejections are re-awaited and rethrown in order by takeNetworkResponse;
            // this sink only stops a failure that lands while the R2 leg is still
            // outstanding from surfacing as an unhandled rejection.
            pendingNetwork.catch(() => { });
        }
        const takeNetworkResponse = async () => {
            const pending = pendingNetwork;
            pendingNetwork = null;
            return pending ? await pending : await fetch(spec.tarballUrl);
        };
        const discardPendingNetwork = () => {
            const pending = pendingNetwork;
            pendingNetwork = null;
            if (!pending)
                return;
            void pending.then((response) => response.body?.cancel().catch(() => { }), () => { });
        };
        try {
            // [W4] Captured compressed bytes for write-back to R2 on miss.
            // Populated by the integrity-tee path below; remains null when
            // integrity isn't present (rare; we only writeback when we can
            // verify on next read). Hoisted to installOne scope per W4-plan
            // §11 finding #4 lifecycle correctness.
            let capturedTgzBytes = null;
            let r2HitBytes = null;
            // 1b. Try R2 first (bounded wait).
            if (r2Available) {
                try {
                    const r2Result = await r2P;
                    const r2WaitMs = Date.now() - r2WaitStart;
                    if (r2WaitMs > r2WaitMsMax)
                        r2WaitMsMax = r2WaitMs;
                    if (r2Result) {
                        r2HitBytes = r2Result.bytes;
                        // cache-obs-2: splice supervisor's per-tier events into
                        // the facet's accumulator. Filter to known tiers/kinds
                        // so a future supervisor schema change doesn't poison
                        // the result.
                        if (Array.isArray(r2Result.events)) {
                            for (const e of r2Result.events) {
                                if (!e || (e.kind !== 'hit' && e.kind !== 'miss'))
                                    continue;
                                if (e.tier !== 'L2' && e.tier !== 'L3')
                                    continue;
                                if (e.cacheKind !== 'tarball')
                                    continue;
                                if (e.kind === 'hit') {
                                    cacheStatEvents.push({
                                        kind: 'hit',
                                        tier: e.tier,
                                        cacheKind: 'tarball',
                                        bytes: typeof e.bytes === 'number' ? e.bytes : 0,
                                    });
                                }
                                else {
                                    cacheStatEvents.push({ kind: 'miss', tier: e.tier, cacheKind: 'tarball' });
                                }
                            }
                        }
                    }
                }
                catch {
                    r2HitBytes = null;
                }
            }
            // ── R2 HIT path ──────────────────────────────────────────────
            // We have bytes from the shared cache. They were re-hashed
            // against spec.integrity at the storage boundary, so synthesize
            // a body stream and skip the network entirely.
            let resp;
            // Definitely-assigned by either the R2-hit branch OR the network
            // branch below; explicit `!` keeps TS happy without runtime cost.
            let bytesStream;
            let integrityPromise = Promise.resolve();
            if (r2HitBytes && r2HitBytes.length > 0) {
                // Cache HIT. The cross-tenant store is content-addressed and
                // re-hashes on every read, so bytes that come back are already
                // proven to be spec.integrity's tarball — there is exactly one
                // verification point and it is not here.
                discardPendingNetwork();
                pipelinedTarballRaceWins++;
                tarballsCompleted++;
                cumulativeBytesDecoded += r2HitBytes.length;
                // Synthesize a Response body from the R2 bytes so the existing
                // decompress + tar pipeline below works unchanged.
                bytesStream = new Response(r2HitBytes).body;
                resp = new Response(r2HitBytes, { status: 200 });
            }
            if (!r2HitBytes) {
                pipelinedTarballRaceLosses++;
                // 1c. Fetch with retry on 5xx + network errors.
                //     Budget: 3 retries, jittered backoff 500/1500/4500 ms ±25%.
                const FACET_BACKOFF_MS = [500, 1500, 4500];
                const FACET_RETRIES = 3;
                let lastErr;
                for (let attempt = 0; attempt <= FACET_RETRIES; attempt++) {
                    try {
                        const r = await takeNetworkResponse();
                        if (r.ok || r.status < 500 || r.status > 599) {
                            resp = r;
                            lastErr = undefined;
                            break;
                        }
                        try {
                            await r.body?.cancel();
                        }
                        catch { /* best-effort */ }
                        lastErr = new Error(`HTTP ${r.status}`);
                        if (attempt === FACET_RETRIES) {
                            resp = r;
                            break;
                        }
                        const base = FACET_BACKOFF_MS[Math.min(attempt, FACET_BACKOFF_MS.length - 1)];
                        const jitter = Math.round(base + (Math.random() * 2 - 1) * base * 0.25);
                        const delayMs = Math.max(0, jitter);
                        warnings.push(`retry ${attempt + 1}/${FACET_RETRIES} after ${delayMs}ms (HTTP ${r.status})`);
                        await new Promise((rs) => setTimeout(rs, delayMs));
                    }
                    catch (e) {
                        lastErr = e;
                        if (attempt === FACET_RETRIES)
                            break;
                        const base = FACET_BACKOFF_MS[Math.min(attempt, FACET_BACKOFF_MS.length - 1)];
                        const jitter = Math.round(base + (Math.random() * 2 - 1) * base * 0.25);
                        const delayMs = Math.max(0, jitter);
                        const reason = e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e));
                        warnings.push(`retry ${attempt + 1}/${FACET_RETRIES} after ${delayMs}ms (${reason})`);
                        await new Promise((rs) => setTimeout(rs, delayMs));
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
                    if (!cl)
                        return 0;
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
                    const subtleAlgo = algo === 'sha512' ? 'SHA-512'
                        : algo === 'sha384' ? 'SHA-384'
                            : algo === 'sha256' ? 'SHA-256'
                                : algo === 'sha1' ? 'SHA-1'
                                    : '';
                    if (!subtleAlgo) {
                        warnings.push(`unknown integrity algo "${algo}"; skipped verification`);
                        bytesStream = body;
                    }
                    else {
                        const [s1, s2] = body.tee();
                        bytesStream = s1;
                        integrityPromise = (async () => {
                            const chunks = [];
                            const reader = s2.getReader();
                            let total = 0;
                            while (true) {
                                const { value, done } = await reader.read();
                                if (done)
                                    break;
                                if (value) {
                                    chunks.push(value);
                                    total += value.length;
                                }
                            }
                            cumulativeBytesDecoded += total;
                            const flat = new Uint8Array(total);
                            let o = 0;
                            for (const c of chunks) {
                                flat.set(c, o);
                                o += c.length;
                            }
                            const digest = await crypto.subtle.digest(subtleAlgo, flat);
                            const bytes = new Uint8Array(digest);
                            let bin = '';
                            for (let i = 0; i < bytes.length; i++)
                                bin += String.fromCharCode(bytes[i]);
                            const gotB64 = btoa(bin);
                            if (gotB64 !== expectedB64) {
                                throw new Error(`integrity mismatch for ${spec.name}@${spec.version}: expected ${algo}-${expectedB64}, got ${algo}-${gotB64}`);
                            }
                            // [W4] Capture for R2 write-back. Lifecycle: this assignment
                            // happens before integrityPromise resolves, which is awaited
                            // before flush() finishes. installOne then awaits the put
                            // before returning, so capturedTgzBytes is always populated
                            // by the time we reach the write-back code below.
                            capturedTgzBytes = flat;
                        })();
                    }
                }
                else {
                    bytesStream = body;
                }
            }
            else {
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
            const installRoot = spec.installRoot;
            // Use the shard-level inode/chunk buffer so flushes are per shard,
            // not per package. Per-package totals stay local to the result object.
            let totalFileInodes = 0;
            let totalBytesWritten = 0;
            const dirSet = new Set();
            let completionMarker = null;
            // Stage `installRoot` and every directory down to `dirPath` (inclusive),
            // root-to-leaf, BEFORE any file that needs them. The credentialed
            // writeBatch authorizes each staged path's parent per flush wave, so a
            // file cannot land in a wave ahead of its parent dir inode (which used
            // to surface as `ENOENT: .../node_modules`). Directories above the
            // install root are left untouched — they pre-exist and re-staging them
            // would trip the batch write-check on user-unwritable system dirs.
            const enqueueDirsUpTo = async (dirPath) => {
                if (dirPath.length < installRoot.length || !dirPath.startsWith(installRoot))
                    return;
                const suffix = dirPath === installRoot ? '' : dirPath.slice(installRoot.length + 1);
                const segs = suffix ? suffix.split('/') : [];
                for (let i = 0; i <= segs.length; i++) {
                    const d = i === 0 ? installRoot : installRoot + '/' + segs.slice(0, i).join('/');
                    if (dirSet.has(d))
                        continue;
                    dirSet.add(d);
                    await enqueueSharedDirectory(ownerId, d, spec.mtime);
                }
            };
            const enqueueFile = async (filePath, data) => {
                const size = data.length;
                await enqueueSharedFile(ownerId, filePath, data, spec.mtime, spec.chunkSize);
                totalFileInodes += 1;
                totalBytesWritten += size;
            };
            const onSkip = (name, size, reason) => {
                if (reason === 'too-large') {
                    warnings.push(`skipped "${name}" (${size} bytes) — exceeds per-file cap; file not installed`);
                }
            };
            // Ensure the package directory (and the install root above it) are
            // staged before any file or the completion marker — covers empty
            // packages whose only member is package.json.
            await enqueueDirsUpTo(pkgDir);
            // @ts-ignore — preamble symbol.
            for await (const entry of streamTarEntries(asyncIter, onSkip)) {
                // entry.name is already canonicalized (no "."/".." segments) by
                // the tar parser, so joining under the canonical pkgDir yields a
                // canonical path the w7-frame writer accepts.
                const filePath = pkgDir + '/' + entry.name;
                // Stage this file's parent-dir chain before the file itself.
                await enqueueDirsUpTo(filePath.substring(0, filePath.lastIndexOf('/')));
                const data = entry.data;
                if (entry.name === 'package.json') {
                    if (completionMarker) {
                        throw new Error(`package tarball contains duplicate root package.json: ${spec.name}@${spec.version}`);
                    }
                    completionMarker = { path: filePath, data };
                }
                else {
                    await enqueueFile(filePath, data);
                }
            }
            // Wait for integrity verification before final flush.
            await integrityPromise;
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
                        await __nimbusUseRpcResult(env.SUPERVISOR.putCachedTarball(spec.integrity, capturedTgzBytes), () => undefined);
                    }
                    catch {
                        // Best-effort cache write — never fail the install on R2 errors.
                    }
                }
            }
            return {
                name: spec.name, version: spec.version,
                fileCount: totalFileInodes, bytesWritten: totalBytesWritten,
                elapsed: Date.now() - t0, warnings,
            };
        }
        catch (e) {
            return {
                name: spec.name, version: spec.version,
                fileCount: 0, bytesWritten: 0, elapsed: Date.now() - t0, warnings,
                errorText: e?.message || String(e),
            };
        }
        finally {
            // No-op once the retry loop has taken it; closes every early return.
            discardPendingNetwork();
            inFlight = Math.max(0, inFlight - 1);
        }
    };
    // ── Dispatch all packages with internal pLimit ───────────────────────
    const perPackage = await Promise.all(batch.packages.map((spec, ownerId) => limit(() => installOne(spec, ownerId))));
    // [P0a wave-2] End-of-batch shared flush. Drains the last buffered
    // contributions (the per-package flush is threshold-based — anything
    // below the threshold sits here until end-of-batch).
    try {
        await sharedFlush();
    }
    catch { /* owner reconciliation surfaces it */ }
    // Wait for any chained flush still in-flight from the threshold path.
    if (sharedFlushInFlight) {
        try {
            await sharedFlushInFlight;
        }
        catch { /* errored flushes already surfaced */ }
    }
    // Only owners whose complete content history succeeded may publish the
    // package.json marker used by the next install's diff/skip decision.
    for (const [ownerId, marker] of completionMarkers) {
        const result = perPackage[ownerId];
        if (result.errorText)
            continue;
        const outcomes = await Promise.all([...(ownerWaves.get(ownerId) ?? [])]);
        if (outcomes.some((outcome) => !outcome.ok))
            continue;
        await enqueueSharedFile(ownerId, marker.path, marker.data, marker.mtime, marker.chunkSize);
        ownersWithCompletionMarker.add(ownerId);
    }
    try {
        await sharedFlush();
    }
    catch { /* owner reconciliation surfaces it */ }
    const reconciledPerPackage = await Promise.all(perPackage.map(async (result, ownerId) => {
        const outcomes = await Promise.all([...(ownerWaves.get(ownerId) ?? [])]);
        const failedWave = outcomes.find((outcome) => !outcome.ok);
        const errors = [];
        if (result.errorText)
            errors.push(result.errorText);
        if (failedWave)
            errors.push(failedWave.message);
        if (!result.errorText && !ownersWithCompletionMarker.has(ownerId)) {
            errors.push(`package completion marker was not queued: ${result.name}@${result.version}`);
        }
        if (errors.length === 0)
            return result;
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
            r2WaitMsMax,
            speculativeFetches,
            sharedWaves,
            sharedWaveMs,
        },
        cacheStatEvents,
    };
};
