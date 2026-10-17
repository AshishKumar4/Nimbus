"use strict";
var __nimbusResidentModule = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/vfs/resident/index.ts
  var index_exports = {};
  __export(index_exports, {
    ANONYMOUS_DEV: () => ANONYMOUS_DEV,
    NS_DIR: () => NS_DIR,
    NS_FILE: () => NS_FILE,
    NS_LINK: () => NS_LINK,
    chmodRefusal: () => chmodRefusal,
    chownRefusal: () => chownRefusal,
    chownedMode: () => chownedMode,
    confinedModeRefusal: () => confinedModeRefusal,
    createResidentStore: () => createResidentStore,
    namespaceRowBytes: () => namespaceRowBytes,
    posixAccess: () => posixAccess,
    residentFileCost: () => residentFileCost,
    utimesRefusal: () => utimesRefusal
  });

  // ../platform/dist/limits.js
  var MAX_TX_BLOB_BYTES = 1 * 1024 * 1024;
  var SQLITE_MAX_STATEMENT_BYTES = 100 * 1024;
  var MAX_RPC_SAFE_PAYLOAD_BYTES = 28 * 1024 * 1024;
  var ONE_SHOT_MODULE_MAP_MAX_BYTES = 18 * 1024 * 1024;
  var SUPERVISOR_HEAP_CEILING_BYTES = 64 * 1024 * 1024;
  var FACET_OWN_WRITE_MEMORY_BYTES = 32 * 1024 * 1024;
  var WASI_RESIDENT_STORE_BYTES = 32 * 1024 * 1024;
  var RESIDENT_PAGE_BYTES = 64 * 1024;
  var RESIDENT_PAGE_CACHE_BYTES = 512 * 1024 * 1024;
  var RESIDENT_PAGE_CACHE_FREE_SHARE = 0.25;
  var SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES = 40 * 1024 * 1024;
  var SUPERVISOR_READ_RESERVE_BYTES = 1024 * 1024;
  var MAX_GLOBAL_WRITE_STREAM_CREDIT_BYTES = 8 * 1024 * 1024;

  // ../core/dist/runtime/storage-ledger.js
  var LEDGER_ROW_BYTES = 256;

  // ../platform/dist/utf8.js
  var LONG_UNITS = 256;
  var encoder = new TextEncoder();
  var scratch;
  function utf8Length(text) {
    if (text.length >= LONG_UNITS)
      return longUtf8Length(text);
    let bytes = text.length;
    for (let index = 0; index < text.length; index++) {
      const unit = text.charCodeAt(index);
      if (unit < 128)
        continue;
      if (unit < 2048) {
        bytes += 1;
      } else if (unit >= 55296 && unit <= 56319 && index + 1 < text.length) {
        const next = text.charCodeAt(index + 1);
        if (next >= 56320 && next <= 57343) {
          bytes += 2;
          index++;
        } else {
          bytes += 2;
        }
      } else {
        bytes += 2;
      }
    }
    return bytes;
  }
  function longUtf8Length(text) {
    scratch ??= new Uint8Array(256 * 1024);
    let bytes = 0;
    for (let read = 0; read < text.length; ) {
      const done = encoder.encodeInto(read === 0 ? text : text.slice(read), scratch);
      read += done.read;
      bytes += done.written;
    }
    return bytes;
  }

  // ../core/dist/constants.js
  var NODE_RELEASE = "22.22.3";
  var NODE_VERSION = `v${NODE_RELEASE}`;
  var VFS_CAPACITY = 10 * 1024 * 1024 * 1024;
  var FS_READ_BATCH_PATH_LIMIT = 1024;
  var FS_READ_BATCH_REQUEST_BYTES = 4 * 1024 * 1024;
  var FS_LIST_PAGE_LIMIT = 8192;
  var FS_LIST_TREE_MAX_ENTRIES = 2 * FS_LIST_PAGE_LIMIT;
  var VFS_DELIVERY_RETRY_WINDOW_MS = 5e3;
  var VFS_DELIVERY_RECEIPT_RETENTION_MS = 3 * VFS_DELIVERY_RETRY_WINDOW_MS;
  var VFS_DELIVERY_TOMBSTONE_RETENTION_MS = 10 * 6e4;
  var VFS_BUNDLE_MAX_BYTES = ONE_SHOT_MODULE_MAP_MAX_BYTES;
  var BUNDLE_MAX_ENCODED_BYTES = 22 * 1024 * 1024;
  var PREFETCH_CACHE_MAX_BYTES = 10 * 1024 * 1024;
  var TRANSFORM_STORE_MAX_BYTES = 64 * 1024 * 1024;
  var TRANSFORM_STORE_MAX_ENTRY_BYTES = TRANSFORM_STORE_MAX_BYTES / 8;
  var CWD_SNAPSHOT_MAX_FILE_BYTES = 2 * 1024 * 1024;
  var WASI_RESIDENT_FILE_CAP_BYTES = 8 * 1024 * 1024;
  var DEFAULT_HOME = "/home/user";
  function defaultPath(home) {
    return `/usr/local/bin:/usr/bin:/bin:${home}/.local/bin:${home}/.gem/bin`;
  }
  var DEFAULT_PATH = defaultPath(DEFAULT_HOME);
  var FACET_PROVIDED_PACKAGE_ENTRYPOINTS = Object.freeze({ undici: "index.js" });
  var FACET_PROVIDED_PACKAGES = Object.freeze(Object.keys(FACET_PROVIDED_PACKAGE_ENTRYPOINTS));

  // src/vfs/facet-resident-limits.ts
  var RESIDENT_CHUNK_BYTES = 1048576;
  var ONE_SHOT_STORE_MEMORY_BYTES = VFS_BUNDLE_MAX_BYTES + 16 * 1024 * 1024;

  // src/vfs/resident/cell-cost.ts
  var RESIDENT_ROW_BYTES = LEDGER_ROW_BYTES;
  function residentBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return new Uint8Array(0);
  }
  function residentCellCost(cell) {
    const isText = typeof cell === "string";
    const size = isText ? cell.length : residentBytes(cell).byteLength;
    const limit = isText ? Math.floor(RESIDENT_CHUNK_BYTES / 3) : RESIDENT_CHUNK_BYTES;
    const chunks = Math.max(1, Math.ceil(size / limit));
    return Math.ceil((isText ? utf8Length(cell) : size) * 1.01) + (chunks + 1) * RESIDENT_ROW_BYTES + 4096;
  }
  function residentFileCost(size) {
    const chunks = Math.max(1, Math.ceil(size / Math.floor(RESIDENT_CHUNK_BYTES / 3)));
    return Math.ceil(size * 1.01) + (chunks + 1) * RESIDENT_ROW_BYTES + 4096;
  }
  function namespaceRowBytes(parent, name, target) {
    return RESIDENT_ROW_BYTES + 2 * (String(parent).length + String(name).length + (target == null ? 0 : String(target).length));
  }

  // src/vfs/resident/admission.ts
  function createAdmission(coherence) {
    let cap = null;
    let facet = null;
    let supervisor = null;
    let grantAsk = null;
    let inHeap = false;
    let heldBytes = 0;
    let namespaceOverlayBytes = 0;
    let namespaceReserveBytes = 0;
    let pinnedBytes = 0;
    let available = null;
    const reservations = /* @__PURE__ */ new Map();
    let reservedBytes = 0;
    const reserveQueue = [];
    let reserveServing = false;
    const tablesBytes = () => coherence.tables("a storage measure").bytes();
    const dbBytes = () => tablesBytes() + (inHeap ? heldBytes + namespaceOverlayBytes + namespaceReserveBytes + pinnedBytes : 0);
    const refusal = (total) => inHeap && cap !== null && total > cap ? "namespace storage budget exceeded (" + cap + " bytes)" : null;
    const holdRoom = (path, bytes) => {
      if (dbBytes() + reservedBytes + bytes > cap) return false;
      release(path);
      reservations.set(path, bytes);
      reservedBytes += bytes;
      return true;
    };
    const serveReserves = async () => {
      if (reserveServing) return;
      reserveServing = true;
      try {
        for (let idle = 0; ; ) {
          const waiting = reserveQueue.length;
          while (reserveQueue.length > 0 && holdRoom(reserveQueue[0].path, reserveQueue[0].bytes)) {
            reserveQueue.shift().resolve(true);
          }
          if (reserveQueue.length === 0) return;
          idle = reserveQueue.length < waiting ? 0 : idle + 1;
          const before = cap;
          if (idle <= 8) {
            let need = 0;
            for (const reservation of reserveQueue) need += reservation.bytes;
            await askGrant(need);
          }
          if (cap === before) {
            for (const reservation of reserveQueue.splice(0)) reservation.resolve(false);
            return;
          }
        }
      } finally {
        reserveServing = false;
      }
    };
    const release = (path) => {
      const bytes = reservations.get(path);
      if (bytes === void 0) return;
      reservations.delete(path);
      reservedBytes -= bytes;
    };
    const askGrant = (bytes) => {
      const asked = supervisor;
      if (cap === null) return Promise.resolve(true);
      if (facet === null || !asked || typeof asked.fsStorageGrant !== "function") return Promise.resolve(false);
      if (grantAsk) {
        return grantAsk.then(() => dbBytes() + reservedBytes + bytes <= cap || askGrant(bytes));
      }
      const want = Math.max(0, dbBytes() + reservedBytes + bytes - cap);
      const named = facet;
      grantAsk = (async () => {
        try {
          const answer = await asked.fsStorageGrant(named, want, dbBytes());
          cap += Number(answer && answer.granted) || 0;
          if (answer && typeof answer.available === "number") available = answer.available;
        } catch {
        }
      })().finally(() => {
        grantAsk = null;
      });
      return grantAsk.then(() => dbBytes() + reservedBytes + bytes <= cap);
    };
    const fits = (bytes, ask = true) => {
      if (cap === null) return true;
      if (dbBytes() + reservedBytes + bytes <= cap) return true;
      if (ask) void askGrant(bytes);
      return false;
    };
    const ensureRoom = async (bytes) => {
      if (cap === null || dbBytes() + reservedBytes + bytes <= cap) return true;
      return askGrant(bytes);
    };
    return {
      get inHeap() {
        return inHeap;
      },
      get cap() {
        return cap;
      },
      dbBytes,
      bindHeap(budget) {
        inHeap = true;
        facet = null;
        cap = Number(budget);
        namespaceOverlayBytes = 0;
        namespaceReserveBytes = 0;
        pinnedBytes = 0;
      },
      setStorage(storage, given) {
        supervisor = given || null;
        const allowance = storage;
        available = allowance && typeof allowance.available === "number" ? allowance.available : null;
        if (!allowance || typeof allowance.facet !== "string" || typeof allowance.grant !== "number") return;
        facet = allowance.facet;
        cap = dbBytes() + allowance.grant;
      },
      storageCap() {
        return cap;
      },
      get available() {
        return available;
      },
      pin(bytes) {
        if (!inHeap || !fits(bytes, false)) return false;
        pinnedBytes += bytes;
        return true;
      },
      unpin(bytes) {
        pinnedBytes = Math.max(0, pinnedBytes - bytes);
      },
      get heldBytes() {
        return heldBytes;
      },
      addHeld(bytes) {
        heldBytes += bytes;
      },
      heldLimit(maxBytes) {
        return inHeap ? Math.max(0, Number(cap) - tablesBytes() - namespaceOverlayBytes - namespaceReserveBytes) : maxBytes;
      },
      namespaceRefusal(bytes) {
        return refusal(dbBytes() + bytes);
      },
      rowRefusal(growth) {
        return refusal(tablesBytes() + heldBytes + namespaceOverlayBytes + namespaceReserveBytes + growth);
      },
      addOverlay(bytes) {
        namespaceOverlayBytes += bytes;
      },
      reserveNamespace(bytes) {
        namespaceReserveBytes += bytes;
        return () => {
          namespaceReserveBytes -= bytes;
        };
      },
      /** Reserve room for a fill of `path` before its bytes arrive: true once it is held for it. */
      reserve(path, bytes) {
        release(path);
        if (cap === null) return Promise.resolve(true);
        if (reserveQueue.length === 0 && holdRoom(path, bytes)) return Promise.resolve(true);
        return new Promise((resolve) => {
          reserveQueue.push({ path, bytes, resolve });
          void serveReserves();
        });
      },
      release,
      fits,
      ensureRoom,
      /** Room for what an ACQUIRE answer pushes, asked for before it is applied. */
      async roomForPushed(result) {
        const answer = result;
        if (cap === null || !answer || !Array.isArray(answer.paths)) return;
        let bytes = 0;
        for (const entry of answer.paths) {
          if (entry && entry.bytes != null) bytes += residentCellCost(residentBytes(entry.bytes));
        }
        if (bytes > 0) await ensureRoom(bytes);
      },
      /** What the database measures, after a fill batch: the ledger settles to it, or records overshoot. */
      async reportSize() {
        const asked = supervisor;
        if (cap === null || facet === null || !asked || typeof asked.fsStorageGrant !== "function") return;
        try {
          const answer = await asked.fsStorageGrant(facet, 0, dbBytes());
          if (answer && typeof answer.available === "number") available = answer.available;
        } catch {
        }
      }
    };
  }

  // ../core/dist/vfs/posix-access.js
  function posixAccess(entry, want, cred) {
    const requested = want & 7;
    if (requested === 0)
      return true;
    const permissions = entry.mode & 511;
    if (cred.uid === 0)
      return (requested & 1) === 0 || (permissions & 73) !== 0 || entry.type === "directory";
    const shift = cred.uid === entry.uid ? 6 : cred.gid === entry.gid || cred.groups.includes(entry.gid) ? 3 : 0;
    return (permissions >> shift & requested) === requested;
  }
  function chmodRefusal(entry, cred) {
    return cred.uid !== 0 && cred.uid !== entry.uid ? "EPERM" : null;
  }
  function confinedModeRefusal(current, next) {
    const held = current & 4095;
    const granted = next & 3135 & ~held;
    const unstuck = held & ~next & 512;
    return granted === 0 && unstuck === 0 ? null : "EPERM";
  }
  function chownRefusal(entry, uid, gid, cred) {
    if (cred.uid === 0)
      return null;
    const owner = cred.uid === entry.uid;
    if (uid !== null && (uid !== entry.uid || !owner))
      return "EPERM";
    if (gid !== null && (!owner || gid !== entry.gid && !cred.groups.includes(gid)))
      return "EPERM";
    return null;
  }
  function chownedMode(mode, cred) {
    return cred.uid === 0 ? mode : mode & ~3072;
  }
  function utimesRefusal(entry, explicit, cred) {
    if (!explicit)
      return posixAccess(entry, 2, cred) ? null : "EACCES";
    return cred.uid !== 0 && cred.uid !== entry.uid ? "EPERM" : null;
  }

  // src/vfs/resident/permissions.ts
  var groupsOf = (cred) => Array.isArray(cred.groups) ? cred.groups.map(Number) : [];
  function namespaceAllows(cred, meta, type, want) {
    if (!cred) return true;
    return posixAccess(
      { mode: Number(meta?.mode), uid: Number(meta?.uid), gid: Number(meta?.gid), type },
      want,
      { uid: Number(cred.uid), gid: Number(cred.gid), groups: groupsOf(cred) }
    );
  }

  // src/vfs/resident/tables.ts
  var RESIDENT_SCHEMA = "4";
  var RK_TEXT = 0;
  var RK_BINARY = 1;
  var RK_DENIED = 2;
  var RK_OWN_WRITE = -1;
  var NS_FILE = 0;
  var NS_DIR = 1;
  var NS_LINK = 2;
  var num = (value) => Number(value);
  var rowOf = (rows) => {
    for (const row of rows) return row;
    return void 0;
  };
  var rowsOf = (rows) => [...rows];
  function sqlTables(sql) {
    let schema = null;
    for (const _row of sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")) schema = "";
    if (schema !== null) for (const row of sql.exec("SELECT v FROM meta WHERE k = 'schema'")) schema = String(row.v);
    if (schema !== RESIDENT_SCHEMA) {
      for (const table of ["chunk", "file", "ns", "meta", "page"]) sql.exec("DROP TABLE IF EXISTS " + table);
    }
    sql.exec(
      "CREATE TABLE IF NOT EXISTS file (path TEXT PRIMARY KEY, kind INTEGER NOT NULL, size INTEGER NOT NULL, chunks INTEGER NOT NULL, rev INTEGER NOT NULL CHECK (rev >= -1), ckey TEXT)"
    );
    sql.exec("CREATE INDEX IF NOT EXISTS file_ckey ON file (ckey) WHERE ckey IS NOT NULL");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS chunk (path TEXT NOT NULL, part INTEGER NOT NULL, txt TEXT, bin BLOB, PRIMARY KEY (path, part))"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS page (path TEXT NOT NULL, rev INTEGER NOT NULL, part INTEGER NOT NULL, bin BLOB NOT NULL, used INTEGER NOT NULL, PRIMARY KEY (path, rev, part)) WITHOUT ROWID"
    );
    sql.exec("CREATE INDEX IF NOT EXISTS page_used ON page (used)");
    sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', ?)", RESIDENT_SCHEMA);
    sql.exec(
      "CREATE TABLE IF NOT EXISTS ns (parent TEXT NOT NULL, name TEXT NOT NULL, kind INTEGER NOT NULL, size INTEGER NOT NULL, mode INTEGER NOT NULL, uid INTEGER NOT NULL, gid INTEGER NOT NULL, atime REAL NOT NULL, mtime REAL NOT NULL, ctime REAL NOT NULL, ino INTEGER NOT NULL, rev INTEGER NOT NULL, target TEXT, dev INTEGER NOT NULL DEFAULT 0, nlink INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (parent, name)) WITHOUT ROWID"
    );
    const first = (rows) => {
      for (const row of rows) return row;
      return void 0;
    };
    const ranged = (select, from, to, tail = "") => to === null ? sql.exec(select + " WHERE path >= ?" + tail, from) : sql.exec(select + " WHERE path >= ? AND path < ?" + tail, from, to);
    return {
      bytes() {
        const size = sql.databaseSize;
        if (typeof size === "number" && size > 0) return size;
        for (const row of sql.exec("SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()")) return num(row.n);
        return 0;
      },
      databaseSize() {
        return num(sql.databaseSize ?? 0);
      },
      metaGet(k) {
        const row = first(sql.exec("SELECT v FROM meta WHERE k = ?", k));
        return row === void 0 ? void 0 : String(row.v);
      },
      metaSet(k, v) {
        sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", k, v);
      },
      fileHead(path) {
        return rowOf(sql.exec("SELECT kind, size, chunks FROM file WHERE path = ?", path));
      },
      fileRev(path) {
        const row = first(sql.exec("SELECT rev FROM file WHERE path = ?", path));
        return row === void 0 ? void 0 : num(row.rev);
      },
      fileRevKey(path) {
        return rowOf(sql.exec("SELECT rev, ckey FROM file WHERE path = ?", path));
      },
      fileOwnSize(path) {
        const row = first(sql.exec("SELECT size FROM file WHERE path = ? AND rev = ?", path, RK_OWN_WRITE));
        return row === void 0 ? void 0 : num(row.size);
      },
      filePut(path, kind, size, chunks, rev, ckey) {
        sql.exec("INSERT OR REPLACE INTO file (path, kind, size, chunks, rev, ckey) VALUES (?, ?, ?, ?, ?, ?)", path, kind, size, chunks, rev, ckey);
      },
      fileSetRev(path, rev) {
        sql.exec("UPDATE file SET rev = ? WHERE path = ?", rev, path);
      },
      fileStampOwn(path, rev) {
        sql.exec("UPDATE file SET rev = ? WHERE path = ? AND rev = ?", rev, path, RK_OWN_WRITE);
      },
      fileDelete(path) {
        sql.exec("DELETE FROM file WHERE path = ?", path);
      },
      fileByKey(ckey, notPath) {
        return rowOf(sql.exec("SELECT path, kind, size, chunks FROM file WHERE ckey = ? AND rev >= 0 AND path <> ? LIMIT 1", ckey, notPath));
      },
      filePaths(from, to) {
        return [...ranged("SELECT path FROM file", from, to)].map((row) => String(row.path));
      },
      fileAny(from, to) {
        return first(ranged("SELECT path FROM file", from, to, " LIMIT 1")) !== void 0;
      },
      fileRevsIn(from, to) {
        return rowsOf(ranged("SELECT path, rev FROM file", from, to));
      },
      // In key order, as every other scan here is: the primary key's index
      // serves it, and both backings then answer in one order.
      fileAllPaths() {
        return [...sql.exec("SELECT path FROM file ORDER BY path")].map((row) => String(row.path));
      },
      fileRows() {
        return rowsOf(sql.exec("SELECT path, rev, ckey FROM file ORDER BY path"));
      },
      fileOwnPaths() {
        return [...sql.exec("SELECT path FROM file WHERE rev = ? ORDER BY path", RK_OWN_WRITE)].map((row) => String(row.path));
      },
      fileStats() {
        return rowOf(sql.exec("SELECT count(*) AS n, coalesce(sum(size), 0) AS b FROM file"));
      },
      chunkFirst(path) {
        return rowOf(sql.exec("SELECT txt, bin FROM chunk WHERE path = ? AND part = 0", path));
      },
      chunkParts(path) {
        return rowsOf(sql.exec("SELECT txt, bin FROM chunk WHERE path = ? ORDER BY part", path));
      },
      chunkAddText(path, part, txt) {
        sql.exec("INSERT INTO chunk (path, part, txt) VALUES (?, ?, ?)", path, part, txt);
      },
      chunkAddBin(path, part, bin) {
        sql.exec("INSERT INTO chunk (path, part, bin) VALUES (?, ?, ?)", path, part, bin);
      },
      chunkSetBin(path, part, bin) {
        sql.exec("INSERT OR REPLACE INTO chunk (path, part, bin) VALUES (?, ?, ?)", path, part, bin);
      },
      chunkCopy(to, from) {
        sql.exec("INSERT INTO chunk (path, part, txt, bin) SELECT ?, part, txt, bin FROM chunk WHERE path = ?", to, from);
      },
      chunkDelete(path) {
        sql.exec("DELETE FROM chunk WHERE path = ?", path);
      },
      dropOwn() {
        sql.exec("DELETE FROM chunk WHERE path IN (SELECT path FROM file WHERE rev = ?)", RK_OWN_WRITE);
        sql.exec("DELETE FROM file WHERE rev = ?", RK_OWN_WRITE);
      },
      dropDated() {
        sql.exec("DELETE FROM chunk WHERE path NOT IN (SELECT path FROM file WHERE rev = ?)", RK_OWN_WRITE);
        sql.exec("DELETE FROM file WHERE rev <> ?", RK_OWN_WRITE);
      },
      dropDatedFiles() {
        sql.exec("DELETE FROM chunk WHERE path IN (SELECT path FROM file WHERE rev <> ?)", RK_OWN_WRITE);
        sql.exec("DELETE FROM file WHERE rev <> ?", RK_OWN_WRITE);
      },
      clear() {
        sql.exec("DELETE FROM chunk");
        sql.exec("DELETE FROM file");
        sql.exec("DELETE FROM ns");
        sql.exec("DELETE FROM meta WHERE k <> 'schema'");
        sql.exec("DELETE FROM page");
      },
      pageGet(path, rev, part) {
        return rowOf(sql.exec("SELECT bin FROM page WHERE path = ? AND rev = ? AND part = ?", path, rev, part))?.bin;
      },
      pageUse(path, rev, part, used) {
        sql.exec("UPDATE page SET used = ? WHERE path = ? AND rev = ? AND part = ?", used, path, rev, part);
      },
      pagePut(path, rev, part, bin, used) {
        const had = first(sql.exec("SELECT length(bin) AS n FROM page WHERE path = ? AND rev = ? AND part = ?", path, rev, part));
        sql.exec("INSERT OR REPLACE INTO page (path, rev, part, bin, used) VALUES (?, ?, ?, ?, ?)", path, rev, part, bin, used);
        return had === void 0 ? 0 : num(had.n);
      },
      pageDelete(path, rev, part) {
        sql.exec("DELETE FROM page WHERE path = ? AND rev = ? AND part = ?", path, rev, part);
      },
      pageOldest(limit) {
        return rowsOf(sql.exec("SELECT path, rev, part, length(bin) AS size FROM page ORDER BY used, path, rev, part LIMIT ?", limit));
      },
      pageBytes() {
        const row = first(sql.exec("SELECT coalesce(sum(length(bin)), 0) AS n FROM page"));
        return row === void 0 ? 0 : num(row.n);
      },
      pageMaxUsed() {
        const row = first(sql.exec("SELECT coalesce(max(used), 0) AS n FROM page"));
        return row === void 0 ? 0 : num(row.n);
      },
      nsPut(parent, name, kind, size, mode, uid, gid, atime, mtime, ctime, ino, rev, target, dev, nlink) {
        sql.exec(
          "INSERT OR REPLACE INTO ns (parent, name, kind, size, mode, uid, gid, atime, mtime, ctime, ino, rev, target, dev, nlink) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          parent,
          name,
          kind,
          size,
          mode,
          uid,
          gid,
          atime,
          mtime,
          ctime,
          ino,
          rev,
          target,
          Number(dev) || 0,
          Number(nlink) || 1
        );
      },
      nsGet(parent, name) {
        return rowOf(sql.exec(
          "SELECT kind, size, mode, uid, gid, atime, mtime, ctime, ino, rev, target, dev, nlink FROM ns WHERE parent = ? AND name = ?",
          parent,
          name
        ));
      },
      nsDelete(parent, name) {
        sql.exec("DELETE FROM ns WHERE parent = ? AND name = ?", parent, name);
      },
      nsDeleteChildren(parent) {
        sql.exec("DELETE FROM ns WHERE parent = ?", parent);
      },
      nsDeleteParents(from, to) {
        if (to === null) sql.exec("DELETE FROM ns WHERE parent >= ?", from);
        else sql.exec("DELETE FROM ns WHERE parent >= ? AND parent < ?", from, to);
      },
      nsClear() {
        sql.exec("DELETE FROM ns");
      },
      nsKeys() {
        return rowsOf(sql.exec("SELECT parent, name FROM ns"));
      },
      nsOfKind(kind) {
        return rowsOf(sql.exec("SELECT parent, name FROM ns WHERE kind = ?", kind));
      },
      nsUnlisted() {
        return rowsOf(sql.exec("SELECT parent, name, target FROM ns WHERE kind = ? AND target IS NOT NULL", NS_DIR));
      },
      nsChildren(parent) {
        return rowsOf(sql.exec("SELECT name, kind, mode FROM ns WHERE parent = ?", parent));
      },
      nsCount() {
        const row = first(sql.exec("SELECT count(*) AS n FROM ns"));
        return row === void 0 ? 0 : num(row.n);
      }
    };
  }
  function heapTables() {
    const files = /* @__PURE__ */ new Map();
    const chunks = /* @__PURE__ */ new Map();
    const meta = /* @__PURE__ */ new Map();
    const ns = /* @__PURE__ */ new Map();
    const byKey = /* @__PURE__ */ new Map();
    const pages = /* @__PURE__ */ new Map();
    const pageKey = (path, rev, part) => path + "\0" + rev + "\0" + part;
    let sorted = null;
    let used = 0;
    let names = 0;
    let namespaceBytes = 0;
    const cmp = (a, b) => {
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) {
        const x = a.codePointAt(i), y = b.codePointAt(i);
        if (x !== y) return x < y ? -1 : 1;
        if (x > 65535) i++;
      }
      return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
    };
    const payload = (cell) => cell.txt != null ? utf8Length(cell.txt) : cell.bin ? cell.bin.byteLength : 0;
    const unkey = (path, row) => {
      if (row && row.ckey != null) {
        const set = byKey.get(row.ckey);
        if (set) {
          set.delete(path);
          if (set.size === 0) byKey.delete(row.ckey);
        }
      }
    };
    const paths = () => {
      if (sorted === null) sorted = [...files.keys()].sort(cmp);
      return sorted;
    };
    const lowerBound = (list, from) => {
      let lo = 0, hi = list.length;
      while (lo < hi) {
        const mid = lo + hi >>> 1;
        if (cmp(list[mid], from) < 0) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const inRange = (from, to) => {
      const list = paths();
      const out = [];
      for (let i = lowerBound(list, from); i < list.length && (to === null || cmp(list[i], to) < 0); i++) out.push(list[i]);
      return out;
    };
    const copy = (cell) => ({ txt: cell.txt ?? null, bin: cell.bin ? cell.bin.slice() : null });
    const owned = (bin) => {
      const bytes = residentBytes(bin);
      return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
    };
    const dropChunks = (path) => {
      const parts = chunks.get(path);
      if (!parts) return;
      for (const cell of parts.values()) used -= RESIDENT_ROW_BYTES + payload(cell);
      chunks.delete(path);
    };
    const dropFile = (path) => {
      const row = files.get(path);
      if (row === void 0) return;
      unkey(path, row);
      files.delete(path);
      sorted = null;
      used -= RESIDENT_ROW_BYTES;
    };
    const addChunk = (path, part, cell, replace) => {
      let parts = chunks.get(path);
      if (!parts) {
        parts = /* @__PURE__ */ new Map();
        chunks.set(path, parts);
      }
      const had = parts.get(part);
      if (had !== void 0) {
        if (!replace) throw new Error("UNIQUE constraint failed: chunk.path, chunk.part");
        used -= RESIDENT_ROW_BYTES + payload(had);
      }
      parts.set(part, cell);
      used += RESIDENT_ROW_BYTES + payload(cell);
    };
    const nsGetRow = (parent, name) => {
      const dir = ns.get(parent);
      return dir ? dir.get(name) : void 0;
    };
    const nsDrop = (parent, name) => {
      const dir = ns.get(parent);
      const row = dir?.get(name);
      if (dir === void 0 || row === void 0) return;
      dir.delete(name);
      names--;
      const bytes = namespaceRowBytes(parent, name, row.target);
      used -= bytes;
      namespaceBytes -= bytes;
      if (dir.size === 0) ns.delete(parent);
    };
    const nsDropParent = (parent) => {
      const dir = ns.get(parent);
      if (!dir) return;
      names -= dir.size;
      for (const [name, row] of dir) {
        const bytes = namespaceRowBytes(parent, name, row.target);
        used -= bytes;
        namespaceBytes -= bytes;
      }
      ns.delete(parent);
    };
    const dropWhere = (keepFile, keepChunkPath) => {
      for (const path of [...chunks.keys()]) if (!keepChunkPath(path)) dropChunks(path);
      for (const [path, row] of [...files]) if (!keepFile(row)) dropFile(path);
    };
    const sortedNames = (dir) => [...dir.keys()].sort(cmp);
    return {
      bytes() {
        return used;
      },
      databaseSize() {
        return used;
      },
      metaGet(k) {
        return meta.get(k);
      },
      metaSet(k, v) {
        meta.set(k, String(v));
      },
      fileHead(path) {
        const row = files.get(path);
        return row === void 0 ? void 0 : { kind: row.kind, size: row.size, chunks: row.chunks };
      },
      fileRev(path) {
        const row = files.get(path);
        return row === void 0 ? void 0 : row.rev;
      },
      fileRevKey(path) {
        const row = files.get(path);
        return row === void 0 ? void 0 : { rev: row.rev, ckey: row.ckey };
      },
      fileOwnSize(path) {
        const row = files.get(path);
        return row !== void 0 && row.rev === RK_OWN_WRITE ? row.size : void 0;
      },
      filePut(path, kind, size, chunkCount, rev, ckey) {
        if (!(rev >= -1)) throw new Error("CHECK constraint failed: rev >= -1");
        const had = files.get(path);
        if (had === void 0) {
          sorted = null;
          used += RESIDENT_ROW_BYTES;
        } else unkey(path, had);
        const row = { kind: Number(kind), size: Number(size), chunks: Number(chunkCount), rev: Number(rev), ckey: ckey == null ? null : String(ckey) };
        files.set(path, row);
        if (row.ckey !== null) {
          let set = byKey.get(row.ckey);
          if (!set) {
            set = /* @__PURE__ */ new Set();
            byKey.set(row.ckey, set);
          }
          set.add(path);
        }
      },
      fileSetRev(path, rev) {
        const row = files.get(path);
        if (row !== void 0) row.rev = Number(rev);
      },
      fileStampOwn(path, rev) {
        const row = files.get(path);
        if (row !== void 0 && row.rev === RK_OWN_WRITE) row.rev = Number(rev);
      },
      fileDelete(path) {
        dropFile(path);
      },
      fileByKey(ckey, notPath) {
        const set = byKey.get(String(ckey));
        if (!set) return void 0;
        for (const path of set) {
          const row = files.get(path);
          if (path !== notPath && row && row.rev >= 0) return { path, kind: row.kind, size: row.size, chunks: row.chunks };
        }
        return void 0;
      },
      filePaths(from, to) {
        return inRange(from, to);
      },
      fileAny(from, to) {
        const list = paths();
        const i = lowerBound(list, from);
        return i < list.length && (to === null || cmp(list[i], to) < 0);
      },
      fileRevsIn(from, to) {
        return inRange(from, to).map((path) => ({ path, rev: files.get(path).rev }));
      },
      fileAllPaths() {
        return [...paths()];
      },
      fileRows() {
        return paths().map((path) => {
          const row = files.get(path);
          return { path, rev: row.rev, ckey: row.ckey };
        });
      },
      fileOwnPaths() {
        return paths().filter((path) => files.get(path).rev === RK_OWN_WRITE);
      },
      fileStats() {
        let b = 0;
        for (const row of files.values()) b += row.size;
        return { n: files.size, b };
      },
      chunkFirst(path) {
        const parts = chunks.get(path);
        const cell = parts && parts.get(0);
        return cell === void 0 ? void 0 : copy(cell);
      },
      chunkParts(path) {
        const parts = chunks.get(path);
        if (!parts) return [];
        return [...parts.keys()].sort((a, b) => a - b).map((part) => copy(parts.get(part)));
      },
      chunkAddText(path, part, txt) {
        addChunk(path, Number(part), { txt: String(txt), bin: null }, false);
      },
      chunkAddBin(path, part, bin) {
        addChunk(path, Number(part), { txt: null, bin: owned(bin) }, false);
      },
      chunkSetBin(path, part, bin) {
        addChunk(path, Number(part), { txt: null, bin: owned(bin) }, true);
      },
      chunkCopy(to, from) {
        const parts = chunks.get(from);
        if (!parts) return;
        const held = chunks.get(to);
        if (held) {
          for (const part of parts.keys()) if (held.has(part)) throw new Error("UNIQUE constraint failed: chunk.path, chunk.part");
        }
        for (const [part, cell] of [...parts]) addChunk(to, part, { txt: cell.txt, bin: cell.bin }, false);
      },
      chunkDelete(path) {
        dropChunks(path);
      },
      dropOwn() {
        const own = new Set(paths().filter((path) => files.get(path).rev === RK_OWN_WRITE));
        dropWhere((row) => row.rev !== RK_OWN_WRITE, (path) => !own.has(path));
      },
      dropDated() {
        const own = new Set(paths().filter((path) => files.get(path).rev === RK_OWN_WRITE));
        dropWhere((row) => row.rev === RK_OWN_WRITE, (path) => own.has(path));
      },
      dropDatedFiles() {
        const dated = new Set(paths().filter((path) => files.get(path).rev !== RK_OWN_WRITE));
        dropWhere((row) => row.rev === RK_OWN_WRITE, (path) => !dated.has(path));
      },
      clear() {
        files.clear();
        chunks.clear();
        meta.clear();
        ns.clear();
        byKey.clear();
        pages.clear();
        sorted = null;
        used = 0;
        names = 0;
        namespaceBytes = 0;
      },
      pageGet(path, rev, part) {
        return pages.get(pageKey(path, rev, part))?.bin.slice();
      },
      pageUse(path, rev, part, stamp) {
        const row = pages.get(pageKey(path, rev, part));
        if (row !== void 0) row.used = stamp;
      },
      pagePut(path, rev, part, bin, stamp) {
        const key = pageKey(path, rev, part);
        const had = pages.get(key);
        const bytes = residentBytes(bin).slice();
        if (had !== void 0) used -= RESIDENT_ROW_BYTES + had.bin.byteLength;
        pages.set(key, { path, rev, part, bin: bytes, used: stamp });
        used += RESIDENT_ROW_BYTES + bytes.byteLength;
        return had === void 0 ? 0 : had.bin.byteLength;
      },
      pageDelete(path, rev, part) {
        const key = pageKey(path, rev, part);
        const had = pages.get(key);
        if (had === void 0) return;
        pages.delete(key);
        used -= RESIDENT_ROW_BYTES + had.bin.byteLength;
      },
      pageOldest(limit) {
        const rows = [...pages.values()].sort((a, b) => a.used - b.used || cmp(a.path, b.path) || a.rev - b.rev || a.part - b.part);
        return rows.slice(0, limit).map((row) => ({ path: row.path, rev: row.rev, part: row.part, size: row.bin.byteLength }));
      },
      pageBytes() {
        let n = 0;
        for (const row of pages.values()) n += row.bin.byteLength;
        return n;
      },
      pageMaxUsed() {
        let n = 0;
        for (const row of pages.values()) n = Math.max(n, row.used);
        return n;
      },
      nsPut(parent, name, kind, size, mode, uid, gid, atime, mtime, ctime, ino, rev, target, dev, nlink) {
        let dir = ns.get(parent);
        const previous = dir?.get(name);
        const bytes = namespaceRowBytes(parent, name, target);
        const growth = bytes - (previous === void 0 ? 0 : namespaceRowBytes(parent, name, previous.target));
        if (!dir) {
          dir = /* @__PURE__ */ new Map();
          ns.set(parent, dir);
        }
        if (previous === void 0) names++;
        used += growth;
        namespaceBytes += growth;
        dir.set(name, {
          kind: Number(kind),
          size: Number(size),
          mode: Number(mode),
          uid: Number(uid),
          gid: Number(gid),
          atime: Number(atime),
          mtime: Number(mtime),
          ctime: Number(ctime),
          ino: Number(ino),
          rev: Number(rev),
          target: target == null ? null : String(target),
          dev: Number(dev) || 0,
          nlink: Number(nlink) || 1
        });
      },
      nsGet(parent, name) {
        const row = nsGetRow(parent, name);
        return row === void 0 ? void 0 : { ...row };
      },
      nsDelete(parent, name) {
        nsDrop(parent, name);
      },
      nsDeleteChildren(parent) {
        nsDropParent(parent);
      },
      nsDeleteParents(from, to) {
        for (const parent of [...ns.keys()]) if (cmp(parent, from) >= 0 && (to === null || cmp(parent, to) < 0)) nsDropParent(parent);
      },
      nsClear() {
        used -= namespaceBytes;
        names = 0;
        namespaceBytes = 0;
        ns.clear();
      },
      nsBytes() {
        return namespaceBytes;
      },
      nsGrowth(parent, name, target) {
        const previous = nsGetRow(parent, name);
        return namespaceRowBytes(parent, name, target) - (previous === void 0 ? 0 : namespaceRowBytes(parent, name, previous.target));
      },
      nsKeys() {
        const out = [];
        for (const parent of [...ns.keys()].sort(cmp)) for (const name of sortedNames(ns.get(parent))) out.push({ parent, name });
        return out;
      },
      nsOfKind(kind) {
        const out = [];
        for (const parent of [...ns.keys()].sort(cmp)) {
          const dir = ns.get(parent);
          for (const name of sortedNames(dir)) if (dir.get(name).kind === Number(kind)) out.push({ parent, name });
        }
        return out;
      },
      nsUnlisted() {
        const out = [];
        for (const parent of [...ns.keys()].sort(cmp)) {
          const dir = ns.get(parent);
          for (const name of sortedNames(dir)) {
            const row = dir.get(name);
            if (row.kind === NS_DIR && row.target !== null) out.push({ parent, name, target: row.target });
          }
        }
        return out;
      },
      nsChildren(parent) {
        const dir = ns.get(parent);
        if (!dir) return [];
        return sortedNames(dir).map((name) => ({ name, kind: dir.get(name).kind, mode: dir.get(name).mode }));
      },
      nsCount() {
        return names;
      }
    };
  }

  // src/vfs/resident/namespace.ts
  var NS_MAX_HOPS = 40;
  function nsSplit(k) {
    const i = k.lastIndexOf("/");
    return i < 0 ? ["", k] : [k.slice(0, i), k.slice(i + 1)];
  }
  function nsKindCode(type) {
    return type === "directory" ? NS_DIR : type === "symlink" ? NS_LINK : NS_FILE;
  }
  function nsKey(path) {
    return String(path).replace(/^\/+/, "");
  }
  function nsDescribes(stat) {
    const described = stat;
    if (!described || typeof described.type !== "string") return false;
    for (const field of ["mode", "uid", "gid"]) {
      if (described[field] === null || described[field] === void 0 || !Number.isInteger(Number(described[field]))) return false;
    }
    return true;
  }
  function prefixEnd(prefix) {
    for (let i = prefix.length - 1; i >= 0; i--) {
      const code = prefix.charCodeAt(i);
      if (code < 65535) return prefix.slice(0, i) + String.fromCharCode(code + 1);
    }
    return null;
  }
  function nsRowAt(t, k) {
    if (k === "") {
      return { kind: NS_DIR, size: 0, mode: 16877, uid: 0, gid: 0, atime: 0, mtime: 0, ctime: 0, ino: 1, rev: 0, target: null, dev: 0, nlink: 1 };
    }
    const [parent, name] = nsSplit(k);
    return t.nsGet(parent, name);
  }
  function joinTarget(linkPath, target) {
    const text = String(target);
    const parts = text.startsWith("/") ? [] : nsSplit(linkPath)[0].split("/").filter(Boolean);
    for (const seg of text.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    return parts.join("/");
  }
  function createNamespace(coherence, admission) {
    const realNow = Date.now;
    let links = /* @__PURE__ */ new Set();
    let unlisted = /* @__PURE__ */ new Map();
    let cred = null;
    let ok = false;
    let cause = "the process has not listed it yet";
    let lazy = false;
    const listed = /* @__PURE__ */ new Set();
    const ready = () => ok && coherence.serving();
    const markReady = (t, isReady, why) => {
      t.metaSet("ns", isReady ? "1" : "0");
      ok = !!isReady;
      if (!isReady) cause = String(why || "a change it could not follow");
    };
    const refuse = (t, why) => {
      markReady(t, false, why);
      throw Object.assign(new Error(why), { code: "ENOSPC" });
    };
    const unlistedOver = (k, self) => {
      if (unlisted.size === 0) return null;
      const t = coherence.require();
      for (let at = self ? k : nsSplit(k)[0]; at !== ""; at = nsSplit(at)[0]) {
        const mount = unlisted.get(at);
        if (mount !== void 0) return mount;
        const row = nsRowAt(t, at);
        if (row && row.kind === NS_DIR) return null;
      }
      return null;
    };
    const put = (t, k, stat, rev, target, unlistedAt) => {
      const [parent, name] = nsSplit(k);
      const kind = nsKindCode(stat.type);
      const mount = kind !== NS_DIR ? null : unlistedAt === void 0 ? unlisted.get(k) ?? null : unlistedAt;
      const stored = kind === NS_LINK ? String(target ?? "") : mount;
      const heap = coherence.heap;
      if (heap !== null && admission.inHeap) {
        const refused = admission.rowRefusal(heap.nsGrowth(parent, name, stored));
        if (refused !== null) refuse(t, refused);
      }
      t.nsPut(
        parent,
        name,
        kind,
        Number(stat.size) || 0,
        Number(stat.mode) || 0,
        Number(stat.uid) || 0,
        Number(stat.gid) || 0,
        Number(stat.atime) || 0,
        Number(stat.mtime) || 0,
        Number(stat.ctime) || 0,
        Number(stat.ino) || 0,
        Number(rev) || 0,
        stored,
        Number(stat.dev) || 0,
        Number(stat.nlink) || 1
      );
      if (kind === NS_LINK) links.add(k);
      else links.delete(k);
      if (mount !== null) unlisted.set(k, mount);
      else unlisted.delete(k);
    };
    const tryPut = (t, k, stat, rev, target, unlistedAt) => {
      try {
        put(t, k, stat, rev, target, unlistedAt);
        return true;
      } catch (error) {
        if (admission.inHeap && error?.code === "ENOSPC") return false;
        throw error;
      }
    };
    const forgetListed = (dir) => {
      const prefix = dir === "" ? "" : dir + "/";
      for (const done of [...listed]) if (done === dir || done.startsWith(prefix)) listed.delete(done);
    };
    const deleteTree = (t, k, self) => {
      if (lazy) forgetListed(k);
      if (k === "") {
        t.nsClear();
        links = /* @__PURE__ */ new Set();
        unlisted = /* @__PURE__ */ new Map();
        return;
      }
      const prefix = k + "/";
      const end = prefixEnd(prefix);
      t.nsDeleteChildren(k);
      t.nsDeleteParents(prefix, end);
      if (self) {
        const [parent, name] = nsSplit(k);
        t.nsDelete(parent, name);
        links.delete(k);
        unlisted.delete(k);
      }
      for (const link of links) if (link.startsWith(prefix)) links.delete(link);
      for (const dir of unlisted.keys()) if (dir.startsWith(prefix)) unlisted.delete(dir);
    };
    const forget = (t, k) => {
      const [parent, name] = nsSplit(k);
      t.nsDelete(parent, name);
      links.delete(k);
      unlisted.delete(k);
    };
    function lookup(k, followLeaf, own, visit) {
      const t = coherence.require();
      if (own === void 0 && links.size === 0 && visit === void 0) return { path: k, table: k, row: nsRowAt(t, k) };
      let path = k;
      walk: for (let hops = 0; hops <= NS_MAX_HOPS; hops++) {
        const segs = path === "" ? [] : path.split("/");
        let table = "";
        for (let i = 1; i <= segs.length; i++) {
          const prefix = segs.slice(0, i).join("/");
          if (visit !== void 0 && !visit(prefix)) return "EACCES";
          const leaf = i === segs.length;
          const step = table === null ? null : table ? table + "/" + segs[i - 1] : segs[i - 1];
          const word = own?.(prefix);
          let target;
          if (word !== void 0 && "absent" in word) {
            return { path, table: null, row: void 0, own: word };
          } else if (word !== void 0 && "target" in word) {
            if (leaf && !followLeaf) return { path, table: null, row: void 0, own: word };
            target = word.target;
          } else if (word !== void 0 && "from" in word) {
            if (word.link !== void 0 && leaf && !followLeaf) {
              const at = nsRowAt(t, word.link) !== void 0 ? word.link : prefix;
              return { path, table: at, row: nsRowAt(t, at), own: word };
            }
            if (word.from === void 0) return { path, table: null, row: void 0, own: { absent: true } };
            if (word.link !== void 0) target = "/" + word.from;
            else {
              table = word.from;
              if (leaf) return { path, table, row: nsRowAt(t, table), own: word };
              continue;
            }
          } else if (word !== void 0) {
            table = word.hide ? null : prefix;
            if (leaf) return { path, table: prefix, row: nsRowAt(t, prefix), own: word };
            continue;
          } else {
            if (step === null) return { path, table: null, row: void 0 };
            table = step;
            if (!links.has(step) || leaf && !followLeaf) continue;
            const row = nsRowAt(t, step);
            if (!row || row.kind !== NS_LINK) continue;
            target = row.target;
          }
          const rest = segs.slice(i).join("/");
          const joined = joinTarget(prefix, target);
          path = rest ? joined ? joined + "/" + rest : rest : joined;
          continue walk;
        }
        return { path, table, row: table === null ? void 0 : nsRowAt(t, table) };
      }
      return "ELOOP";
    }
    const traversable = (row) => {
      if (!row || row.kind !== NS_DIR) return false;
      return namespaceAllows(cred, row, "directory", 1);
    };
    const children = (k) => coherence.require().nsChildren(k).map((row) => ({ name: String(row.name), kind: Number(row.kind), mode: Number(row.mode) }));
    return {
      bind(t) {
        links = /* @__PURE__ */ new Set();
        for (const row of t.nsOfKind(NS_LINK)) {
          const parent = String(row.parent);
          links.add(parent ? parent + "/" + String(row.name) : String(row.name));
        }
        unlisted = /* @__PURE__ */ new Map();
        for (const row of t.nsUnlisted()) {
          const parent = String(row.parent);
          unlisted.set(parent ? parent + "/" + String(row.name) : String(row.name), String(row.target));
        }
        ok = t.metaGet("ns") === "1";
      },
      setCred(given) {
        cred = given || null;
      },
      get cred() {
        return cred;
      },
      ready,
      get ok() {
        return ok;
      },
      markReady,
      refuse,
      overlayDelta(bytes) {
        if (!admission.inHeap) return;
        const refused = bytes > 0 ? admission.namespaceRefusal(bytes) : null;
        if (refused !== null) refuse(coherence.tables("a namespace overlay"), refused);
        admission.addOverlay(bytes);
      },
      rowAt: (k) => nsRowAt(coherence.require(), k),
      notReadyCause() {
        if (!coherence.bound()) return "the process's store is not bound";
        const sealed = coherence.sealed();
        if (sealed !== null) return sealed || "the store has not reconciled with the session";
        return cause;
      },
      put,
      tryPut,
      deleteTree,
      forget,
      lookup,
      /** `lookup`, with null when nothing is there. */
      resolve(k, followLeaf, own) {
        const found = lookup(k, followLeaf, own);
        if (found === "ELOOP") return found;
        return found.row !== void 0 && found.table !== null ? { path: found.table, row: found.row } : null;
      },
      /**
       * The mount point when the namespace cannot say what `k` is: its lookup
       * misses at or under a directory the listing did not name (or, with
       * `listing`, lands on or under one). Null when it knows.
       */
      unknown(k, followLeaf, listing, own) {
        if (unlisted.size === 0) return null;
        const found = lookup(k, followLeaf, own);
        if (found === "ELOOP" || found.own !== void 0 || found.table === null) return null;
        if (found.row === void 0) return unlistedOver(found.table, false);
        return listing ? unlistedOver(found.table, true) : null;
      },
      /** The entries directly under directory `k` (already resolved); the mode says what a file kind is. */
      children,
      /**
       * Whether the credential may read the file `stat` describes: what decides
       * whether bytes the store already has are kept for it under a new revision,
       * or a copy is held for it, rather than asked of the session. Equal content
       * keys prove the bytes are the file's, not that this credential may read
       * them, and a chmod or a chown changes no byte. A stat that does not state
       * the mode and owner is no grant: the session is asked instead, and answers.
       */
      readable(stat) {
        if (!stat || !Number.isInteger(Number(stat.mode)) || !Number.isInteger(Number(stat.uid)) || !Number.isInteger(Number(stat.gid))) return false;
        return namespaceAllows(cred, stat, "file", 4);
      },
      /**
       * Apply one delta entry that carries a stat. Returns a directory whose
       * subtree must be relisted — one that just became searchable, whose
       * descendants no delta names — or null.
       */
      applyEntry(t, entry) {
        const k = nsKey(entry.path);
        if (k === "") return null;
        if (entry.stat === null) {
          deleteTree(t, k, true);
          return null;
        }
        const before = nsRowAt(t, k);
        if (!tryPut(t, k, entry.stat, entry.rev, entry.linkTarget)) return null;
        const after = nsRowAt(t, k);
        if (after.kind !== NS_DIR) {
          deleteTree(t, k, false);
          return null;
        }
        const was = before !== void 0 && traversable(before);
        const now = traversable(after);
        if (was && !now) deleteTree(t, k, false);
        if (!was && now && before !== void 0) return k;
        return null;
      },
      /**
       * Bring the table to a complete listing: upsert what differs, delete what the
       * listing no longer names. Called once per enumeration, after its last page.
       */
      replace(t, entries) {
        const names = /* @__PURE__ */ new Set();
        for (const entry of entries) names.add(nsKey(entry.path));
        for (const row of t.nsKeys()) {
          const parent = String(row.parent);
          const k = parent ? parent + "/" + String(row.name) : String(row.name);
          if (!names.has(k)) forget(t, k);
        }
        if (admission.inHeap) {
          for (const entry of entries) {
            const k = nsKey(entry.path);
            if (!k) continue;
            const [parent, name] = nsSplit(k);
            const held = t.nsGet(parent, name);
            if (held && namespaceRowBytes(parent, name, held.target) > namespaceRowBytes(parent, name, entry.linkTarget ?? entry.unlisted)) {
              put(t, k, entry.stat, entry.rev, entry.linkTarget, entry.unlisted ?? null);
            }
          }
        }
        for (const entry of entries) {
          const k = nsKey(entry.path);
          if (k === "") continue;
          names.add(k);
          const held = nsRowAt(t, k);
          const s = entry.stat;
          if (held !== void 0 && held.kind === nsKindCode(s.type) && held.size === Number(s.size) && held.mode === Number(s.mode) && held.uid === Number(s.uid) && held.gid === Number(s.gid) && held.mtime === Number(s.mtime) && held.ctime === Number(s.ctime) && held.ino === Number(s.ino) && held.dev === (Number(s.dev) || 0) && held.rev === Number(entry.rev) && (held.target ?? null) === (entry.linkTarget ?? entry.unlisted ?? null)) continue;
          put(t, k, s, entry.rev, entry.linkTarget, entry.unlisted ?? null);
        }
      },
      /**
       * Record this facet's own acknowledged write in the namespace before the
       * delta that reports it: a file it created is then listed at once. Only
       * when the table has nothing as new, so an authority stat already applied at
       * or past `rev` is never overwritten by this approximation; the delta that
       * reports the write replaces it with the authority's stat.
       */
      noteOwnFile(k, size, rev) {
        if (!ready()) return;
        const t = coherence.require();
        const held = nsRowAt(t, k);
        if (held !== void 0 && held.rev >= rev) return;
        const now = realNow();
        const slash = k.lastIndexOf("/");
        const parent = held === void 0 ? nsRowAt(t, slash < 0 ? "" : k.slice(0, slash)) : void 0;
        tryPut(t, k, {
          type: "file",
          size,
          mode: held ? held.mode : 33206 & ~Number(cred?.umask ?? 18),
          uid: held ? held.uid : Number(cred?.uid ?? 0),
          gid: held ? held.gid : Number(cred?.gid ?? 0),
          atime: now,
          mtime: now,
          ctime: now,
          ino: held ? held.ino : 0,
          dev: held ? held.dev : parent?.dev,
          nlink: held ? held.nlink : 1
        }, rev, null);
      },
      /**
       * Record what the authority just said of a name this process asked about (an
       * async stat, read or accepted write): the sync view answers it at once,
       * as it would after the delta that reports it. Dated at the store's cursor,
       * so any row as new is kept, and the next delta naming the path replaces it
       * with the authority's own dating. `stat` null: the authority said it is not
       * there, and a row older than the cursor goes. The caller has checked that no
       * barrier reported the path while the stat was out (node-shims
       * _noteLearnedStat).
       *
       * `written`: the revision of this process's own accepted write the stat was
       * taken after, and the row's date. The row noteOwnFile approximated for
       * that write is dated there too, so the authority's stat replaces it (the
       * owner of a file the process overwrote without having listed it is the
       * authority's, not the process's), and only a row newer than the write is
       * kept.
       *
       * A symlink's stat does not say where the link points, so it is not kept:
       * a row without its target would resolve the link to its own directory.
       */
      noteLiveStat(k, stat, written) {
        if (!ready()) return;
        const cursor = coherence.cursor();
        if (cursor === null) return;
        const t = coherence.require();
        const held = nsRowAt(t, k);
        if (held !== void 0 && (written === void 0 ? held.rev >= cursor.rev : held.rev > written)) return;
        if (stat === null) {
          if (held !== void 0) forget(t, k);
          return;
        }
        if (!nsDescribes(stat)) return;
        const target = stat.linkTarget ?? stat.target ?? null;
        if (stat.type === "symlink" && target === null) return;
        tryPut(t, k, stat, written ?? cursor.rev, target);
      },
      clear() {
        links = /* @__PURE__ */ new Set();
        unlisted = /* @__PURE__ */ new Map();
        ok = false;
      },
      get lazy() {
        return lazy;
      },
      beginLazy() {
        lazy = true;
        listed.clear();
        links = /* @__PURE__ */ new Set();
        unlisted = /* @__PURE__ */ new Map();
      },
      listedAt(k) {
        return listed.has(nsSplit(k)[0]);
      },
      isListed(dir) {
        return listed.has(dir);
      },
      markListed(dir) {
        listed.add(dir);
      },
      /** Forget that `dir` and every directory beneath it are listed: a change no delta itemises may have moved their names. */
      forgetListed
    };
  }

  // src/vfs/resident/cells.ts
  function createCells(coherence, admission, namespace, observeRead) {
    const held = /* @__PURE__ */ new Map();
    const unheld = /* @__PURE__ */ new Set();
    const cellSize = (cell) => typeof cell === "string" ? cell.length * 3 : residentBytes(cell).byteLength;
    const forgetHeld = (path) => {
      const cell = held.get(path);
      if (cell !== void 0) {
        held.delete(path);
        admission.addHeld(-cellSize(cell.cell));
      }
      unheld.delete(path);
    };
    const hold = (path, cell) => {
      forgetHeld(path);
      const size = cellSize(cell);
      const limit = admission.heldLimit(FACET_OWN_WRITE_MEMORY_BYTES);
      if (size > limit) {
        unheld.add(path);
        return;
      }
      while (admission.heldBytes + size > limit) {
        const [oldest, old] = held.entries().next().value;
        held.delete(oldest);
        admission.addHeld(-cellSize(old.cell));
        unheld.add(oldest);
      }
      held.set(path, { cell, rev: RK_OWN_WRITE });
      admission.addHeld(size);
    };
    const head = (path) => coherence.require().fileHead(path);
    const dropDated = () => {
      coherence.tables("dropDated").dropDated();
      for (const [path, cell] of [...held]) if (cell.rev !== RK_OWN_WRITE) forgetHeld(path);
    };
    const put = (t, path, cell, rev, ckey) => {
      forgetHeld(path);
      admission.release(path);
      t.chunkDelete(path);
      const stamp = typeof rev === "number" ? rev : RK_OWN_WRITE;
      if (cell && typeof cell === "object" && "error" in cell && cell.error) {
        t.filePut(path, RK_DENIED, 0, 0, stamp, null);
        return true;
      }
      const isText = typeof cell === "string";
      const kind = isText ? RK_TEXT : RK_BINARY;
      const body = isText ? cell : residentBytes(cell);
      const size = isText ? body.length : body.byteLength;
      const limit = isText ? Math.floor(RESIDENT_CHUNK_BYTES / 3) : RESIDENT_CHUNK_BYTES;
      const chunks = Math.max(1, Math.ceil(size / limit));
      if (!admission.fits(residentCellCost(cell), stamp !== RK_OWN_WRITE)) {
        t.fileDelete(path);
        if (stamp === RK_OWN_WRITE) hold(path, cell);
        return false;
      }
      for (let part = 0; part < chunks; part++) {
        const slice = typeof body === "string" ? body.slice(part * limit, (part + 1) * limit) : body.subarray(part * limit, (part + 1) * limit);
        if (typeof slice === "string") t.chunkAddText(path, part, slice);
        else t.chunkAddBin(path, part, slice);
      }
      t.filePut(path, kind, size, chunks, stamp, stamp === RK_OWN_WRITE || ckey == null ? null : String(ckey));
      return true;
    };
    const putChunk = (t, path, part, bytes) => {
      if (part === 0) admission.release(path);
      if (!admission.fits(Math.ceil(bytes.byteLength * 1.01) + RESIDENT_ROW_BYTES + 4096)) return false;
      t.chunkSetBin(path, part, bytes);
      return true;
    };
    const admit = (result) => {
      const t = coherence.tables("admit");
      const dropped = [];
      const relist = [];
      let kept = 0, pushed = 0;
      const epoch = result && result.epoch != null ? String(result.epoch) : null;
      const rev = result && result.rev != null ? Number(result.rev) : null;
      if (epoch === null || rev === null) {
        throw new Error(
          "Nimbus: fsAcquire returned no cursor; the resident store stays sealed rather than serving rows it cannot date"
        );
      }
      const at = coherence.cursor();
      const floor = at !== null && coherence.sealed() === null && at.epoch === epoch && !(result && result.poison) ? at.rev : null;
      if (floor !== null && rev <= floor) {
        return { dropped, kept, pushed: 0, relist, cursor: at, stale: rev < floor };
      }
      const nsOk = namespace.ok;
      const followable = !!result && !result.poison && (result.namespace === true || Array.isArray(result.paths) && result.paths.length === 0) && (!Array.isArray(result.paths) || result.paths.every((entry) => entry.stat === null || nsDescribes(entry.stat)));
      const namespaced = nsOk && followable;
      if (nsOk && !followable) {
        namespace.markReady(t, false, !result || result.poison ? "the session's change log was truncated past this process's cursor" : "a change reported without the stat every name needs");
      }
      if (!result || result.poison) {
        dropDated();
      } else if (Array.isArray(result.paths)) {
        for (const entry of result.paths) {
          if (floor !== null && Number(entry.rev) <= floor) continue;
          const path = entry.path;
          if (namespaced && namespace.ready()) {
            const again = namespace.applyEntry(t, entry);
            if (again !== null) relist.push(again);
          }
          if (entry.subtree || entry.structural) {
            const end = prefixEnd(path + "/");
            for (const row2 of t.fileRevsIn(path + "/", end)) {
              const stamped2 = row2.rev;
              if (stamped2 === RK_OWN_WRITE || stamped2 >= Number(entry.rev)) continue;
              t.chunkDelete(row2.path);
              t.fileDelete(row2.path);
              dropped.push(row2.path);
            }
            for (const [heldPath, heldCell2] of [...held]) {
              if (!heldPath.startsWith(path + "/") || heldCell2.rev === RK_OWN_WRITE || heldCell2.rev >= Number(entry.rev)) continue;
              forgetHeld(heldPath);
            }
            if (namespaced && entry.subtree && entry.stat && entry.stat.type === "directory") relist.push(path);
          }
          let isHeld = false, stamped = 0, heldKey = null;
          const row = t.fileRevKey(path);
          if (row !== void 0) {
            isHeld = true;
            stamped = row.rev;
            heldKey = row.ckey;
          }
          if (isHeld && (stamped === RK_OWN_WRITE || stamped >= Number(entry.rev))) {
            kept++;
            continue;
          }
          const heldCell = held.get(path);
          if (heldCell !== void 0) {
            if (heldCell.rev === RK_OWN_WRITE || heldCell.rev >= Number(entry.rev)) {
              kept++;
              continue;
            }
            forgetHeld(path);
          }
          if (isHeld && heldKey !== null && entry.contentKey != null && heldKey === String(entry.contentKey) && namespace.readable(entry.stat)) {
            t.fileSetRev(path, Number(entry.rev));
            kept++;
            continue;
          }
          if (entry.bytes != null && entry.stat && entry.stat.type === "file") {
            if (put(t, path, residentBytes(entry.bytes), Number(entry.rev), entry.contentKey)) pushed++;
            else if (isHeld) dropped.push(path);
            continue;
          }
          if (!isHeld) continue;
          t.chunkDelete(path);
          t.fileDelete(path);
          dropped.push(path);
        }
      }
      coherence.writeCursor(t, { epoch, rev });
      coherence.unseal();
      return { dropped, kept, pushed, relist, cursor: { epoch, rev } };
    };
    const get = (path) => {
      if (observeRead !== null) observeRead(path.replace(/^\/+/, ""));
      const found = head(path);
      if (found === void 0) {
        const cell = held.get(path);
        if (cell === void 0) return void 0;
        held.delete(path);
        held.set(path, cell);
        return cell.cell;
      }
      const kind = found.kind;
      if (kind === RK_DENIED) return { error: "EACCES" };
      const t = coherence.require();
      if (found.chunks === 1) {
        const row = t.chunkFirst(path);
        if (row === void 0) return void 0;
        return kind === RK_TEXT ? row.txt : residentBytes(row.bin);
      }
      if (kind === RK_TEXT) {
        const parts2 = t.chunkParts(path).map((row) => row.txt);
        return parts2.length === 0 ? void 0 : parts2.join("");
      }
      const parts = t.chunkParts(path).map((row) => residentBytes(row.bin));
      if (parts.length === 0) return void 0;
      const total = parts.reduce((n, p) => n + p.byteLength, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const p of parts) {
        out.set(p, offset);
        offset += p.byteLength;
      }
      return out;
    };
    const deleteCell = (t, path) => {
      const had = head(path) !== void 0 || held.has(path);
      forgetHeld(path);
      t.chunkDelete(path);
      t.fileDelete(path);
      return had;
    };
    const keys = () => coherence.require().fileAllPaths();
    const bundle = new Proxy(/* @__PURE__ */ Object.create(null), {
      get(_t, path) {
        if (typeof path !== "string") return void 0;
        return get(path);
      },
      has(_t, path) {
        if (typeof path !== "string") return false;
        return head(path) !== void 0 || held.has(path);
      },
      set(_t, path, cell) {
        if (typeof path !== "string") return true;
        put(coherence.require(), path, cell, void 0);
        return true;
      },
      deleteProperty(_t, path) {
        if (typeof path === "string") deleteCell(coherence.require(), path);
        return true;
      },
      ownKeys() {
        return keys();
      },
      getOwnPropertyDescriptor(_t, path) {
        if (typeof path !== "string") return void 0;
        if (head(path) === void 0) return void 0;
        return { configurable: true, enumerable: true, get() {
          return get(path);
        } };
      }
    });
    return {
      bundle,
      /**
       * Apply one authority delta and unseal.
       *
       * `result` is exactly what `supervisor.fsAcquire(epoch, cursor)` returns
       * (`VfsAcquireResult` — runtime/os-contracts.ts), so this store slots into the
       * ACQUIRE/RELEASE protocol the shims already run rather than beside it. One
       * cache, one invariant.
       *
       * Returns the paths that WERE held and are now gone, which is what
       * `_acquireAndRefetch` re-reads live — the same contract `_acquireBarrier`
       * already has — and how many named rows were kept because their revision
       * already covers the report (this facet's own writes coming back).
       */
      admit,
      /**
       * Drop every row the authority dated, and nothing else: what a poison does to
       * the rows when nothing can vouch for them. The cursor is left alone, because
       * a store that holds no dated row cannot hold a stale one whatever its cursor
       * says.
       *
       * This facet's own bytes are not the authority's to vouch for, and stay:
       * dropping a row a write or mutation still in flight owns would hand the next
       * fill the pre-write bytes. Its acknowledgement dates it, or evicts it, when
       * it lands.
       *
       * Two statements rather than a delete per path: at pi scale that is 7,141
       * rows, and this is on the hot path (measured 45 ms whole-store, vs a per-row
       * walk).
       */
      dropDated,
      head,
      has: (path) => head(path) !== void 0 || held.has(path),
      denied: (path) => {
        const found = head(path);
        if (found !== void 0) return found.kind === RK_DENIED;
        const cell = held.get(path)?.cell;
        return typeof cell === "object" && cell !== null && !(cell instanceof Uint8Array) && typeof cell.error === "string";
      },
      get,
      put,
      putChunk,
      /**
       * The head row, written LAST by the streaming filler.
       *
       * Order is the durability rule here: without a head row `head` returns
       * undefined and the path simply misses, falling through to the supervisor
       * exactly as it would have. So a fill interrupted part way through a large
       * file leaves chunks nothing can read, never a short file something can.
       * Writing the head first would invert that into a truncated read.
       */
      putHead(t, path, kind, size, chunks, rev, ckey) {
        t.filePut(
          path,
          kind,
          size,
          chunks,
          typeof rev === "number" ? rev : RK_OWN_WRITE,
          typeof rev === "number" && ckey != null ? String(ckey) : null
        );
      },
      /**
       * Hold `path` with the bytes of a dated row whose content identity is
       * `ckey`, by copying rows inside this store: equal keys are equal bytes, so
       * no fetch is needed. Returns whether a source existed.
       */
      copyByKey(t, path, ckey, rev) {
        const source = t.fileByKey(String(ckey), path);
        if (source === void 0) return false;
        if (!admission.fits(source.size + (source.chunks + 1) * RESIDENT_ROW_BYTES)) return false;
        t.chunkDelete(path);
        t.chunkCopy(path, source.path);
        t.filePut(path, source.kind, source.size, source.chunks, rev, String(ckey));
        return true;
      },
      delete: deleteCell,
      /**
       * What a row is dated at: its revision, RK_OWN_WRITE for this facet's own
       * unacknowledged bytes, or undefined when the path is not held.
       */
      provenance: (path) => coherence.require().fileRev(path),
      /**
       * Date this facet's own bytes with the revision the authority acknowledged
       * them at: the revision a flushed write produced, or the one an own mutation's
       * receipt settles on. The store's half of the stamp `__vfsBundleRevisions`
       * carries in heap (_shared/vfs-write-ledger.ts), kept in the row it describes
       * so the two cannot drift.
       *
       * Only a row still holding own bytes is dated. One that was dropped or
       * replaced meanwhile holds something this acknowledgement says nothing about.
       *
       * Without it nothing dates an own row, and RK_OWN_WRITE is the revision a
       * delta never evicts: a file this process wrote would serve its own bytes over
       * every later write to it by anyone.
       */
      stamp(path, rev) {
        const heldCell = held.get(path);
        if (heldCell !== void 0 && heldCell.rev === RK_OWN_WRITE) heldCell.rev = rev;
        const t = coherence.require();
        const size = t.fileOwnSize(path);
        if (size === void 0) return;
        t.fileStampOwn(path, rev);
        namespace.noteOwnFile(path, size, rev);
      },
      /**
       * Hold a dated row as this facet's own for the window of one of its own
       * mutations (a ranged write, a truncate, a chmod), and return the revision it
       * was dated at: the mutation's receipt is judged against it when the window
       * closes (`__nimbusEndOwnMutation`). Undefined when there is no dated row —
       * an own row is held already, and an absent one has nothing to protect.
       *
       * The hold is what keeps a barrier that reports the mutation before its own
       * response arrives from evicting the cell the mutation is about to overlay.
       * The supervisor answers fsAcquire at once, while a write's response waits on
       * the Durable Object's output gate, so that ordering is ordinary.
       */
      lease(path) {
        const t = coherence.require();
        const rev = t.fileRev(path);
        if (rev === void 0 || rev === RK_OWN_WRITE) return void 0;
        t.fileSetRev(path, RK_OWN_WRITE);
        return rev;
      },
      /**
       * Install bytes a live read returned, dated `rev`: the cursor the read was
       * issued under, so the bytes hold every mutation at or below it. An async read
       * must write through, or the next synchronous read goes back in time relative
       * to what the program was just handed (protocol §5.9).
       *
       * Refused over a row of own bytes, which are newer than anything a read can
       * return, and over a row dated after `rev`, which is newer than this read can
       * vouch for. Returns whether the bytes were installed.
       */
      fill(path, cell, rev) {
        if (typeof rev !== "number" || rev < 0) {
          throw new Error(
            "Nimbus: refusing to fill '" + path + "' with no authority revision. An undated row cannot be invalidated, so it would be served stale forever."
          );
        }
        const t = coherence.require();
        const dated = t.fileRev(path);
        if (dated !== void 0 && (dated === RK_OWN_WRITE || dated > rev)) return false;
        const heldCell = held.get(path);
        if (heldCell !== void 0 && (heldCell.rev === RK_OWN_WRITE || heldCell.rev > rev)) return false;
        return put(t, path, cell, rev);
      },
      /** Every held path. Backs the Object.keys / for-in scans in the shims. */
      keys,
      /**
       * Every path held as this facet's own unacknowledged bytes: the rows a
       * poison's repair keeps without a revision to vouch for them, whose reports
       * the shims deliver to their owners (`_settleSkippedReports`).
       */
      ownPaths: () => coherence.require().fileOwnPaths(),
      /**
       * Paths under a directory prefix, as a bounded index range scan.
       *
       * The shims ask this constantly — readdirSync's union with the manifest,
       * existsSync of a directory, node's own module resolution, rm -rf, watch
       * globbing. In heap it was a for-in over every key; here it must be a range
       * scan on both ends, because that is the only version that is actually cheaper:
       * an open-ended `path >= prefix` with a LIKE filter still visits every row
       * after the prefix, and going back through the object protocol visits every row
       * AND reads every file's bytes.
       *
       * Two bounds also mean no LIKE, so a real path containing '%' or '_' needs no
       * escaping — those are only wildcards to an operator this no longer uses.
       */
      keysUnder(prefix) {
        const from = String(prefix);
        return coherence.require().filePaths(from, prefixEnd(from));
      },
      /**
       * Whether ANY path is held under a prefix — the same range, stopped at the
       * first row. The hot half: it is what answers "is this a directory" on node's
       * module-resolution path, where materialising the subtree would be the cost all
       * over again.
       */
      hasUnder(prefix) {
        const from = String(prefix);
        return coherence.require().fileAny(from, prefixEnd(from));
      },
      storageMiss: (path) => unheld.has(path),
      dropHeld(all) {
        for (const [path, cell] of [...held]) if (all || cell.rev !== RK_OWN_WRITE) forgetHeld(path);
      },
      heldRevisions: () => [...held].map(([path, cell]) => [path, cell.rev]),
      forget: forgetHeld,
      /**
       * Drop every cell AND the cursor, and re-seal.
       *
       * This is slot handover, not invalidation: a returned slot must not hand the
       * next tenant a filesystem, and dropping the rows while leaving a cursor behind
       * would leave the store claiming to be current at a revision it holds nothing
       * from. Clearing the cursor forces the next incarnation through `admit` from
       * scratch. sync.boot clears the same way when a kept store cannot be
       * reconciled.
       */
      clear() {
        coherence.tables("clear").clear();
        for (const [path, cell] of [...held]) if (cell.rev !== RK_OWN_WRITE) forgetHeld(path);
        namespace.clear();
        coherence.seal("the store was cleared");
      },
      stats() {
        const t = coherence.tables("stats");
        const counted = t.fileStats();
        return {
          files: counted === void 0 ? 0 : counted.n,
          bytes: counted === void 0 ? 0 : counted.b,
          names: t.nsCount(),
          namespace: namespace.ready(),
          databaseSize: t.databaseSize(),
          sealed: coherence.sealed() !== null,
          undatedSnapshot: coherence.undated,
          cursor: coherence.cursor()
        };
      }
    };
  }

  // src/vfs/resident/coherence.ts
  function createCoherence() {
    let t = null;
    let heap = null;
    let isSealed = true;
    let undated = false;
    let sealReason = "the store has not reconciled with the authority in this incarnation";
    return {
      bind(tables, heapTables2) {
        t = tables;
        heap = heapTables2;
      },
      bound: () => t !== null,
      serving: () => t !== null && !isSealed,
      tables(doing) {
        if (t === null) throw new Error("Nimbus: " + doing + " before the store was bound");
        return t;
      },
      get heap() {
        return heap;
      },
      require() {
        if (t === null) {
          throw new Error(
            "Nimbus: the resident store was read before its facet bound its SQLite. store.bind(ctx) must run in the process DO constructor, ahead of the program."
          );
        }
        if (isSealed) {
          throw new Error(
            "Nimbus: the resident store is sealed \u2014 " + sealReason + ". cells.admit(fsAcquire(...)) must apply the authority's delta before the program runs; serving a row now would serve bytes of unknown age."
          );
        }
        return t;
      },
      sealed: () => isSealed ? sealReason : null,
      seal(reason) {
        isSealed = true;
        sealReason = String(reason || "resealed");
      },
      unseal() {
        isSealed = false;
        sealReason = "";
      },
      get undated() {
        return undated;
      },
      setUndated(value) {
        undated = value;
      },
      cursor() {
        if (t === null) return null;
        const epoch = t.metaGet("epoch");
        const rev = t.metaGet("rev");
        return epoch === void 0 || rev === void 0 ? null : { epoch, rev: Number(rev) };
      },
      writeCursor(tables, cursor) {
        tables.metaSet("epoch", String(cursor.epoch));
        tables.metaSet("rev", String(Number(cursor.rev)));
      }
    };
  }

  // src/vfs/resident/lazy.ts
  var LOOKUP_CONTENT_BYTES = 256 * 1024;
  function createLazy(coherence, admission, namespace, cells, transport, sync, pages) {
    const beginLazy = (t, cursor) => {
      namespace.beginLazy();
      t.clear();
      pages.reset();
      cells.dropHeld(true);
      coherence.writeCursor(t, cursor);
      coherence.unseal();
      coherence.setUndated(false);
      namespace.markReady(t, true);
    };
    const bootLazy = async (supervisor) => {
      if (!supervisor || typeof supervisor.fsAcquire !== "function") return false;
      let answer = null;
      try {
        answer = await supervisor.fsAcquire(null, 0, { namespace: true });
      } catch {
        return false;
      }
      if (!answer || typeof answer.epoch !== "string" || typeof answer.rev !== "number") return false;
      beginLazy(coherence.tables("bootLazy"), { epoch: answer.epoch, rev: answer.rev });
      return true;
    };
    const lazyBarrier = async (supervisor) => {
      const t = coherence.tables("lazyBarrier");
      const cursor = coherence.cursor();
      let answer = null;
      if (cursor !== null) {
        try {
          answer = await supervisor.fsAcquire(cursor.epoch, cursor.rev, { namespace: true });
        } catch {
          answer = null;
        }
      }
      if (answer && typeof answer.epoch === "string" && typeof answer.rev === "number") {
        if (!answer.poison) {
          await sync.applyAcquire(supervisor, answer);
          if (namespace.ready()) return true;
          beginLazy(t, coherence.cursor());
          return true;
        }
        beginLazy(t, { epoch: answer.epoch, rev: answer.rev });
        return true;
      }
      return bootLazy(supervisor);
    };
    return {
      bootLazy,
      /**
       * The store as a WASI process's filesystem adapter reads it (core
       * runtime/wasi/resident-filesystem.ts, ResidentNamespace): names as lstats,
       * listed on demand, file bytes held or fetched, and the barrier. `device` is
       * the session's SQLite device, the only one the adapter answers for.
       */
      namespaceView(supervisor, device, cred) {
        namespace.setCred(cred);
        const encoder2 = new TextEncoder();
        const typeOf = (kind) => kind === NS_DIR ? "directory" : kind === NS_LINK ? "symlink" : "file";
        const view = {
          device: Number(device),
          cred: { uid: Number(cred.uid), gid: Number(cred.gid), groups: (cred.groups || []).map(Number) },
          ready: () => namespace.lazy && namespace.ready(),
          entry(k) {
            const row = nsRowAt(coherence.require(), k);
            if (row === void 0) return namespace.listedAt(k) ? null : void 0;
            return {
              type: typeOf(row.kind),
              dev: row.dev || 0,
              ino: row.ino,
              nlink: row.nlink || 1,
              size: row.size,
              atime: row.atime,
              mtime: row.mtime,
              ctime: row.ctime,
              mode: row.mode,
              uid: row.uid,
              gid: row.gid,
              revision: row.rev,
              target: row.target == null ? null : String(row.target)
            };
          },
          children(k) {
            if (!namespace.isListed(k)) return void 0;
            return namespace.children(k).map((child) => ({ name: child.name, type: typeOf(child.kind) }));
          },
          list: (k) => transport.listDirectory(supervisor, k),
          lookup: (keys, content) => transport.lookupKeys(supervisor, keys, content ? LOOKUP_CONTENT_BYTES : 0),
          listTree: (k) => transport.listSubtree(supervisor, k),
          content(k, revision) {
            if (revision !== void 0) {
              const stamped = cells.provenance(k);
              if (stamped !== void 0 && stamped !== RK_OWN_WRITE && stamped < revision) return void 0;
            }
            const cell = cells.get(k);
            if (cell === void 0 || typeof cell === "object" && "error" in cell) return void 0;
            return typeof cell === "string" ? encoder2.encode(cell) : cell;
          },
          async fill(k, entry) {
            const cursor = coherence.cursor();
            if (cursor === null) return null;
            await transport.fetchFiles(supervisor, [{ path: k, size: entry.size, rev: entry.revision, epoch: cursor.epoch, ckey: null, version: entry }]);
            const bytes = view.content(k, entry.revision);
            return bytes === void 0 ? null : bytes;
          },
          pages: (k, rev, size, first, last) => pages.read(supervisor, k, rev, size, first, last),
          // Many files in batched round trips (read-ahead, core runtime/wasi/resident-filesystem.ts).
          async fillMany(files) {
            const cursor = coherence.cursor();
            if (cursor === null || files.length === 0) return;
            await transport.fetchFiles(supervisor, files.map(([k, entry]) => ({ path: k, size: entry.size, rev: entry.revision, epoch: cursor.epoch, ckey: null, version: entry })));
          },
          barrier: () => lazyBarrier(supervisor),
          cursor: () => coherence.cursor(),
          // An ACQUIRE answer the caller took itself, applied as the barrier applies one.
          async admit(answer) {
            if (!answer || typeof answer.epoch !== "string" || typeof answer.rev !== "number") return false;
            const before = coherence.cursor();
            if (before && answer.epoch === before.epoch && answer.rev < before.rev) return false;
            await sync.applyAcquire(supervisor, answer);
            if (!answer.poison && namespace.ready()) return true;
            beginLazy(coherence.tables("admit"), { epoch: answer.epoch, rev: answer.rev });
            return false;
          },
          reserve: (bytes) => admission.pin(bytes),
          release: (bytes) => admission.unpin(bytes)
        };
        return view;
      }
    };
  }

  // src/vfs/resident/pages.ts
  function createPages(coherence, admission) {
    let clock = null;
    let total = null;
    const held = () => total ??= coherence.require().pageBytes();
    const tick = () => {
      clock ??= coherence.require().pageMaxUsed();
      return ++clock;
    };
    const bound = () => {
      const half = admission.inHeap && admission.cap !== null ? Math.floor(admission.cap / 2) : Infinity;
      const share = admission.available === null ? Infinity : Math.floor(RESIDENT_PAGE_CACHE_FREE_SHARE * (held() + admission.available));
      return Math.min(RESIDENT_PAGE_CACHE_BYTES, half, share);
    };
    const get = (path, rev, part) => {
      const t = coherence.require();
      const bin = t.pageGet(path, rev, part);
      if (bin === void 0) return void 0;
      t.pageUse(path, rev, part, tick());
      return residentBytes(bin);
    };
    const put = (path, rev, part, bytes) => {
      const t = coherence.require();
      const size = bytes.byteLength;
      const limit = bound();
      if (size > limit) return false;
      while (held() + size > limit) {
        const oldest = t.pageOldest(16);
        if (oldest.length === 0) break;
        for (const row of oldest) {
          t.pageDelete(row.path, row.rev, row.part);
          total = held() - row.size;
          if (total + size <= limit) break;
        }
      }
      if (!admission.fits(size + RESIDENT_ROW_BYTES, false)) return false;
      const replaced = t.pagePut(path, rev, part, bytes, tick());
      total = held() + size - replaced;
      return true;
    };
    return {
      async read(supervisor, k, rev, size, first, last) {
        const cursor = coherence.cursor();
        if (cursor === null || typeof supervisor.fsReadBatch !== "function") return null;
        const out = new Array(last - first + 1);
        const missing = [];
        for (let part = first; part <= last; part++) {
          const page = get(k, rev, part);
          if (page !== void 0) out[part - first] = page;
          else missing.push(part);
        }
        const perBatch = Math.max(1, Math.min(FS_READ_BATCH_PATH_LIMIT, Math.floor(FS_READ_BATCH_REQUEST_BYTES / RESIDENT_PAGE_BYTES)));
        for (let at = 0; at < missing.length; at += perBatch) {
          const batch = missing.slice(at, at + perBatch);
          const ranges = batch.map((part) => {
            const offset = part * RESIDENT_PAGE_BYTES;
            return { path: "/" + k, offset, length: Math.min(RESIDENT_PAGE_BYTES, Math.max(0, size - offset)), expectedEpoch: cursor.epoch, expectedRevision: rev };
          });
          await admission.ensureRoom(ranges.reduce((n, r) => n + r.length + RESIDENT_ROW_BYTES, 0));
          let results;
          try {
            results = await supervisor.fsReadBatch(ranges);
          } catch {
            return null;
          }
          if (!Array.isArray(results) || results.length !== ranges.length) return null;
          for (let i = 0; i < batch.length; i++) {
            const entry = results[i];
            if (!entry || entry.error || entry.bytes == null) return null;
            const bytes = residentBytes(entry.bytes);
            if (bytes.byteLength !== ranges[i].length) return null;
            out[batch[i] - first] = bytes;
            put(k, rev, batch[i], bytes);
          }
        }
        return { pages: out, fetched: missing.length };
      },
      reset() {
        clock = null;
        total = null;
      }
    };
  }

  // src/vfs/resident/transport.ts
  var BATCH_PATHS = FS_READ_BATCH_PATH_LIMIT;
  var BATCH_BYTES = FS_READ_BATCH_REQUEST_BYTES;
  var MAX_LIST_PAGES = 4096;
  var messageOf = (e) => e?.message || String(e);
  function createTransport(coherence, admission, namespace, cells) {
    const relist = async (supervisor, dir) => {
      const t = coherence.tables("relist");
      if (!supervisor || typeof supervisor.fsList !== "function") {
        namespace.markReady(t, false, "the session cannot list its filesystem");
        return;
      }
      const prefix = dir + "/";
      const seen = [];
      let replaceBytes = 0;
      let incomingBytes = 0;
      if (admission.inHeap) {
        for (const row of t.nsKeys()) {
          const key = row.parent ? row.parent + "/" + row.name : row.name;
          if (!key.startsWith(prefix)) continue;
          replaceBytes += namespaceRowBytes(row.parent, row.name, t.nsGet(row.parent, row.name)?.target);
        }
      }
      let after = prefix;
      let done = false;
      for (let page = 0; page < MAX_LIST_PAGES && !done; page++) {
        let listed;
        try {
          listed = await supervisor.fsList(after, FS_LIST_PAGE_LIMIT);
        } catch (e) {
          namespace.markReady(t, false, "a listing of /" + dir + " failed (" + messageOf(e) + ")");
          return;
        }
        if (!listed || !Array.isArray(listed.entries)) {
          namespace.markReady(t, false, "a listing of /" + dir + " came back without entries");
          return;
        }
        for (const entry of listed.entries) {
          const k = nsKey(entry.path);
          if (!k.startsWith(prefix)) {
            if (k > prefix) {
              done = true;
              break;
            }
            continue;
          }
          if (entry.stat) {
            if (admission.inHeap && admission.cap !== null) {
              const [parent, name] = nsSplit(k);
              incomingBytes += namespaceRowBytes(parent, name, entry.linkTarget ?? entry.unlisted);
              const refused = admission.namespaceRefusal(incomingBytes - replaceBytes);
              if (refused !== null) {
                namespace.markReady(t, false, refused);
                return;
              }
            }
            seen.push(entry);
          }
        }
        if (listed.next === null || listed.next === void 0) done = true;
        else after = listed.next;
      }
      if (!done) {
        namespace.markReady(t, false, "a listing of /" + dir + " did not finish");
        return;
      }
      if (!seen.every((entry) => nsDescribes(entry.stat))) {
        namespace.markReady(t, false, "a listing of /" + dir + " named an entry without its stat");
        return;
      }
      namespace.deleteTree(t, dir, false);
      for (const entry of seen) namespace.put(t, nsKey(entry.path), entry.stat, entry.rev, entry.linkTarget, entry.unlisted ?? null);
    };
    const outdated = (t, path, rev) => {
      const [parent, name] = nsSplit(path);
      const listed = t.nsGet(parent, name);
      return listed !== void 0 && Number(listed.rev) > rev;
    };
    const fetchFiles = async (supervisor, wantedFiles) => {
      const t = coherence.tables("fetchFiles");
      const requested = wantedFiles.length;
      let copied = 0;
      const files = [];
      const later = [];
      const fetching = /* @__PURE__ */ new Set();
      for (const file of wantedFiles) {
        if (file.ckey != null) {
          if (cells.copyByKey(t, file.path, file.ckey, file.rev)) {
            copied++;
            continue;
          }
          if (fetching.has(file.ckey)) {
            later.push(file);
            continue;
          }
          fetching.add(file.ckey);
        }
        files.push(file);
      }
      const ranges = [];
      for (const file of files) {
        const parts = Math.max(1, Math.ceil(file.size / RESIDENT_CHUNK_BYTES));
        const version = file.rev === 0 ? file.version ?? file.stat ?? null : null;
        for (let part = 0; part < parts; part++) {
          const offset = part * RESIDENT_CHUNK_BYTES;
          ranges.push({
            path: file.path,
            rev: file.rev,
            epoch: file.epoch,
            version,
            part,
            parts,
            offset,
            length: Math.min(RESIDENT_CHUNK_BYTES, Math.max(0, file.size - offset)),
            size: file.size,
            ckey: file.ckey ?? null
          });
        }
      }
      const landed = /* @__PURE__ */ new Map();
      let filled = 0, failed = 0, fetchedBytes = 0;
      const failedPaths = /* @__PURE__ */ new Set();
      const revOf = new Map(ranges.map((range) => [range.path, range.rev]));
      for (let at = 0; at < ranges.length; ) {
        const batch = [];
        let bytes = 0;
        while (at < ranges.length && batch.length < BATCH_PATHS && (batch.length === 0 || bytes + ranges[at].length <= BATCH_BYTES)) {
          bytes += ranges[at].length;
          batch.push(ranges[at]);
          at++;
        }
        if (!await admission.ensureRoom(bytes + batch.length * RESIDENT_ROW_BYTES)) {
          for (const r of batch) failedPaths.add(r.path);
          continue;
        }
        let results;
        try {
          results = await supervisor.fsReadBatch(
            // A dated file at its revision; an undated one as its listing's stat named it.
            batch.map((r) => r.version === null ? { path: r.path, offset: r.offset, length: r.length, expectedEpoch: r.epoch, expectedRevision: r.rev } : { path: r.path, offset: r.offset, length: r.length, expectedFile: fileVersionOf(r.version) })
          );
        } catch {
          for (const r of batch) failedPaths.add(r.path);
          continue;
        }
        for (let i = 0; i < batch.length; i++) {
          const range = batch[i];
          const entry = results && results[i];
          if (!entry || entry.error) {
            const code = entry?.error ? entry.error.code : void 0;
            if (code === "EACCES" && range.part === 0) {
              cells.put(t, range.path, { error: "EACCES" }, range.rev);
              filled++;
            } else failedPaths.add(range.path);
            continue;
          }
          if (entry.bytes === null || entry.bytes === void 0) {
            failedPaths.add(range.path);
            continue;
          }
          const chunk = residentBytes(entry.bytes);
          if (chunk.byteLength !== range.length) {
            failedPaths.add(range.path);
            continue;
          }
          if (outdated(t, range.path, range.rev)) {
            failedPaths.add(range.path);
            continue;
          }
          fetchedBytes += chunk.byteLength;
          if (!cells.putChunk(t, range.path, range.part, chunk)) {
            failedPaths.add(range.path);
            continue;
          }
          const seen = (landed.get(range.path) || 0) + 1;
          landed.set(range.path, seen);
          if (seen === range.parts && !failedPaths.has(range.path)) {
            cells.putHead(t, range.path, RK_BINARY, range.size, range.parts, range.rev, range.ckey);
            filled++;
          }
        }
      }
      for (const path of failedPaths) {
        failed++;
        const held = t.fileRev(path);
        const rev = revOf.get(path);
        if (held !== void 0 && (held === RK_OWN_WRITE || rev !== void 0 && held >= rev)) continue;
        t.chunkDelete(path);
        t.fileDelete(path);
      }
      for (const file of later) {
        if (!outdated(t, file.path, file.rev) && cells.copyByKey(t, file.path, file.ckey, file.rev)) copied++;
        else failed++;
      }
      if (ranges.length > 0) await admission.reportSize();
      return {
        requested,
        filled: filled + copied,
        failed,
        bytes: fetchedBytes,
        ranges: ranges.length,
        copied
      };
    };
    const enumerate = async (supervisor) => {
      const t = coherence.tables("enumerate");
      const entries = [];
      const names = [];
      let namespaceBytes = 0;
      let after = null;
      let cursor = null;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const listed = await supervisor.fsList(after, FS_LIST_PAGE_LIMIT);
        if (!listed || !Array.isArray(listed.entries)) {
          throw new Error("Nimbus: fsList returned no page");
        }
        if (cursor === null) {
          cursor = { epoch: String(listed.epoch), rev: Number(listed.rev) };
        } else if (String(listed.epoch) !== cursor.epoch) {
          return { entries, names, cursor, complete: false, reason: "the supervisor changed incarnation mid-enumeration" };
        }
        for (const entry of listed.entries) {
          if (entry.stat) {
            if (admission.inHeap && admission.cap !== null) {
              const key = nsKey(entry.path);
              const [parent, name] = nsSplit(key);
              if (key) namespaceBytes += namespaceRowBytes(parent, name, entry.linkTarget ?? entry.unlisted);
              const heap = coherence.heap;
              const refused = admission.namespaceRefusal(namespaceBytes - (heap === null ? 0 : heap.nsBytes()));
              if (refused !== null) namespace.refuse(t, refused);
            }
            names.push(entry);
          }
          if (entry.kind !== "file") continue;
          const path = nsKey(entry.path);
          if (!path) continue;
          const size = Number(entry.size);
          const rev = Number(entry.rev);
          if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(rev) || rev < 0) {
            throw new Error("Nimbus: fsList returned unusable metadata for '" + path + "'");
          }
          entries.push({ path, size, rev, epoch: cursor.epoch, ckey: entry.contentKey == null ? null : String(entry.contentKey), stat: entry.stat ?? null });
        }
        if (listed.next === null || listed.next === void 0) {
          return { entries, names, namespaceBytes, cursor, complete: true, reason: null };
        }
        after = listed.next;
      }
      return { entries, names, cursor, complete: false, reason: "the filesystem exceeded the enumeration page bound" };
    };
    const lookupKeys = async (supervisor, keys, contentBytes) => {
      if (!supervisor || typeof supervisor.fsReadBatch !== "function" || keys.length === 0) return false;
      const t = coherence.require();
      const batch = keys.slice(0, BATCH_PATHS - 2);
      const last = batch[batch.length - 1];
      const withContent = contentBytes > 0 && batch.length === keys.length;
      const requests = batch.map((k) => ({ path: "/" + k, lstat: true }));
      if (withContent) requests.push({ path: "/" + last, offset: 0, length: contentBytes }, { path: "/" + last, lstat: true });
      let answers;
      try {
        answers = await supervisor.fsReadBatch(requests);
      } catch {
        return false;
      }
      if (!Array.isArray(answers) || answers.length !== requests.length) return false;
      let reachedLast = false;
      for (let i = 0; i < batch.length; i++) {
        const answer = answers[i];
        if (!answer || answer.error || answer.stat === null || answer.stat === void 0 || !nsDescribes(answer.stat)) break;
        let target;
        if (answer.stat.type === "symlink") {
          try {
            target = await supervisor.readlink("/" + batch[i]);
          } catch {
            break;
          }
          if (typeof target !== "string") break;
        }
        if (!namespace.tryPut(t, batch[i], answer.stat, Number(answer.stat.revision) || 0, target)) return false;
        if (i === batch.length - 1) reachedLast = true;
        if (answer.stat.type !== "directory") break;
      }
      if (withContent && reachedLast) {
        const before = answers[batch.length - 1].stat;
        const read = answers[batch.length];
        const after = answers[batch.length + 1];
        const bytes = read && !read.error && read.bytes ? residentBytes(read.bytes) : null;
        if (before.type === "file" && bytes !== null && bytes.byteLength === Number(before.size) && after && !after.error && after.stat && after.stat.type === "file" && Number(after.stat.ino) === Number(before.ino) && Number(after.stat.revision) === Number(before.revision) && await admission.ensureRoom(bytes.byteLength + RESIDENT_ROW_BYTES)) {
          t.fileDelete(last);
          t.chunkDelete(last);
          if (cells.putChunk(t, last, 0, bytes)) cells.putHead(t, last, RK_BINARY, bytes.byteLength, 1, Number(before.revision) || 0, null);
        }
      }
      return true;
    };
    const listDirectory = async (supervisor, dir) => {
      if (!supervisor || typeof supervisor.readdir !== "function" || typeof supervisor.fsReadBatch !== "function") return false;
      const t = coherence.require();
      let names;
      try {
        names = await supervisor.readdir("/" + dir);
      } catch {
        return false;
      }
      if (!Array.isArray(names)) return false;
      const keys = names.map((entry) => (dir === "" ? "" : dir + "/") + String(entry.name));
      const stats = /* @__PURE__ */ new Map();
      for (let i = 0; i < keys.length; i += BATCH_PATHS) {
        const batch = keys.slice(i, i + BATCH_PATHS);
        let answers;
        try {
          answers = await supervisor.fsReadBatch(batch.map((k) => ({ path: "/" + k, lstat: true })));
        } catch {
          return false;
        }
        if (!Array.isArray(answers) || answers.length !== batch.length) return false;
        for (let j = 0; j < batch.length; j++) {
          const answer = answers[j];
          if (!answer || answer.error) return false;
          if (answer.stat === null || answer.stat === void 0) continue;
          if (!nsDescribes(answer.stat)) return false;
          stats.set(batch[j], answer.stat);
        }
      }
      const targets = /* @__PURE__ */ new Map();
      for (const [k, stat] of stats) {
        if (stat.type !== "symlink") continue;
        let target;
        try {
          target = await supervisor.readlink("/" + k);
        } catch {
          return false;
        }
        if (typeof target !== "string") return false;
        targets.set(k, target);
      }
      for (const child of namespace.children(dir)) {
        const k = (dir === "" ? "" : dir + "/") + child.name;
        if (!stats.has(k)) namespace.deleteTree(t, k, true);
      }
      for (const [k, stat] of stats) {
        if (!namespace.tryPut(t, k, stat, Number(stat.revision) || 0, targets.get(k))) return false;
      }
      namespace.markListed(dir);
      return true;
    };
    const listSubtree = async (supervisor, dir) => {
      if (!supervisor || typeof supervisor.fsListTree !== "function") return false;
      const t = coherence.require();
      let tree;
      try {
        tree = await supervisor.fsListTree("/" + dir, FS_LIST_TREE_MAX_ENTRIES);
      } catch {
        return false;
      }
      if (!tree || !Array.isArray(tree.entries)) return false;
      const listed = [dir];
      const written = /* @__PURE__ */ new Set();
      for (const entry of tree.entries) {
        const k = nsKey(entry.path);
        if (!entry.stat || !nsDescribes(entry.stat)) return false;
        if (!namespace.tryPut(t, k, entry.stat, entry.rev, entry.linkTarget, entry.unlisted ?? null)) return false;
        written.add(k);
        if (entry.kind === "directory" && !entry.unlisted) listed.push(k);
      }
      for (const directory of listed) {
        for (const child of namespace.children(directory)) {
          const k = (directory === "" ? "" : directory + "/") + child.name;
          if (!written.has(k)) namespace.deleteTree(t, k, true);
        }
      }
      for (const directory of listed) namespace.markListed(directory);
      return true;
    };
    return { relist, fetchFiles, enumerate, lookupKeys, listDirectory, listSubtree };
  }
  function fileVersionOf(stat) {
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtime, ctime: stat.ctime, revision: stat.revision };
  }

  // src/vfs/resident/sync.ts
  var PUSH_EXCLUDE = ["node_modules", ".git"];
  function createSync(coherence, admission, namespace, cells, transport) {
    let pushRoots = [];
    let plan = /* @__PURE__ */ new Set();
    let manifests = null;
    const isManifest = (path) => (path === "package.json" || path.endsWith("/package.json")) && !("/" + path).includes("/.git/");
    const pushable = (path) => {
      for (const root of pushRoots) {
        if (root !== "" && path !== root && !path.startsWith(root + "/")) continue;
        const rest = root === "" ? path : path.slice(root.length + 1);
        if (!rest.split("/").some((seg) => PUSH_EXCLUDE.includes(seg))) return true;
      }
      return false;
    };
    const acquireOptions = () => pushRoots.length > 0 ? { namespace: true, push: { roots: pushRoots, exclude: PUSH_EXCLUDE } } : { namespace: true };
    const applyAcquire = async (supervisor, result) => {
      await admission.roomForPushed(result);
      const applied = cells.admit(result);
      for (const dir of applied.relist) {
        if (namespace.lazy) namespace.forgetListed(dir);
        else await transport.relist(supervisor, dir);
      }
      return applied;
    };
    const catchUp = async (supervisor, cursor) => {
      if (!supervisor || typeof supervisor.fsAcquire !== "function") return cursor;
      let result;
      try {
        result = await supervisor.fsAcquire(cursor.epoch, cursor.rev, acquireOptions());
      } catch {
        result = null;
      }
      if (!result || result.poison || typeof result.rev !== "number" || typeof result.epoch !== "string") {
        return cursor;
      }
      const applied = await applyAcquire(supervisor, result);
      const refetch = [];
      for (const path of applied.dropped) {
        const found = namespace.resolve(path, false);
        if (!found || found === "ELOOP" || found.row.kind !== NS_FILE) continue;
        refetch.push({ path, size: found.row.size, rev: found.row.rev, epoch: applied.cursor.epoch, version: versionOf(found.row) });
      }
      if (refetch.length > 0) await transport.fetchFiles(supervisor, refetch);
      return applied.cursor;
    };
    const synchronize = async (supervisor) => {
      const t = coherence.tables("synchronize");
      if (!supervisor || typeof supervisor.fsReadBatch !== "function") {
        return { requested: 0, filled: 0, failed: 0, skipped: "no fsReadBatch on this supervisor" };
      }
      if (typeof supervisor.fsList !== "function") {
        return { requested: 0, filled: 0, failed: 0, skipped: "supervisor cannot enumerate the filesystem (no fsList)" };
      }
      let listing;
      try {
        listing = await transport.enumerate(supervisor);
      } catch (e) {
        return { requested: 0, filled: 0, failed: 0, skipped: "fsList failed: " + messageOf(e) };
      }
      if (!listing.cursor) {
        return { requested: 0, filled: 0, failed: 0, skipped: "fsList reported no authority cursor" };
      }
      const held = coherence.cursor();
      const judgeable = listing.complete;
      const describable = judgeable && listing.names.every((entry) => nsDescribes(entry.stat));
      const comparable = judgeable && !!held && held.epoch === listing.cursor.epoch;
      const vouches = (entry, rev) => comparable && entry !== void 0 && entry.rev > 0 && rev >= entry.rev;
      const listed = /* @__PURE__ */ new Map();
      for (const file of listing.entries) listed.set(file.path, file);
      const rows = t.fileRows();
      const current = /* @__PURE__ */ new Set();
      const dropped = [];
      const own = [];
      let rekeyed = 0;
      for (const row of rows) {
        const entry = listed.get(row.path);
        if (row.rev === RK_OWN_WRITE) {
          current.add(row.path);
          own.push({
            path: row.path,
            rev: !comparable ? null : entry !== void 0 ? entry.rev : listing.cursor.rev
          });
          continue;
        }
        const keep = vouches(entry, row.rev) || !judgeable;
        if (keep) {
          current.add(row.path);
          continue;
        }
        if (entry !== void 0 && row.ckey !== null && entry.ckey != null && row.ckey === entry.ckey && namespace.readable(entry.stat)) {
          t.fileSetRev(row.path, entry.rev);
          current.add(row.path);
          rekeyed++;
          continue;
        }
        dropped.push(row.path);
      }
      for (const [path, rev] of cells.heldRevisions()) {
        if (current.has(path)) continue;
        const entry = listed.get(path);
        if (rev === RK_OWN_WRITE) {
          current.add(path);
          own.push({ path, rev: !comparable ? null : entry !== void 0 ? entry.rev : listing.cursor.rev });
          continue;
        }
        if (vouches(entry, rev) || !judgeable) {
          current.add(path);
          continue;
        }
        cells.forget(path);
        dropped.push(path);
      }
      if (dropped.length > 0 && !comparable && rekeyed === 0) {
        t.dropDatedFiles();
      } else {
        for (const path of dropped) {
          t.chunkDelete(path);
          t.fileDelete(path);
        }
      }
      const wanted = new Set(dropped);
      const fetch = [];
      const copied = [];
      for (const file of listing.entries) {
        if (current.has(file.path)) continue;
        if (manifests !== null && isManifest(file.path)) {
          const copy = manifests.get(file.path);
          if (Array.isArray(copy) && file.ckey !== null && copy[0] === file.ckey && namespace.readable(file.stat)) copied.push({ file, text: String(copy[1]) });
          else fetch.push(file);
          continue;
        }
        if (plan.has(file.path) || wanted.has(file.path) || pushable(file.path) && (!comparable || file.rev > held.rev)) fetch.push(file);
      }
      const heap = coherence.heap;
      const namespaceGrowth = admission.inHeap && describable && heap !== null ? Math.max(0, listing.namespaceBytes - heap.nsBytes()) : 0;
      const refused = admission.namespaceRefusal(namespaceGrowth);
      if (refused !== null) namespace.refuse(t, refused);
      const giveBack = admission.reserveNamespace(namespaceGrowth);
      let filled;
      try {
        let copiedBytes = 0;
        for (const { text } of copied) copiedBytes += residentCellCost(text);
        if (copiedBytes > 0) await admission.ensureRoom(copiedBytes);
        for (const { file, text } of copied) {
          if (!cells.put(t, file.path, text, file.rev, file.ckey)) fetch.push(file);
        }
        filled = await transport.fetchFiles(supervisor, fetch);
      } finally {
        giveBack();
      }
      if (judgeable) {
        if (describable) namespace.replace(t, listing.names);
        coherence.writeCursor(t, listing.cursor);
        namespace.markReady(t, describable, "the session's listing named an entry without its stat");
        coherence.setUndated(false);
        coherence.unseal();
      }
      return {
        requested: filled.requested,
        filled: filled.filled,
        failed: filled.failed,
        bytes: filled.bytes,
        ranges: filled.ranges,
        kept: current.size,
        rekeyed,
        dropped: dropped.length,
        own,
        reconciled: comparable,
        complete: listing.complete,
        cursor: judgeable ? listing.cursor : null,
        ...listing.reason ? { incomplete: listing.reason } : {}
      };
    };
    const adoptModuleBundle = (bundle, moduleCursor) => {
      const t = coherence.tables("adoptModuleBundle");
      if (coherence.cursor() !== null) {
        throw new Error("Nimbus: a module bundle is adopted only into an empty store");
      }
      const given = moduleCursor;
      if (!given || given.epoch == null || given.rev == null) {
        coherence.setUndated(true);
        coherence.unseal();
        return null;
      }
      const rev = Number(given.rev);
      for (const path of Object.keys(bundle || {})) {
        cells.put(t, path, bundle[path], rev);
      }
      return cells.admit({ poison: false, paths: [], epoch: String(given.epoch), rev }).cursor;
    };
    const fail = (pass) => pass && (pass.skipped || pass.incomplete) || null;
    return {
      /**
       * Make this incarnation's store servable before the program's first
       * instruction. The one boot path the resident body takes.
       *
       * A COLD store — no persisted cursor — adopts this spawn's own snapshot, the
       * module bundle dated at the cursor it was read at, and then fills the rest of
       * the filesystem from the authority. Its rows are current as of the spawn
       * whether or not the fill completes, which is all the protocol asks of a
       * process's first block (§5.3); the first ACQUIRE's delta brings them the rest
       * of the way.
       *
       * A KEPT store holds a PREVIOUS process's rows, dated against a cursor this
       * incarnation has never applied. A durable application's facet is one: it
       * keeps its `app-slot-` name across launches and its release never deletes
       * storage, so every relaunch or re-drive of the application opens what its
       * last process left. The rows are the asset — inside one supervisor
       * incarnation a relaunch fetches what changed, not the filesystem; across two,
       * whose revisions are unrelated, the reconcile rebuilds every dated row — and
       * they are also arbitrarily old: only the reconcile says which of them still
       * describe the filesystem, and nothing else runs before the program's first
       * synchronous reads. So the store stays SEALED through the reconcile, and a
       * reconcile that cannot vouch for its rows — the listing failed, came back
       * short, or there is no supervisor to ask — does not open it. The kept store
       * is emptied instead and this launch boots exactly as a cold one does: the
       * rare failure costs a relaunch its speedup, never a stale byte.
       *
       * The previous process's own unacknowledged rows are the one thing the
       * reconcile cannot judge, since it keeps own rows whatever the listing says.
       * store.bind drops them before any of this runs.
       *
       * `takeBundle` hands over the module bundle and drops the module's own
       * reference to it. The parsed bundle is the largest allocation in the facet
       * before the program starts, so a cold boot releases it the moment it is
       * adopted, and a kept store that reconciles never adopts it at all. A cell
       * may be a getter that reads its text as it is taken (a node process's code
       * cells, read back from the module map); `moduleBytes`, when the launch
       * costed the bundle already, spares reading each twice.
       *
       * Returns the cursor to publish and, when the boot fell short of the whole
       * filesystem, why.
       */
      async boot(takeBundle, moduleCursor, supervisor, moduleBytes) {
        coherence.tables("boot");
        let failure = null;
        if (coherence.cursor() !== null) {
          let pass2 = null;
          try {
            pass2 = await synchronize(supervisor);
          } catch (e) {
            failure = messageOf(e);
          }
          if (pass2 && pass2.cursor) return { cursor: await catchUp(supervisor, pass2.cursor), failure: null };
          failure = "a kept store could not be reconciled (" + (failure || fail(pass2) || "the listing vouched for nothing") + "); it was emptied and this launch booted from its own snapshot";
        }
        cells.clear();
        const bundle = takeBundle();
        let bytes = moduleBytes;
        if (typeof bytes !== "number") {
          bytes = 0;
          for (const path of Object.keys(bundle || {})) bytes += residentCellCost(bundle[path]);
        }
        if (!await admission.ensureRoom(bytes)) {
          throw Object.assign(new Error(
            "ENOSPC: workspace storage is full: this process's modules (" + Math.ceil(bytes / 1048576) + " MiB) do not fit in what is left of the session's storage"
          ), { code: "ENOSPC" });
        }
        const adopted = adoptModuleBundle(bundle, moduleCursor);
        if (failure !== null) return { cursor: adopted, failure };
        let pass = null;
        try {
          pass = await synchronize(supervisor);
        } catch (e) {
          failure = messageOf(e);
        }
        if (pass && pass.cursor) return { cursor: await catchUp(supervisor, pass.cursor), failure };
        return { cursor: adopted, failure: failure || fail(pass) };
      },
      setPushRoots(roots) {
        pushRoots = (Array.isArray(roots) ? roots : []).map((r) => String(r).replace(/^\/+|\/+$/g, ""));
      },
      pushable,
      acquireOptions,
      applyAcquire,
      setPlan(paths) {
        plan = new Set(Array.isArray(paths) ? paths.map((p) => nsKey(p)) : []);
      },
      setManifests(given) {
        const files = given && typeof given === "object" && given.files && typeof given.files === "object" ? given.files : null;
        manifests = files === null ? null : new Map(Object.entries(files));
      },
      adoptModuleBundle,
      synchronize,
      /**
       * Refetch, after a delta the store applied without a listing, what it should
       * hold and does not: the paths the delta dropped and the launch's data plan.
       * The namespace (current as of that delta) gives each one's size and
       * revision, as a listing entry would.
       */
      async refillFromNamespace(supervisor, dropped) {
        const t = coherence.tables("refillFromNamespace");
        const cursor = coherence.cursor();
        if (cursor === null) return { requested: 0, filled: 0, failed: 0, bytes: 0 };
        const fetch = [];
        const seen = /* @__PURE__ */ new Set();
        for (const path of [...dropped, ...plan]) {
          if (seen.has(path)) continue;
          seen.add(path);
          if (cells.has(path)) continue;
          const row = nsRowAt(t, path);
          if (row === void 0 || row.kind !== NS_FILE) continue;
          fetch.push({ path, size: row.size, rev: row.rev, epoch: cursor.epoch, ckey: null, version: versionOf(row) });
        }
        return transport.fetchFiles(supervisor, fetch);
      },
      /**
       * The launch's last step before user code: the namespace must answer, since
       * every synchronous stat, exists and readdir reads it. A boot that left it
       * unready (its listing failed, came back short, or could not describe every
       * name) is repaired once more. Resolves to null when it answers, or to the
       * launch's failure, naming why; nothing is ever run on a namespace that
       * does not.
       */
      async requireNamespace(supervisor, bootFailure) {
        if (namespace.ready()) return null;
        let failure = bootFailure;
        try {
          const repaired = await synchronize(supervisor);
          failure = fail(repaired) || failure;
        } catch (e) {
          failure = messageOf(e);
        }
        if (namespace.ready()) return null;
        return "node: the process was not started: its view of the filesystem could not be listed (" + (failure || namespace.notReadyCause()) + ")";
      }
    };
  }
  function versionOf(row) {
    return { dev: row.dev, ino: row.ino, size: row.size, mtime: row.mtime, ctime: row.ctime, revision: row.rev };
  }

  // ../core/dist/vfs/composite.js
  var ANONYMOUS_DEV = 65536;
  var utf8 = new TextEncoder();

  // src/vfs/resident/index.ts
  function createResidentStore(options = {}) {
    const coherence = createCoherence();
    const admission = createAdmission(coherence);
    const namespace = createNamespace(coherence, admission);
    const observeRead = options.observeRead ?? null;
    const cells = createCells(coherence, admission, namespace, observeRead);
    const transport = createTransport(coherence, admission, namespace, cells);
    const sync = createSync(coherence, admission, namespace, cells, transport);
    const pages = createPages(coherence, admission);
    const lazy = createLazy(coherence, admission, namespace, cells, transport, sync, pages);
    const bindTables = (t, heap) => {
      t.dropOwn();
      coherence.bind(t, heap);
      namespace.bind(t);
      pages.reset();
    };
    return {
      bundle: cells.bundle,
      bind(ctx) {
        const sql = ctx?.storage?.sql;
        if (!sql || typeof sql.exec !== "function") {
          throw new Error(
            "Nimbus: this facet has no synchronous SQLite (ctx.storage.sql); the resident set cannot be served and every sync read would raise EAGAIN"
          );
        }
        bindTables(sqlTables(sql), null);
      },
      bindInMemory(budget) {
        const t = heapTables();
        bindTables(t, t);
        admission.bindHeap(budget);
      },
      observeRead,
      coherence,
      admission,
      namespace,
      cells,
      transport,
      sync,
      pages,
      lazy
    };
  }
  return __toCommonJS(index_exports);
})();
