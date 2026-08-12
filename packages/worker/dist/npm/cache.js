/**
 * npm-cache.ts — SQLite-backed package cache for Nimbus npm v2.
 *
 * Four tables:
 *   1. pkg_registry_cache — packument metadata (avoids re-fetching full JSON)
 *   2. pkg_lockfile        — resolved dependency graph per project
 *   3. pkg_esm_bundles     — pre-bundled ESM for /@modules/ serving
 *   4. user_module_transforms — transformed user .ts/.tsx/.jsx output,
 *      keyed by content hash so it survives DO hibernation (the dev
 *      server's in-memory moduleCache does not) and never serves stale
 *      output after an unobserved write.
 *
 * All tables live in the same DO SQLite as the VFS. Schema is created lazily
 * on first use (not at VFS init, to avoid penalizing sessions that don't npm install).
 *
 * L1 cache observability (cache metrics support):
 *   getRegistryEntry bumps per-tier counters via src/_shared/cache-stats.ts.
 *   Hit = row(s) returned with size > 0; miss = empty result set. Callers
 *   fall through to L2/L3/L4 on miss.
 */
import { recordHit as _l1RecordHit, recordMiss as _l1RecordMiss } from '@nimbus-sh/core/_shared/cache-stats.js';
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
      platform_json  TEXT NOT NULL DEFAULT '{}',
      optional_deps_json TEXT NOT NULL DEFAULT '{}',
      fetched_at     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (name, version)
    )`);
        // Columns added after the original CREATE (peer_deps_json in
        // X.5-F R2; platform_json + optional_deps_json with the package ABI
        // policy work). Older tenants have a registry cache table without
        // them — ALTER TABLE adds each with the same NOT NULL DEFAULT '{}'
        // the CREATE specifies. SQLite errors on ADD COLUMN for an existing
        // column, so we probe via PRAGMA first.
        let existingCols = new Set();
        try {
            const cols = [...this.sql.exec(`PRAGMA table_info(pkg_registry_cache)`)];
            existingCols = new Set(cols.map((r) => String(r.name)));
        }
        catch { /* PRAGMA failed — fall through and ATTEMPT, swallow on error */ }
        for (const col of ['peer_deps_json', 'platform_json', 'optional_deps_json']) {
            if (existingCols.has(col))
                continue;
            try {
                this.sql.exec(`ALTER TABLE pkg_registry_cache ADD COLUMN ${col} TEXT NOT NULL DEFAULT '{}'`);
            }
            catch (e) {
                // Race or pre-existing — non-fatal; the column might already
                // exist if the CREATE just ran above on a fresh tenant.
                const msg = e?.message || String(e);
                if (!/duplicate column/i.test(msg)) {
                    console.error(`[npm-cache] ${col} migration failed:`, msg);
                }
            }
        }
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
        // A transform is keyed by (vfs_path, base): the served output bakes the
        // mount base, so one source served under two mounts is two rows. The
        // `base` column is part of the PRIMARY KEY, which SQLite cannot add via
        // ALTER. This is a regenerable cache, so a table predating the column is
        // dropped and recreated — the transforms rebuild on first request.
        let hasBaseColumn = true;
        try {
            const cols = [...this.sql.exec(`PRAGMA table_info(user_module_transforms)`)];
            if (cols.length > 0) {
                hasBaseColumn = cols.some((r) => String(r.name) === 'base');
            }
        }
        catch {
            hasBaseColumn = true; /* table absent — CREATE below handles it */
        }
        if (!hasBaseColumn) {
            try {
                this.sql.exec(`DROP TABLE user_module_transforms`);
            }
            catch { /* non-fatal */ }
        }
        this.sql.exec(`CREATE TABLE IF NOT EXISTS user_module_transforms (
      vfs_path        TEXT NOT NULL,
      base            TEXT NOT NULL DEFAULT '',
      content_hash    TEXT NOT NULL,
      bundler_version TEXT NOT NULL,
      code            TEXT NOT NULL,
      built_at        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (vfs_path, base)
    )`);
        this.initialized = true;
    }
    // ── Registry cache ────────────────────────────────────────────────────
    static REGISTRY_COLUMNS = 'name, version, tarball_url, integrity, deps_json, peer_deps_json, exports_json, main, module_field, bin_json, platform_json, optional_deps_json, fetched_at';
    rowToRegistryEntry(r) {
        return {
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
            platformJson: String(r.platform_json ?? '{}'),
            optionalDepsJson: String(r.optional_deps_json ?? '{}'),
            fetchedAt: Number(r.fetched_at),
        };
    }
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
        const rows = [...this.sql.exec(`SELECT ${NpmCache.REGISTRY_COLUMNS}
       FROM pkg_registry_cache WHERE name = ? AND version = ?`, name, version)];
        if (rows.length === 0) {
            _l1RecordMiss('L1', 'packument');
            return null;
        }
        const entry = this.rowToRegistryEntry(rows[0]);
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
        const rows = [...this.sql.exec(`SELECT ${NpmCache.REGISTRY_COLUMNS}
       FROM pkg_registry_cache ORDER BY fetched_at DESC LIMIT ?`, maxRows)];
        return rows.map((r) => this.rowToRegistryEntry(r));
    }
    /** Get all cached versions for a package name. */
    getRegistryVersions(name) {
        this.ensureSchema();
        const rows = [...this.sql.exec(`SELECT ${NpmCache.REGISTRY_COLUMNS}
       FROM pkg_registry_cache WHERE name = ?`, name)];
        return rows.map((r) => this.rowToRegistryEntry(r));
    }
    /** Store registry metadata for a resolved package version. */
    putRegistryEntry(entry) {
        this.ensureSchema();
        this.sql.exec(`INSERT OR REPLACE INTO pkg_registry_cache
       (${NpmCache.REGISTRY_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, entry.name, entry.version, entry.tarballUrl, entry.integrity, entry.depsJson, entry.peerDepsJson || '{}', entry.exportsJson, entry.main, entry.moduleField, entry.binJson, entry.platformJson || '{}', entry.optionalDepsJson || '{}', entry.fetchedAt);
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
           (${NpmCache.REGISTRY_COLUMNS})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, entry.name, entry.version, entry.tarballUrl, entry.integrity, entry.depsJson, entry.peerDepsJson || '{}', entry.exportsJson, entry.main, entry.moduleField, entry.binJson, entry.platformJson || '{}', entry.optionalDepsJson || '{}', entry.fetchedAt);
                written++;
            }
            catch (e) {
                console.error(`[npm-cache] bulk putRegistryEntry failed for ${entry.name}@${entry.version}:`, e?.message);
                failed++;
            }
        }
        return { written, failed };
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
    // ── User-module transforms ────────────────────────────────────────────
    /**
     * Read a persisted transform for a user module. Returns the entry only
     * when BOTH the content hash and bundler version still match the
     * caller's request — a hash/version mismatch is reported as a miss so
     * the caller re-transforms (the stale row is overwritten on the next
     * put). This makes the cache content-addressed: a source edit whose
     * VFS event the dev server missed still invalidates here, because the
     * content hash no longer matches.
     */
    getUserModuleTransform(vfsPath, base, contentHash, bundlerVersion) {
        this.ensureSchema();
        const rows = [...this.sql.exec(`SELECT vfs_path, base, content_hash, bundler_version, code, built_at
       FROM user_module_transforms WHERE vfs_path = ? AND base = ?`, vfsPath, base)];
        if (rows.length === 0)
            return null;
        const r = rows[0];
        if (String(r.content_hash) !== contentHash || String(r.bundler_version) !== bundlerVersion) {
            return null;
        }
        return {
            vfsPath: String(r.vfs_path),
            base: String(r.base),
            contentHash: String(r.content_hash),
            bundlerVersion: String(r.bundler_version),
            code: String(r.code),
            builtAt: Number(r.built_at),
        };
    }
    /** Persist a transformed user module (INSERT OR REPLACE on (vfs_path, base)). */
    putUserModuleTransform(entry) {
        this.ensureSchema();
        this.sql.exec(`INSERT OR REPLACE INTO user_module_transforms
       (vfs_path, base, content_hash, bundler_version, code, built_at)
       VALUES (?, ?, ?, ?, ?, ?)`, entry.vfsPath, entry.base, entry.contentHash, entry.bundlerVersion, entry.code, entry.builtAt);
    }
    /** Drop persisted transforms for a path across every mount base (e.g. when
     *  a file is deleted). */
    deleteUserModuleTransform(vfsPath) {
        this.ensureSchema();
        this.sql.exec(`DELETE FROM user_module_transforms WHERE vfs_path = ?`, vfsPath);
    }
    // ── Stats ─────────────────────────────────────────────────────────────
    getStats() {
        this.ensureSchema();
        const reg = [...this.sql.exec(`SELECT COUNT(*) as cnt FROM pkg_registry_cache`)];
        const locks = [...this.sql.exec(`SELECT COUNT(DISTINCT project_path) as cnt FROM pkg_lockfile`)];
        const esm = [...this.sql.exec(`SELECT COUNT(*) as cnt FROM pkg_esm_bundles`)];
        const xforms = [...this.sql.exec(`SELECT COUNT(*) as cnt FROM user_module_transforms`)];
        return {
            registryEntries: Number(reg[0]?.cnt ?? 0),
            lockfileProjects: Number(locks[0]?.cnt ?? 0),
            esmBundles: Number(esm[0]?.cnt ?? 0),
            userModuleTransforms: Number(xforms[0]?.cnt ?? 0),
        };
    }
}
