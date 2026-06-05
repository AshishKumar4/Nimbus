/**
 * resolve-one-facet.ts — per-package resolution task body.
 *
 * Why this exists
 * ───────────────
 * The supervisor coordinates each dependency layer and submits packages as
 * independent fanout tasks. This file is the per-task body: one packument
 * fetch, one version pick, and edge extraction.
 *
 * Each task runs inside a Worker Loader isolate (NimbusFanoutPool routes
 * automatically: <5 = in-DO, ≥5 = peer-DO). The isolate is short-lived;
 * task body has its own ~128 MiB envelope. Parallelism = layer width
 * (capped at 32 by NimbusFanoutPool's MAX_PEER_FANOUT).
 *
 * Stability invariants (cloudflare-parallel serialises via fn.toString)
 * ───────────────────────────────────────────────────────────────────
 *   - No `this` references.
 *   - No closure capture other than args + preamble names.
 *   - All helpers (semver, exports, skip-list, registry decisions) are
 *     accessed via bare identifiers from the preamble:
 *
 *       SHOULD_SKIP_PACKAGE(name, frameworkAware) → boolean
 *       SHOULD_SWAP(name) → { from, to } | null
 *       SHOULD_WARN_SKIP_TRANSITIVE(name) → { from, reason } | null
 *       SHOULD_REJECT_FAIL(name) → { from, reason, suggest? } | null
 *       PARSE_SEMVER(v) → [maj, min, patch] | null
 *       COMPARE_SEMVER(a, b) → number
 *       RESOLVE_VERSION(versions, range) → string | null
 *
 * What the task does NOT do (supervisor responsibility)
 * ─────────────────────────────────────────────────────
 *   - Edge extraction: the supervisor pulls deps/peerDeps/optionalDeps
 *     out of the returned `pkg` and decides what goes in layer N+1.
 *   - Cycle detection: the supervisor maintains the `seen` set across
 *     layers. The task only sees one (name, range) per call.
 *   - Best-effort optional-peer tagging: the supervisor maintains the
 *     bestEffortNames set; the task returns the `pkg` raw and the
 *     supervisor decides whether a downstream reject silent-skips or
 *     propagates.
 *   - Top-level handling: the supervisor maintains topLevelNames.
 *     `topLevel` is passed in per task so SKIP_PACKAGES bypass works.
 *
 * What the task DOES do
 * ─────────────────────
 *   1. Apply SKIP_PACKAGES filter (unless `topLevel`).
 *   2. Apply swap / warn-skip / reject-fail registry policy.
 *   3. Try in-task cache from `cachedHit` (one entry shipped from
 *      supervisor's NpmCache).
 *   4. R2 packument cache race (250 ms timeout) via env.SUPERVISOR
 *      bindings.
 *   5. Fetch packument with retry/backoff if no cache hit.
 *   6. Pick version via preamble's RESOLVE_VERSION.
 *   7. Materialise ResolvedPackage shape (versionToResolved-style).
 *   8. Stage cache writes for this version + top-5 recent versions
 *      (mirrors resolve-facet.ts:580). Returns them in `cacheWrites`
 *      so the supervisor can flush in one batched RPC.
 *   9. Return {pkg, deps, peerDeps, optionalDeps, allPeerDependencies,
 *      cacheWrites, messages, events, packumentBytesDecoded,
 *      packumentSource, error?}.
 */
/**
 * Per-package fanout task body. Serialised via fn.toString() and
 * dispatched by NimbusFanoutPool.submitMany — see installer.ts
 * resolveTreeViaFanout.
 *
 * Function signature MUST be `(spec, env)` so NimbusFanoutPool's
 * submitMany invocation `fn(item, env)` lines up.
 *
 * `env` is the loader-isolate env supplied by NimbusFanoutPool.
 * `env.SUPERVISOR` is the supervisor-rpc binding (putRegistryEntries,
 * getCachedPackument, putCachedPackument).
 */
export const resolveOnePackumentInFacet = async function resolveOnePackumentInFacet(spec, env) {
    const messages = [];
    const events = [];
    const cacheWrites = [];
    // cache-obs-2: per-resolve cache events. Filled by the L2/L3 path
    // (spliced from supervisor RPC return.events) and the L4 path
    // (post-network-fetch). Threaded through `out()` into the result.
    const cacheStatEvents = [];
    const out = (pkg, bytes, source, error) => ({
        pkg,
        deps: pkg?.dependencies ?? {},
        peerDeps: pkg?.peerDependencies ?? {},
        optionalDeps: pkg?.optionalDependencies ?? {},
        allPeerDependencies: pkg?.__allPeerDependencies ?? {},
        cacheWrites,
        messages,
        events,
        packumentBytesDecoded: bytes,
        packumentSource: source,
        cacheStatEvents,
        error,
    });
    // 1. SKIP_PACKAGES gate.
    // @ts-ignore — preamble.
    if (!spec.topLevel && SHOULD_SKIP_PACKAGE(spec.name, !!spec.frameworkAware)) {
        return out(null, 0, 'skipped');
    }
    // 2. Registry policy.
    let effName = spec.name;
    // @ts-ignore — preamble.
    const __swap = SHOULD_SWAP(spec.name);
    if (__swap) {
        messages.push(`[npm] \x1b[33m[swap]\x1b[0m ${__swap.from} → ${__swap.to}`);
        events.push({ type: 'swap', from: __swap.from, to: __swap.to, ctx: 'transitive' });
        effName = __swap.to;
    }
    else {
        // @ts-ignore — preamble.
        const __warn = SHOULD_WARN_SKIP_TRANSITIVE(spec.name);
        if (__warn) {
            messages.push(`[npm] \x1b[33m[skip]\x1b[0m ${__warn.from} — ${__warn.reason}`);
            events.push({ type: 'transitive-skip', from: __warn.from, reason: __warn.reason });
            return out(null, 0, 'skipped');
        }
        // @ts-ignore — preamble.
        const __fail = SHOULD_REJECT_FAIL(spec.name);
        if (__fail) {
            events.push({
                type: 'reject',
                from: __fail.from,
                reason: __fail.reason,
                suggest: __fail.suggest,
                ctx: 'transitive',
            });
            return out(null, 0, 'skipped', {
                type: 'w6-reject',
                from: __fail.from,
                reason: __fail.reason,
                suggest: __fail.suggest,
            });
        }
    }
    // 3. cachedHit fast-path.
    const cached = (() => {
        const entries = spec.cachedEntries || [];
        if (entries.length === 0)
            return null;
        const cleanRange = (spec.range || '').replace(/^[~^>=<\s]+/, '');
        if (/^\d+\.\d+\.\d+$/.test(cleanRange)) {
            const exact = entries.find((e) => e.name === effName && e.version === cleanRange);
            if (exact)
                return exact;
        }
        const candidates = entries.filter((e) => e.name === effName);
        if (candidates.length === 0)
            return null;
        const versions = candidates.map((e) => e.version);
        // @ts-ignore — preamble.
        const picked = RESOLVE_VERSION(versions, spec.range);
        if (!picked)
            return null;
        return candidates.find((e) => e.version === picked) || null;
    })();
    if (cached) {
        let deps = {}, peers = {}, exp = null, bin = {};
        try {
            deps = JSON.parse(cached.depsJson);
        }
        catch { }
        try {
            peers = cached.peerDepsJson ? JSON.parse(cached.peerDepsJson) : {};
        }
        catch { }
        try {
            exp = JSON.parse(cached.exportsJson);
        }
        catch { }
        try {
            bin = JSON.parse(cached.binJson);
        }
        catch { }
        const pkgFromCache = {
            name: cached.name,
            version: cached.version,
            tarballUrl: cached.tarballUrl,
            integrity: cached.integrity,
            dependencies: deps,
            peerDependencies: Object.keys(peers).length > 0 ? peers : undefined,
            exports: exp,
            main: cached.main,
            module: cached.moduleField,
            bin,
        };
        return out(pkgFromCache, 0, 'cache-hit');
    }
    // 4 + 5. R2 race + network fetch.
    const NPM_REGISTRY = 'https://registry.npmjs.org';
    const safeName = effName.startsWith('@')
        ? '@' + encodeURIComponent(effName.slice(1))
        : encodeURIComponent(effName);
    const url = NPM_REGISTRY + '/' + safeName;
    const R2_RACE_MS = 250;
    const totalRetries = Math.max(0, spec.retries ?? 3);
    const fetchTimeoutMs = spec.fetchTimeoutMs ?? 15_000;
    // [W4 + cache-obs-2] R2 race. Adapts to either supervisor return
    // shape: v1 bare `{json, ageMs, expired} | null` OR v2 envelope
    // `{ cached, events }`.
    let packumentText = null;
    let packumentSource = 'network';
    if (env?.SUPERVISOR && typeof env.SUPERVISOR.getCachedPackument === 'function') {
        try {
            const r2P = Promise.race([
                env.SUPERVISOR.getCachedPackument(effName),
                new Promise((rs) => setTimeout(() => rs(null), R2_RACE_MS)),
            ]).catch(() => null);
            const r2Raw = await r2P;
            // Adapt to BOTH shapes.
            let cachedEntry = null;
            if (r2Raw && typeof r2Raw === 'object') {
                if ('cached' in r2Raw && 'events' in r2Raw) {
                    // v2 envelope
                    cachedEntry = r2Raw.cached;
                    // Splice supervisor's L2/L3 events into our accumulator.
                    const supEvents = r2Raw.events;
                    if (Array.isArray(supEvents)) {
                        for (const e of supEvents) {
                            if (!e || (e.kind !== 'hit' && e.kind !== 'miss'))
                                continue;
                            if (e.tier !== 'L2' && e.tier !== 'L3')
                                continue;
                            if (e.cacheKind !== 'packument')
                                continue;
                            if (e.kind === 'hit') {
                                cacheStatEvents.push({
                                    kind: 'hit',
                                    tier: e.tier,
                                    cacheKind: 'packument',
                                    bytes: typeof e.bytes === 'number' ? e.bytes : 0,
                                });
                            }
                            else {
                                cacheStatEvents.push({ kind: 'miss', tier: e.tier, cacheKind: 'packument' });
                            }
                        }
                    }
                }
                else if ('json' in r2Raw) {
                    // v1 bare shape
                    cachedEntry = r2Raw;
                }
            }
            if (cachedEntry && !cachedEntry.expired && cachedEntry.json) {
                packumentText = cachedEntry.json;
                packumentSource = 'r2-cache';
            }
        }
        catch { /* best-effort, fall through */ }
    }
    if (packumentText === null) {
        const BACKOFF = [500, 1500, 4500];
        let lastErr;
        for (let attempt = 0; attempt <= totalRetries; attempt++) {
            try {
                const ctl = new AbortController();
                const t = setTimeout(() => ctl.abort(), fetchTimeoutMs);
                let resp;
                try {
                    resp = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctl.signal });
                }
                finally {
                    clearTimeout(t);
                }
                if (resp.ok) {
                    packumentText = await resp.text();
                    // cache-obs-2: record the L4 hit. byte count is the
                    // packument JSON length (authoritative, post-read).
                    cacheStatEvents.push({
                        kind: 'hit',
                        tier: 'L4',
                        cacheKind: 'packument',
                        bytes: packumentText.length,
                    });
                    // [W4] Best-effort R2 write-back. Awaited per W4-plan §11.
                    if (env?.SUPERVISOR && typeof env.SUPERVISOR.putCachedPackument === 'function') {
                        try {
                            await env.SUPERVISOR.putCachedPackument(effName, packumentText);
                        }
                        catch { /* swallow */ }
                    }
                    break;
                }
                if (resp.status >= 400 && resp.status < 500) {
                    // 4xx — package or version doesn't exist. Treat as null.
                    messages.push(`[resolve-one] ${effName}: HTTP ${resp.status}`);
                    return out(null, 0, 'network');
                }
                try {
                    await resp.body?.cancel();
                }
                catch { }
                lastErr = new Error('HTTP ' + resp.status);
            }
            catch (e) {
                lastErr = e;
            }
            if (attempt < totalRetries) {
                const base = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
                const jitter = Math.round(base + (Math.random() * 2 - 1) * base * 0.25);
                await new Promise((r) => setTimeout(r, Math.max(0, jitter)));
            }
        }
        if (packumentText === null) {
            messages.push(`[resolve-one] ${effName}: fetch exhausted: ${lastErr?.message ?? lastErr}`);
            return out(null, 0, 'network', { type: 'fetch-exhausted', message: String(lastErr?.message ?? lastErr) });
        }
    }
    const bytes = packumentText.length;
    let data;
    try {
        data = JSON.parse(packumentText);
    }
    catch (e) {
        messages.push(`[resolve-one] ${effName}: malformed packument: ${e?.message ?? e}`);
        return out(null, bytes, packumentSource);
    }
    if (!data || !data.versions) {
        return out(null, bytes, packumentSource);
    }
    // 6. Pick version.
    let version = null;
    if (spec.range && data.versions[spec.range])
        version = spec.range;
    if (!version && spec.range && spec.range !== 'latest') {
        const allVersions = Object.keys(data.versions);
        // @ts-ignore — preamble.
        version = RESOLVE_VERSION(allVersions, spec.range);
    }
    if (!version) {
        version = data['dist-tags']?.[spec.range] || data['dist-tags']?.latest || null;
    }
    if (!version || !data.versions[version]) {
        messages.push(`[resolve-one] ${effName}: no version satisfies ${spec.range}`);
        return out(null, bytes, packumentSource);
    }
    // 7. Materialise ResolvedPackage.
    const vData = data.versions[version];
    const versionToResolved = (v) => {
        const binField = v.bin || {};
        const bin = typeof binField === 'string'
            ? { [String(v.name).split('/').pop()]: binField }
            : binField;
        let peerDependencies;
        let allPeers;
        const peers = v.peerDependencies;
        if (peers && typeof peers === 'object') {
            const meta = v.peerDependenciesMeta;
            const required = {};
            const all = {};
            for (const [n, r] of Object.entries(peers)) {
                if (typeof r !== 'string')
                    continue;
                all[n] = r;
                if (meta && meta[n] && meta[n].optional === true)
                    continue;
                required[n] = r;
            }
            if (Object.keys(required).length > 0)
                peerDependencies = required;
            if (Object.keys(all).length > 0)
                allPeers = all;
        }
        const optionalDependencies = v.optionalDependencies && typeof v.optionalDependencies === 'object'
            ? Object.fromEntries(Object.entries(v.optionalDependencies).filter(([, r]) => typeof r === 'string'))
            : undefined;
        const resolvedOut = {
            name: v.name,
            version: v.version,
            tarballUrl: v.dist?.tarball || '',
            integrity: v.dist?.integrity || v.dist?.shasum || '',
            dependencies: v.dependencies || {},
            peerDependencies,
            optionalDependencies,
            os: Array.isArray(v.os) ? v.os : undefined,
            cpu: Array.isArray(v.cpu) ? v.cpu : undefined,
            libc: Array.isArray(v.libc) ? v.libc : undefined,
            exports: v.exports ?? null,
            main: v.main || '',
            module: v.module || '',
            bin,
        };
        if (allPeers)
            resolvedOut.__allPeerDependencies = allPeers;
        return resolvedOut;
    };
    const pkg = versionToResolved(vData);
    // 8. Stage cache writes.
    cacheWrites.push({
        name: pkg.name,
        version: pkg.version,
        tarballUrl: pkg.tarballUrl,
        integrity: pkg.integrity,
        depsJson: JSON.stringify(pkg.dependencies),
        peerDepsJson: JSON.stringify(pkg.peerDependencies ?? {}),
        exportsJson: JSON.stringify(pkg.exports ?? {}),
        main: pkg.main,
        moduleField: pkg.module,
        binJson: JSON.stringify(pkg.bin),
        fetchedAt: Date.now(),
    });
    // Top-5 sibling versions, mirrors resolve-facet.ts:580.
    const sorted = Object.keys(data.versions)
        // @ts-ignore — preamble.
        .map((v) => ({ v, p: PARSE_SEMVER(v) }))
        .filter((x) => x.p !== null)
        // @ts-ignore — preamble.
        .sort((a, b) => COMPARE_SEMVER(b.p, a.p));
    for (let i = 0; i < Math.min(5, sorted.length); i++) {
        const otherVer = sorted[i].v;
        if (otherVer === pkg.version)
            continue;
        const otherData = data.versions[otherVer];
        if (!otherData)
            continue;
        try {
            const otherPkg = versionToResolved(otherData);
            cacheWrites.push({
                name: otherPkg.name,
                version: otherPkg.version,
                tarballUrl: otherPkg.tarballUrl,
                integrity: otherPkg.integrity,
                depsJson: JSON.stringify(otherPkg.dependencies),
                peerDepsJson: JSON.stringify(otherPkg.peerDependencies ?? {}),
                exportsJson: JSON.stringify(otherPkg.exports ?? {}),
                main: otherPkg.main,
                moduleField: otherPkg.module,
                binJson: JSON.stringify(otherPkg.bin),
                fetchedAt: Date.now(),
            });
        }
        catch { /* skip malformed */ }
    }
    return out(pkg, bytes, packumentSource);
};
