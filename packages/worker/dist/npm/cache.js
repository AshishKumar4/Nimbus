/**
 * npm-cache.ts — SQLite-backed package cache for Nimbus npm v2.
 *
 * Four tables:
 *   1. pkg_registry_cache — packument metadata (avoids re-fetching full JSON)
 *   2. pkg_tarball_cache  — extracted file contents per name@version
 *   3. pkg_lockfile        — resolved dependency graph per project
 *   4. pkg_esm_bundles     — pre-bundled ESM for /@modules/ serving
 *
 * All tables live in the same DO SQLite as the VFS. Schema is created lazily
 * on first use (not at VFS init, to avoid penalizing sessions that don't npm install).
 *
 * L1 cache observability (cache metrics support):
 *   getRegistryEntry / getTarballFiles bump per-tier counters via
 *   src/_shared/cache-stats.ts. Hit = row(s) returned with size > 0;
 *   miss = empty result set. Callers fall through to L2/L3/L4 on miss.
 */
import { recordHit as _l1RecordHit, recordMiss as _l1RecordMiss } from '../_shared/cache-stats.js';
// ── NpmCache ────────────────────────────────────────────────────────────
export class NpmCache {
    sql;
    initialized = false;
    constructor(sql) {
        this.sql = sql;
    }
    // ── Schema ────────────────────────────────────────────────────────────
    ensureSchema() {
        if (this.initialized)
            return;
        this.sql.exec(`CREATE TABLE IF NOT EXISTS pkg_registry_cache (
      name           TEXT NOT NULL,
      version        TEXT NOT NULL,
      tarball_url    TEXT NOT NULL,
      integrity      TEXT NOT NULL DEFAULT '',
      deps_json      TEXT NOT NULL DEFAULT '{}',
      peer_deps_json TEXT NOT NULL DEFAULT '{}',
      exports_json   TEXT NOT NULL DEFAULT '{}',
      main           TEXT NOT NULL DEFAULT '',
      module_field   TEXT NOT NULL DEFAULT '',
      bin_json       TEXT NOT NULL DEFAULT '{}',
      fetched_at     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (name, version)
    )`);
        // X.5-F R2: peer_deps_json column added in this wave. Older tenants
        // have a registry cache table without it — ALTER TABLE adds it
        // with the same NOT NULL DEFAULT '{}' the CREATE specifies. SQLite
        // ignores ADD COLUMN if the column already exists in newer setups
        // — except it doesn't, it errors. So we probe via PRAGMA first.
        let hasPeerCol = false;
        try {
            const cols = [...this.sql.exec(`PRAGMA table_info(pkg_registry_cache)`)];
            hasPeerCol = cols.some((r) => String(r.name) === 'peer_deps_json');
        }
        catch { /* PRAGMA failed — fall through and ATTEMPT, swallow on error */ }
        if (!hasPeerCol) {
            try {
                this.sql.exec(`ALTER TABLE pkg_registry_cache ADD COLUMN peer_deps_json TEXT NOT NULL DEFAULT '{}'`);
            }
            catch (e) {
                // Race or pre-existing — non-fatal; the column might already
                // exist if the CREATE just ran above on a fresh tenant.
                const msg = e?.message || String(e);
                if (!/duplicate column/i.test(msg)) {
                    console.error('[npm-cache] peer_deps_json migration failed:', msg);
                }
            }
        }
        this.sql.exec(`CREATE TABLE IF NOT EXISTS pkg_tarball_cache (
      name     TEXT NOT NULL,
      version  TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      data     BLOB NOT NULL,
      size     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (name, version, rel_path)
    )`);
        this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_pkg_tarball_nv ON pkg_tarball_cache(name, version)`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS pkg_lockfile (
      project_path TEXT NOT NULL,
      name         TEXT NOT NULL,
      resolved_ver TEXT NOT NULL,
      integrity    TEXT NOT NULL DEFAULT '',
      deps_json    TEXT NOT NULL DEFAULT '{}',
      hoisted_path TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (project_path, name)
    )`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS pkg_esm_bundles (
      specifier   TEXT PRIMARY KEY,
      bundle_hash TEXT NOT NULL,
      esm_code    TEXT NOT NULL,
      built_at    INTEGER NOT NULL DEFAULT 0,
      input_hash  TEXT NOT NULL DEFAULT ''
    )`);
        this.initialized = true;
    }
    // ── Registry cache ────────────────────────────────────────────────────
    /** Get cached registry metadata for a specific name@version.
     *
     *  L1 observability: bumps cache-stats L1.packument hit/miss. Bytes
     *  on hit = approximate size of the deserialized RegistryCacheEntry,
     *  computed as sum of major-string lengths (depsJson + peerDepsJson +
     *  exportsJson + binJson + a few tens of bytes overhead). This is a
     *  good proxy for "how much L1 data did we save fetching" — not the
     *  exact SQLite blob byte count (which would require a separate
     *  SELECT). */
    getRegistryEntry(name, version) {
        this.ensureSchema();
        const rows = [...this.sql.exec(`SELECT name, version, tarball_url, integrity, deps_json, peer_deps_json, exports_json, main, module_field, bin_json, fetched_at
       FROM pkg_registry_cache WHERE name = ? AND version = ?`, name, version)];
        if (rows.length === 0) {
            _l1RecordMiss('L1', 'packument');
            return null;
        }
        const r = rows[0];
        const entry = {
            name: String(r.name),
            version: String(r.version),
            tarballUrl: String(r.tarball_url),
            integrity: String(r.integrity),
            depsJson: String(r.deps_json),
            peerDepsJson: String(r.peer_deps_json ?? '{}'),
            exportsJson: String(r.exports_json),
            main: String(r.main),
            moduleField: String(r.module_field),
            binJson: String(r.bin_json),
            fetchedAt: Number(r.fetched_at),
        };
        // Approximate hit-bytes: sum of variable-length string fields.
        // The fixed-cost fields (name, version, integrity, etc.) add ~150
        // bytes on average; the variable fields can be tens of KB for
        // packages with large exports maps. Skip the constant overhead so
        // bytes correlates with the dominant cost.
        const bytes = entry.depsJson.length +
            entry.peerDepsJson.length +
            entry.exportsJson.length +
            entry.binJson.length;
        _l1RecordHit('L1', 'packument', bytes);
        return entry;
    }
    /**
     * Bulk read of cached registry entries — used by the resolver-facet
     * dispatcher to pre-load cached metadata it can ship across to the
     * facet at phase start. Caller passes a hard cap; we LIMIT in SQL so
     * a pathologically warm cache doesn't OOM the supervisor reading its
     * own cache.
     *
     * Order: most-recently-fetched first, so when the cap truncates we
     * keep the freshest entries (most likely to satisfy current ranges).
     */
    dumpRegistryEntries(maxRows) {
        this.ensureSchema();
        const rows = [...this.sql.exec(`SELECT name, version, tarball_url, integrity, deps_json, peer_deps_json, exports_json, main, module_field, bin_json, fetched_at
       FROM pkg_registry_cache ORDER BY fetched_at DESC LIMIT ?`, maxRows)];
        return rows.map((r) => ({
            name: String(r.name),
            version: String(r.version),
            tarballUrl: String(r.tarball_url),
            integrity: String(r.integrity),
            depsJson: String(r.deps_json),
            peerDepsJson: String(r.peer_deps_json ?? '{}'),
            exportsJson: String(r.exports_json),
            main: String(r.main),
            moduleField: String(r.module_field),
            binJson: String(r.bin_json),
            fetchedAt: Number(r.fetched_at),
        }));
    }
    /** Get all cached versions for a package name. */
    getRegistryVersions(name) {
        this.ensureSchema();
        const rows = [...this.sql.exec(`SELECT name, version, tarball_url, integrity, deps_json, peer_deps_json, exports_json, main, module_field, bin_json, fetched_at
       FROM pkg_registry_cache WHERE name = ?`, name)];
        return rows.map(r => ({
            name: String(r.name),
            version: String(r.version),
            tarballUrl: String(r.tarball_url),
            integrity: String(r.integrity),
            depsJson: String(r.deps_json),
            peerDepsJson: String(r.peer_deps_json ?? '{}'),
            exportsJson: String(r.exports_json),
            main: String(r.main),
            moduleField: String(r.module_field),
            binJson: String(r.bin_json),
            fetchedAt: Number(r.fetched_at),
        }));
    }
    /** Store registry metadata for a resolved package version. */
    putRegistryEntry(entry) {
        this.ensureSchema();
        this.sql.exec(`INSERT OR REPLACE INTO pkg_registry_cache
       (name, version, tarball_url, integrity, deps_json, peer_deps_json, exports_json, main, module_field, bin_json, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, entry.name, entry.version, entry.tarballUrl, entry.integrity, entry.depsJson, entry.peerDepsJson || '{}', entry.exportsJson, entry.main, entry.moduleField, entry.binJson, entry.fetchedAt);
    }
    /**
     * Bulk-write registry entries in ONE call. Used by the resolver-facet
     * to flush a wave of resolved packages back to the supervisor in a
     * single RPC round-trip; one-RPC-per-entry across ~456 transitive
     * deps would multiply RPC overhead by 100×.
     *
     * Each row is one prepared statement; we loop rather than building a
     * giant multi-row INSERT because workerd's SqlStorage `.exec()` is
     * already transaction-batched at the storage layer when called within
     * the same DO event loop turn (no explicit BEGIN/COMMIT needed for
     * atomicity of the batch — see Cloudflare DO SQLite docs). If a
     * single row fails (malformed data), it's logged and the rest still
     * commit; resolver correctness depends on cache being best-effort.
     */
    putRegistryEntries(entries) {
        this.ensureSchema();
        let written = 0;
        let failed = 0;
        for (const entry of entries) {
            try {
                this.sql.exec(`INSERT OR REPLACE INTO pkg_registry_cache
           (name, version, tarball_url, integrity, deps_json, peer_deps_json, exports_json, main, module_field, bin_json, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, entry.name, entry.version, entry.tarballUrl, entry.integrity, entry.depsJson, entry.peerDepsJson || '{}', entry.exportsJson, entry.main, entry.moduleField, entry.binJson, entry.fetchedAt);
                written++;
            }
            catch (e) {
                console.error(`[npm-cache] bulk putRegistryEntry failed for ${entry.name}@${entry.version}:`, e?.message);
                failed++;
            }
        }
        return { written, failed };
    }
    // ── Tarball cache ─────────────────────────────────────────────────────
    /** Check if a package version's files are cached. */
    hasTarballCache(name, version) {
        this.ensureSchema();
        const rows = [...this.sql.exec(`SELECT 1 FROM pkg_tarball_cache WHERE name = ? AND version = ? LIMIT 1`, name, version)];
        return rows.length > 0;
    }
    /** Get all cached files for a package version.
     *
     *  L1 observability: hit when rows > 0; miss when empty. Bytes on
     *  hit = sum of file sizes from the SIZE column (cheaper than
     *  measuring blob lengths after decode; SIZE is the source-of-truth
     *  stored at write time). */
    getTarballFiles(name, version) {
        this.ensureSchema();
        const rows = [...this.sql.exec(`SELECT rel_path, data, size FROM pkg_tarball_cache WHERE name = ? AND version = ?`, name, version)];
        if (rows.length === 0) {
            _l1RecordMiss('L1', 'tarball');
            return [];
        }
        const out = rows.map(r => ({
            relPath: String(r.rel_path),
            data: blobToUint8Array(r.data),
            size: Number(r.size),
        }));
        let totalBytes = 0;
        for (const f of out)
            totalBytes += f.size;
        _l1RecordHit('L1', 'tarball', totalBytes);
        return out;
    }
    /** Max individual file size for tarball cache (DO SQLite blob limit). */
    static MAX_CACHEABLE_FILE = 1_000_000; // 1MB
    /** Max total package size for tarball cache. */
    static MAX_CACHEABLE_PACKAGE = 5_000_000; // 5MB
    /**
     * Store extracted tarball files for a package version.
     * Skips packages that exceed the SQLite blob size limit (SQLITE_TOOBIG).
     * Large packages (date-fns, lucide-react) will be re-fetched on reinstall.
     */
    putTarballFiles(name, version, files, ctx) {
        this.ensureSchema();
        // Check total package size — skip caching if too large
        let totalSize = 0;
        for (const [, data] of files)
            totalSize += data.length;
        if (totalSize > NpmCache.MAX_CACHEABLE_PACKAGE) {
            console.log(`[npm-cache] skipping cache for ${name}@${version} (${(totalSize / 1e6).toFixed(1)}MB > 5MB limit)`);
            return;
        }
        // Filter out individual files that exceed the blob limit
        const entries = [...files.entries()].filter(([relPath, data]) => {
            if (data.length > NpmCache.MAX_CACHEABLE_FILE) {
                console.log(`[npm-cache] skipping large file ${relPath} (${(data.length / 1e6).toFixed(1)}MB)`);
                return false;
            }
            return true;
        });
        if (entries.length === 0)
            return;
        const doTx = (fn) => {
            if (ctx?.storage?.transactionSync) {
                ctx.storage.transactionSync(fn);
            }
            else {
                fn();
            }
        };
        doTx(() => {
            // Delete old entries for this package version (if re-caching)
            this.sql.exec(`DELETE FROM pkg_tarball_cache WHERE name = ? AND version = ?`, name, version);
            // Batch insert: DO SQLite has a low bind-parameter limit (~100 vars).
            // 5 columns per row → max 19 rows per statement (19×5=95).
            const BATCH = 19;
            for (let i = 0; i < entries.length; i += BATCH) {
                const batch = entries.slice(i, i + BATCH);
                const placeholders = batch.map(() => '(?,?,?,?,?)').join(',');
                const values = [];
                for (const [relPath, data] of batch) {
                    values.push(name, version, relPath, data, data.length);
                }
                this.sql.exec(`INSERT INTO pkg_tarball_cache (name, version, rel_path, data, size) VALUES ${placeholders}`, ...values);
            }
        });
    }
    /** Count cached files for a package version. */
    getTarballFileCount(name, version) {
        this.ensureSchema();
        const rows = [...this.sql.exec(`SELECT COUNT(*) as cnt FROM pkg_tarball_cache WHERE name = ? AND version = ?`, name, version)];
        return rows.length > 0 ? Number(rows[0].cnt) : 0;
    }
    // ── Lockfile ──────────────────────────────────────────────────────────
    /** Read the lockfile for a project. Returns null if not found. */
    readLockfile(projectPath) {
        this.ensureSchema();
        const rows = [...this.sql.exec(`SELECT name, resolved_ver, integrity, deps_json, hoisted_path
       FROM pkg_lockfile WHERE project_path = ?`, projectPath)];
        if (rows.length === 0)
            return null;
        const result = new Map();
        for (const r of rows) {
            result.set(String(r.name), {
                name: String(r.name),
                resolvedVer: String(r.resolved_ver),
                integrity: String(r.integrity),
                depsJson: String(r.deps_json),
                hoistedPath: String(r.hoisted_path),
            });
        }
        return result;
    }
    /** Write/overwrite the lockfile for a project. Atomic via transaction. */
    writeLockfile(projectPath, entries, ctx) {
        this.ensureSchema();
        const doTx = (fn) => {
            if (ctx?.storage?.transactionSync) {
                ctx.storage.transactionSync(fn);
            }
            else {
                fn();
            }
        };
        doTx(() => {
            // Clear existing lockfile for this project
            this.sql.exec(`DELETE FROM pkg_lockfile WHERE project_path = ?`, projectPath);
            // Batch insert: DO SQLite ~100 var limit. 6 cols → max 16 rows (16×6=96).
            const entryList = [...entries.values()];
            const BATCH = 16;
            for (let i = 0; i < entryList.length; i += BATCH) {
                const batch = entryList.slice(i, i + BATCH);
                const placeholders = batch.map(() => '(?,?,?,?,?,?)').join(',');
                const values = [];
                for (const e of batch) {
                    values.push(projectPath, e.name, e.resolvedVer, e.integrity, e.depsJson, e.hoistedPath);
                }
                this.sql.exec(`INSERT INTO pkg_lockfile (project_path, name, resolved_ver, integrity, deps_json, hoisted_path) VALUES ${placeholders}`, ...values);
            }
        });
    }
    /** Delete lockfile for a project (e.g., after package.json changes). */
    deleteLockfile(projectPath) {
        this.ensureSchema();
        this.sql.exec(`DELETE FROM pkg_lockfile WHERE project_path = ?`, projectPath);
    }
    // ── ESM bundles ───────────────────────────────────────────────────────
    /** Get a pre-bundled ESM module. */
    getEsmBundle(specifier) {
        this.ensureSchema();
        const rows = [...this.sql.exec(`SELECT specifier, bundle_hash, esm_code, built_at, input_hash
       FROM pkg_esm_bundles WHERE specifier = ?`, specifier)];
        if (rows.length === 0)
            return null;
        const r = rows[0];
        return {
            specifier: String(r.specifier),
            bundleHash: String(r.bundle_hash),
            esmCode: String(r.esm_code),
            builtAt: Number(r.built_at),
            inputHash: String(r.input_hash),
        };
    }
    /** Store a pre-bundled ESM module. */
    putEsmBundle(entry) {
        this.ensureSchema();
        this.sql.exec(`INSERT OR REPLACE INTO pkg_esm_bundles (specifier, bundle_hash, esm_code, built_at, input_hash)
       VALUES (?, ?, ?, ?, ?)`, entry.specifier, entry.bundleHash, entry.esmCode, entry.builtAt, entry.inputHash);
    }
    /** Delete a pre-bundled ESM module (e.g., after package update). */
    deleteEsmBundle(specifier) {
        this.ensureSchema();
        this.sql.exec(`DELETE FROM pkg_esm_bundles WHERE specifier = ?`, specifier);
    }
    /** Delete all ESM bundles (e.g., after full reinstall). */
    clearEsmBundles() {
        this.ensureSchema();
        this.sql.exec(`DELETE FROM pkg_esm_bundles`);
    }
    // ── Stats ─────────────────────────────────────────────────────────────
    getStats() {
        this.ensureSchema();
        const reg = [...this.sql.exec(`SELECT COUNT(*) as cnt FROM pkg_registry_cache`)];
        const pkgs = [...this.sql.exec(`SELECT COUNT(DISTINCT name || '@' || version) as cnt FROM pkg_tarball_cache`)];
        const files = [...this.sql.exec(`SELECT COUNT(*) as cnt FROM pkg_tarball_cache`)];
        const locks = [...this.sql.exec(`SELECT COUNT(DISTINCT project_path) as cnt FROM pkg_lockfile`)];
        const esm = [...this.sql.exec(`SELECT COUNT(*) as cnt FROM pkg_esm_bundles`)];
        return {
            registryEntries: Number(reg[0]?.cnt ?? 0),
            cachedPackages: Number(pkgs[0]?.cnt ?? 0),
            cachedFiles: Number(files[0]?.cnt ?? 0),
            lockfileProjects: Number(locks[0]?.cnt ?? 0),
            esmBundles: Number(esm[0]?.cnt ?? 0),
        };
    }
}
// ── Helpers ──────────────────────────────────────────────────────────────
function blobToUint8Array(blob) {
    if (blob instanceof Uint8Array)
        return blob;
    if (blob instanceof ArrayBuffer)
        return new Uint8Array(blob);
    if (ArrayBuffer.isView(blob)) {
        return new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
    }
    return new Uint8Array(0);
}
