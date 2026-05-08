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
 */

// ── Types ───────────────────────────────────────────────────────────────

export interface RegistryCacheEntry {
  name: string;
  version: string;
  tarballUrl: string;
  integrity: string;
  depsJson: string;       // JSON-encoded Record<string, string>
  /**
   * JSON-encoded REQUIRED peerDependencies (X.5-F R2).
   *
   * Optional peers — those marked `peerDependenciesMeta.<name>.optional
   * === true` in the source packument — are filtered out before this
   * field is written. Storing only the required subset means downstream
   * lockfile-validity checks can ask "is this peer in the tree?"
   * without having to consult the meta field again.
   *
   * Defaults to '{}' for entries written by pre-X.5-F builds (the
   * column was added via ALTER TABLE, see ensureSchema).
   */
  peerDepsJson?: string;
  exportsJson: string;    // JSON-encoded exports field
  main: string;
  moduleField: string;
  binJson: string;        // JSON-encoded bin field
  fetchedAt: number;
}

export interface TarballCacheFile {
  relPath: string;
  data: Uint8Array;
  size: number;
}

export interface LockfileEntry {
  name: string;
  resolvedVer: string;
  integrity: string;
  depsJson: string;
  hoistedPath: string;
}

export interface EsmBundleEntry {
  specifier: string;
  bundleHash: string;
  esmCode: string;
  builtAt: number;
  inputHash: string;
}

// ── NpmCache ────────────────────────────────────────────────────────────

export class NpmCache {
  private sql: SqlStorage;
  private initialized = false;

  constructor(sql: SqlStorage) {
    this.sql = sql;
  }

  // ── Schema ────────────────────────────────────────────────────────────

  ensureSchema(): void {
    if (this.initialized) return;

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
      hasPeerCol = cols.some((r) => String((r as any).name) === 'peer_deps_json');
    } catch { /* PRAGMA failed — fall through and ATTEMPT, swallow on error */ }
    if (!hasPeerCol) {
      try {
        this.sql.exec(`ALTER TABLE pkg_registry_cache ADD COLUMN peer_deps_json TEXT NOT NULL DEFAULT '{}'`);
      } catch (e: any) {
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
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_pkg_tarball_nv ON pkg_tarball_cache(name, version)`,
    );

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

  /** Get cached registry metadata for a specific name@version. */
  getRegistryEntry(name: string, version: string): RegistryCacheEntry | null {
    this.ensureSchema();
    const rows = [...this.sql.exec(
      `SELECT name, version, tarball_url, integrity, deps_json, peer_deps_json, exports_json, main, module_field, bin_json, fetched_at
       FROM pkg_registry_cache WHERE name = ? AND version = ?`,
      name, version,
    )];
    if (rows.length === 0) return null;
    const r = rows[0];
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
      fetchedAt: Number(r.fetched_at),
    };
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
  dumpRegistryEntries(maxRows: number): RegistryCacheEntry[] {
    this.ensureSchema();
    const rows = [...this.sql.exec(
      `SELECT name, version, tarball_url, integrity, deps_json, peer_deps_json, exports_json, main, module_field, bin_json, fetched_at
       FROM pkg_registry_cache ORDER BY fetched_at DESC LIMIT ?`,
      maxRows,
    )];
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
  getRegistryVersions(name: string): RegistryCacheEntry[] {
    this.ensureSchema();
    const rows = [...this.sql.exec(
      `SELECT name, version, tarball_url, integrity, deps_json, peer_deps_json, exports_json, main, module_field, bin_json, fetched_at
       FROM pkg_registry_cache WHERE name = ?`,
      name,
    )];
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
  putRegistryEntry(entry: RegistryCacheEntry): void {
    this.ensureSchema();
    this.sql.exec(
      `INSERT OR REPLACE INTO pkg_registry_cache
       (name, version, tarball_url, integrity, deps_json, peer_deps_json, exports_json, main, module_field, bin_json, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.name, entry.version, entry.tarballUrl, entry.integrity,
      entry.depsJson, entry.peerDepsJson || '{}',
      entry.exportsJson, entry.main, entry.moduleField,
      entry.binJson, entry.fetchedAt,
    );
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
  putRegistryEntries(entries: RegistryCacheEntry[]): { written: number; failed: number } {
    this.ensureSchema();
    let written = 0;
    let failed = 0;
    for (const entry of entries) {
      try {
        this.sql.exec(
          `INSERT OR REPLACE INTO pkg_registry_cache
           (name, version, tarball_url, integrity, deps_json, peer_deps_json, exports_json, main, module_field, bin_json, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          entry.name, entry.version, entry.tarballUrl, entry.integrity,
          entry.depsJson, entry.peerDepsJson || '{}',
          entry.exportsJson, entry.main, entry.moduleField,
          entry.binJson, entry.fetchedAt,
        );
        written++;
      } catch (e: any) {
        console.error(`[npm-cache] bulk putRegistryEntry failed for ${entry.name}@${entry.version}:`, e?.message);
        failed++;
      }
    }
    return { written, failed };
  }

  // ── Tarball cache ─────────────────────────────────────────────────────

  /** Check if a package version's files are cached. */
  hasTarballCache(name: string, version: string): boolean {
    this.ensureSchema();
    const rows = [...this.sql.exec(
      `SELECT 1 FROM pkg_tarball_cache WHERE name = ? AND version = ? LIMIT 1`,
      name, version,
    )];
    return rows.length > 0;
  }

  /** Get all cached files for a package version. */
  getTarballFiles(name: string, version: string): TarballCacheFile[] {
    this.ensureSchema();
    const rows = [...this.sql.exec(
      `SELECT rel_path, data, size FROM pkg_tarball_cache WHERE name = ? AND version = ?`,
      name, version,
    )];
    return rows.map(r => ({
      relPath: String(r.rel_path),
      data: blobToUint8Array(r.data),
      size: Number(r.size),
    }));
  }

  /** Max individual file size for tarball cache (DO SQLite blob limit). */
  static readonly MAX_CACHEABLE_FILE = 1_000_000; // 1MB
  /** Max total package size for tarball cache. */
  static readonly MAX_CACHEABLE_PACKAGE = 5_000_000; // 5MB

  /**
   * Store extracted tarball files for a package version.
   * Skips packages that exceed the SQLite blob size limit (SQLITE_TOOBIG).
   * Large packages (date-fns, lucide-react) will be re-fetched on reinstall.
   */
  putTarballFiles(
    name: string,
    version: string,
    files: Map<string, Uint8Array>,
    ctx?: DurableObjectState,
  ): void {
    this.ensureSchema();

    // Check total package size — skip caching if too large
    let totalSize = 0;
    for (const [, data] of files) totalSize += data.length;
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

    if (entries.length === 0) return;

    const doTx = (fn: () => void) => {
      if (ctx?.storage?.transactionSync) {
        ctx.storage.transactionSync(fn);
      } else {
        fn();
      }
    };

    doTx(() => {
      // Delete old entries for this package version (if re-caching)
      this.sql.exec(
        `DELETE FROM pkg_tarball_cache WHERE name = ? AND version = ?`,
        name, version,
      );

      // Batch insert: DO SQLite has a low bind-parameter limit (~100 vars).
      // 5 columns per row → max 19 rows per statement (19×5=95).
      const BATCH = 19;
      for (let i = 0; i < entries.length; i += BATCH) {
        const batch = entries.slice(i, i + BATCH);
        const placeholders = batch.map(() => '(?,?,?,?,?)').join(',');
        const values: any[] = [];
        for (const [relPath, data] of batch) {
          values.push(name, version, relPath, data, data.length);
        }
        this.sql.exec(
          `INSERT INTO pkg_tarball_cache (name, version, rel_path, data, size) VALUES ${placeholders}`,
          ...values,
        );
      }
    });
  }

  /** Count cached files for a package version. */
  getTarballFileCount(name: string, version: string): number {
    this.ensureSchema();
    const rows = [...this.sql.exec(
      `SELECT COUNT(*) as cnt FROM pkg_tarball_cache WHERE name = ? AND version = ?`,
      name, version,
    )];
    return rows.length > 0 ? Number(rows[0].cnt) : 0;
  }

  // ── Lockfile ──────────────────────────────────────────────────────────

  /** Read the lockfile for a project. Returns null if not found. */
  readLockfile(projectPath: string): Map<string, LockfileEntry> | null {
    this.ensureSchema();
    const rows = [...this.sql.exec(
      `SELECT name, resolved_ver, integrity, deps_json, hoisted_path
       FROM pkg_lockfile WHERE project_path = ?`,
      projectPath,
    )];
    if (rows.length === 0) return null;
    const result = new Map<string, LockfileEntry>();
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
  writeLockfile(
    projectPath: string,
    entries: Map<string, LockfileEntry>,
    ctx?: DurableObjectState,
  ): void {
    this.ensureSchema();
    const doTx = (fn: () => void) => {
      if (ctx?.storage?.transactionSync) {
        ctx.storage.transactionSync(fn);
      } else {
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
        const values: any[] = [];
        for (const e of batch) {
          values.push(
            projectPath, e.name, e.resolvedVer,
            e.integrity, e.depsJson, e.hoistedPath,
          );
        }
        this.sql.exec(
          `INSERT INTO pkg_lockfile (project_path, name, resolved_ver, integrity, deps_json, hoisted_path) VALUES ${placeholders}`,
          ...values,
        );
      }
    });
  }

  /** Delete lockfile for a project (e.g., after package.json changes). */
  deleteLockfile(projectPath: string): void {
    this.ensureSchema();
    this.sql.exec(`DELETE FROM pkg_lockfile WHERE project_path = ?`, projectPath);
  }

  // ── ESM bundles ───────────────────────────────────────────────────────

  /** Get a pre-bundled ESM module. */
  getEsmBundle(specifier: string): EsmBundleEntry | null {
    this.ensureSchema();
    const rows = [...this.sql.exec(
      `SELECT specifier, bundle_hash, esm_code, built_at, input_hash
       FROM pkg_esm_bundles WHERE specifier = ?`,
      specifier,
    )];
    if (rows.length === 0) return null;
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
  putEsmBundle(entry: EsmBundleEntry): void {
    this.ensureSchema();
    this.sql.exec(
      `INSERT OR REPLACE INTO pkg_esm_bundles (specifier, bundle_hash, esm_code, built_at, input_hash)
       VALUES (?, ?, ?, ?, ?)`,
      entry.specifier, entry.bundleHash, entry.esmCode,
      entry.builtAt, entry.inputHash,
    );
  }

  /** Delete a pre-bundled ESM module (e.g., after package update). */
  deleteEsmBundle(specifier: string): void {
    this.ensureSchema();
    this.sql.exec(`DELETE FROM pkg_esm_bundles WHERE specifier = ?`, specifier);
  }

  /** Delete all ESM bundles (e.g., after full reinstall). */
  clearEsmBundles(): void {
    this.ensureSchema();
    this.sql.exec(`DELETE FROM pkg_esm_bundles`);
  }

  // ── Stats ─────────────────────────────────────────────────────────────

  getStats(): {
    registryEntries: number;
    cachedPackages: number;
    cachedFiles: number;
    lockfileProjects: number;
    esmBundles: number;
  } {
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

function blobToUint8Array(blob: unknown): Uint8Array {
  if (blob instanceof Uint8Array) return blob;
  if (blob instanceof ArrayBuffer) return new Uint8Array(blob);
  if (ArrayBuffer.isView(blob)) {
    return new Uint8Array(
      (blob as ArrayBufferView).buffer,
      (blob as ArrayBufferView).byteOffset,
      (blob as ArrayBufferView).byteLength,
    );
  }
  return new Uint8Array(0);
}
