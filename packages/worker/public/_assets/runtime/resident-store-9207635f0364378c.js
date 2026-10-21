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
    feedFor: () => feedFor,
    floorFor: () => floorFor,
    isFeedPosition: () => isFeedPosition,
    namespaceRowBytes: () => namespaceRowBytes,
    notAfter: () => notAfter,
    posixAccess: () => posixAccess,
    residentFileCost: () => residentFileCost,
    rootOf: () => rootOf,
    sameEpochs: () => sameEpochs,
    samePosition: () => samePosition,
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

  // nimbus-launch-captures:launch-captures
  var { ArrayBufferConstructor, ArrayConstructor, ArrayFrom, ArrayIteratorNext, ArrayIteratorPrototype, ArrayPrototypeIndexOf, ArrayPrototypeLastIndexOf, ArrayPrototypePop, ArrayPrototypeToSpliced, ArrayPrototypeWith, ArrayValues, BigInt, BigIntPrototypeToString, Error: Error2, FunctionPrototypeBind, GeneratorPrototypeNext, GeneratorPrototypeReturn, GeneratorPrototypeThrow, JSONParse, JSONStringify, MapConstructor, NumberOf, NumberPrototypeToString, ObjectOf, ObjectPrototype, ObjectPrototypeHasOwnProperty, ObjectPrototypePropertyIsEnumerable, ObjectPrototypePropertyIsEnumerableOf, ObjectPrototypeToString, PromiseConstructor, PromisePrototypeThen, PromiseReject, PromiseResolve, Proxy: Proxy2, RangeError, ReferenceError: ReferenceError2, RegExp, RegExpPrototypeAccessors, RegExpPrototypeExec, SafeAsyncGeneratorPrototype, SafeGeneratorPrototype, SafeList, SafeMap, SafeRegExpPrototype, SafeSet, SafeWeakMap, SafeWeakSet, StringFromCharCode, StringPrototypeCharAt, StringPrototypeCharCodeAt, StringPrototypeIndexOf, StringPrototypeLastIndexOf, StringPrototypeSlice, StringPrototypeSubstr, SymbolConstructor, SymbolPrototypeDescription, SymbolPrototypeToString, SyntaxError, TypeError: TypeError2, URIError, URL, Uint8ArrayConstructor, arrayBufferByteLength, arrayCopy, arrayIncludes, arrayIndexOf, arrayIsArray, arrayJoin, arrayPush, arrayShift, arraySort, arraySplice, captureStackTraceOf, dataDescriptor, dateNow, decodeURIComponentOf, encodeURIComponentOf, generatorNext, generatorThrow, globalObject, mapGet, mathAbs, mathCeil, mathFloor, mathMax, mathMin, newTextEncoder, newURL, numberIsInteger, numberIsSafeInteger, objectAssign, objectCreate, objectDefineProperties, objectDefineProperty, objectFreeze, objectGetOwnPropertyNames, objectHasOwn, objectIs, objectIsExtensible, objectKeys, objectPreventExtensions, ownField, parseFloatOf, parseIntOf, promiseAll, promiseSettled, reflectApply, reflectConstruct, reflectDefineProperty, reflectDeleteProperty, reflectGet, reflectGetOwnPropertyDescriptor, reflectGetPrototypeOf, reflectHas, reflectOwnKeys, reflectSet, reflectSetPrototypeOf, regExpExec, safeGenerator, setFind, setForEach, stringCharCodeAt, stringCodePointAt, stringEndsWith, stringIncludes, stringIndexOf, stringLastIndexOf, stringOf, stringSlice, stringStartsWith, stringToLowerCase, symbolAsyncIterator, symbolFor, symbolIterator, symbolToStringTag, symbolUnscopables, textEncoderEncode, textEncoderEncodeInto, typedArrayBuffer, typedArrayByteLength, typedArrayByteOffset, typedArraySet, useCaptureStackTrace } = __nimbusLaunchCaptures;

  // ../core/dist/constants.js
  var NODE_RELEASE = "22.23.4";
  var NODE_VERSION = `v${NODE_RELEASE}`;
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
  var RESIDENT_CHUNK_BYTES = 65536;
  var ONE_SHOT_STORE_MEMORY_BYTES = VFS_BUNDLE_MAX_BYTES + 16 * 1024 * 1024;

  // ../platform/dist/utf8.js
  var UTF8_LONG_UNITS = 256;
  var UTF8_SCRATCH_BYTES = 256 * 1024;
  var encoder = new TextEncoder();

  // src/vfs/resident/cell-cost.ts
  var encoder2;
  var scratch;
  function utf8Length(text) {
    if (text.length >= UTF8_LONG_UNITS) {
      scratch ??= new Uint8ArrayConstructor(UTF8_SCRATCH_BYTES);
      encoder2 ??= newTextEncoder();
      let bytes2 = 0;
      for (let read = 0; read < text.length; ) {
        const done = textEncoderEncodeInto(encoder2, read === 0 ? text : stringSlice(text, read), scratch);
        read += reflectGet(done, "read");
        bytes2 += reflectGet(done, "written");
      }
      return bytes2;
    }
    let bytes = text.length;
    for (let index = 0; index < text.length; index++) {
      const unit = stringCharCodeAt(text, index);
      if (unit < 128) continue;
      if (unit < 2048) bytes++;
      else if (unit >= 55296 && unit <= 56319 && index + 1 < text.length) {
        const next = stringCharCodeAt(text, index + 1);
        bytes += 2;
        if (next >= 56320 && next <= 57343) index++;
      } else bytes += 2;
    }
    return bytes;
  }
  var RESIDENT_ROW_BYTES = LEDGER_ROW_BYTES;
  function residentBytes(value) {
    if (value instanceof Uint8ArrayConstructor) return value;
    if (value instanceof ArrayBufferConstructor) return new Uint8ArrayConstructor(value);
    return new Uint8ArrayConstructor(0);
  }
  var TEXT_CHUNK_UNITS = mathFloor(RESIDENT_CHUNK_BYTES / 3);
  function textChunkEnds(text) {
    const ends = new SafeList();
    let at = 0;
    do {
      let end = mathMin(text.length, at + TEXT_CHUNK_UNITS);
      const last = stringCharCodeAt(text, end - 1);
      if (end < text.length && last >= 55296 && last <= 56319) end--;
      ends[ends.length] = end;
      at = end;
    } while (at < text.length);
    return arrayCopy(ends);
  }
  function residentCellCost(cell) {
    const isText = typeof cell === "string";
    const size = isText ? utf8Length(cell) : typedArrayByteLength(residentBytes(cell));
    const chunks = isText ? textChunkEnds(cell).length : mathMax(1, mathCeil(size / RESIDENT_CHUNK_BYTES));
    return mathCeil(size * 1.01) + (chunks + 1) * RESIDENT_ROW_BYTES + 4096;
  }
  function residentFileCost(size) {
    const chunks = mathMax(1, mathCeil(size / (TEXT_CHUNK_UNITS - 1)));
    return mathCeil(size * 1.01) + (chunks + 1) * RESIDENT_ROW_BYTES + 4096;
  }
  function namespaceRowBytes(parent, name, target) {
    return RESIDENT_ROW_BYTES + 2 * (stringOf(parent).length + stringOf(name).length + (target == null ? 0 : stringOf(target).length));
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
    const reservations = new SafeMap();
    let reservedBytes = 0;
    const reserveQueue = new SafeList();
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
            arrayShift(reserveQueue)?.resolve(true);
          }
          if (reserveQueue.length === 0) return;
          idle = reserveQueue.length < waiting ? 0 : idle + 1;
          const before = cap;
          if (idle <= 8) {
            let need = 0;
            for (let i = 0; i < reserveQueue.length; i++) need += reserveQueue[i].bytes;
            await askGrant(need);
          }
          if (cap === before) {
            const refused = new SafeList();
            for (let i = 0; i < reserveQueue.length; i++) refused[i] = reserveQueue[i];
            reserveQueue.length = 0;
            for (let i = 0; i < refused.length; i++) refused[i].resolve(false);
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
      const want = mathMax(0, dbBytes() + reservedBytes + bytes - cap);
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
        pinnedBytes = mathMax(0, pinnedBytes - bytes);
      },
      get heldBytes() {
        return heldBytes;
      },
      addHeld(bytes) {
        heldBytes += bytes;
      },
      heldLimit(maxBytes) {
        return inHeap ? mathMax(0, NumberOf(cap) - tablesBytes() - namespaceOverlayBytes - namespaceReserveBytes) : maxBytes;
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
          arrayPush(reserveQueue, { path, bytes, resolve });
          void serveReserves();
        });
      },
      release,
      fits,
      ensureRoom,
      /** Room for what an ACQUIRE answer pushes, asked for before it is applied. */
      async roomForPushed(result) {
        const answer = result;
        if (cap === null || !answer || !arrayIsArray(answer.paths)) return;
        const paths = answer.paths;
        let bytes = 0;
        for (let i = 0; i < paths.length; i++) {
          const entry = paths[i];
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
    const shift = cred.uid === entry.uid ? 6 : cred.gid === entry.gid || arrayIncludes(cred.groups, entry.gid) ? 3 : 0;
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
    if (gid !== null && (!owner || gid !== entry.gid && !arrayIncludes(cred.groups, gid)))
      return "EPERM";
    return null;
  }
  function chownedMode(mode, cred) {
    return cred.uid === 0 ? mode : mode & ~3072;
  }
  function utimesRefusal(entry, explicit, cred) {
    if (!explicit)
      return cred.uid === 0 || cred.uid === entry.uid || posixAccess(entry, 2, cred) ? null : "EACCES";
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

  // ../core/dist/runtime/feed-position.js
  var ROOT_FEED = "/";
  function feedsOf(position) {
    return position.feeds;
  }
  function feedOf(position, point) {
    const feeds = feedsOf(position);
    return objectHasOwn(feeds, point) ? feeds[point] : void 0;
  }
  function rootOf(position) {
    const root = feedOf(position, ROOT_FEED);
    if (root === void 0)
      throw new TypeError2("a feed position holds no root");
    return root;
  }
  function isFeedPosition(value) {
    if (value === null || typeof value !== "object")
      return false;
    const { table, feeds } = value;
    if (typeof table !== "string" || feeds === null || typeof feeds !== "object")
      return false;
    const points = objectKeys(feeds);
    for (let i = 0; i < points.length; i++) {
      const feed = feeds[points[i]];
      if (feed === null || typeof feed !== "object" || typeof feed.epoch !== "string" || typeof feed.cursor !== "number")
        return false;
    }
    return objectHasOwn(feeds, ROOT_FEED);
  }
  function samePosition(a, b) {
    if (a.table !== b.table)
      return false;
    const x = feedsOf(a);
    const y = feedsOf(b);
    const points = objectKeys(x);
    if (points.length !== objectKeys(y).length)
      return false;
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      if (!objectHasOwn(y, point) || x[point].epoch !== y[point].epoch || x[point].cursor !== y[point].cursor)
        return false;
    }
    return true;
  }
  function feedPointOf(position, key) {
    const path = key.length > 0 && stringCharCodeAt(key, 0) === 47 ? key : "/" + key;
    const points = objectKeys(feedsOf(position));
    let found = ROOT_FEED;
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      if (point.length > found.length && (path === point || path.length > point.length && stringStartsWith(path, point) && stringCharCodeAt(path, point.length) === 47))
        found = point;
    }
    return found;
  }
  function notAfter(position, held) {
    if (position.table !== held.table)
      return false;
    const feeds = feedsOf(position);
    const points = objectKeys(feeds);
    for (let i = 0; i < points.length; i++) {
      const had = feedOf(held, points[i]);
      if (had === void 0 || had.epoch !== feeds[points[i]].epoch || had.cursor < feeds[points[i]].cursor)
        return false;
    }
    return true;
  }
  function floorFor(position, held, key) {
    if (position.table !== held.table)
      return -1;
    const point = feedPointOf(position, key);
    const mine = feedOf(position, point);
    const had = feedOf(held, point);
    return mine !== void 0 && had !== void 0 && had.epoch === mine.epoch ? had.cursor : -1;
  }
  function sameEpochs(a, b) {
    if (a.table !== b.table)
      return false;
    const x = feedsOf(a);
    const y = feedsOf(b);
    const points = objectKeys(x);
    if (points.length !== objectKeys(y).length)
      return false;
    for (let i = 0; i < points.length; i++) {
      if (!objectHasOwn(y, points[i]) || x[points[i]].epoch !== y[points[i]].epoch)
        return false;
    }
    return true;
  }
  function feedFor(position, key) {
    return feedOf(position, feedPointOf(position, key)) ?? rootOf(position);
  }
  function sameClock(a, b, key) {
    const point = feedPointOf(a, key);
    if (feedPointOf(b, key) !== point)
      return false;
    const x = feedOf(a, point);
    const y = feedOf(b, point);
    return x !== void 0 && y !== void 0 && x.epoch === y.epoch;
  }
  function rootEpochFor(position, key) {
    return feedPointOf(position, key) === ROOT_FEED ? rootOf(position).epoch : null;
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
  function heapTables(rowsChanged = () => {
  }) {
    const writeRows = (path, write) => {
      rowsChanged(path);
      write();
    };
    const files = new SafeMap();
    const chunks = new SafeMap();
    const meta = new SafeMap();
    const ns = new SafeMap();
    const byKey = new SafeMap();
    const pages = new SafeMap();
    const pageKey = (path, rev, part) => path + "\0" + rev + "\0" + part;
    let sorted = null;
    let used = 0;
    let names = 0;
    let namespaceBytes = 0;
    const cmp = (a, b) => {
      const n = mathMin(a.length, b.length);
      for (let i = 0; i < n; i++) {
        const x = stringCodePointAt(a, i) ?? 0, y = stringCodePointAt(b, i) ?? 0;
        if (x !== y) return x < y ? -1 : 1;
        if (x > 65535) i++;
      }
      return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
    };
    const payload = (cell) => cell.txt != null ? utf8Length(cell.txt) : cell.bin ? typedArrayByteLength(cell.bin) : 0;
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
      if (sorted === null) {
        const list = new SafeList();
        files.forEach((_row, path) => {
          list[list.length] = path;
        });
        sorted = arraySort(list, cmp);
      }
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
      const out = new SafeList();
      for (let i = lowerBound(list, from); i < list.length && (to === null || cmp(list[i], to) < 0); i++) out[out.length] = list[i];
      return out;
    };
    const copy = (cell) => ({ txt: cell.txt ?? null, bin: cell.bin ? new Uint8ArrayConstructor(cell.bin) : null });
    const owned = (bin) => {
      const bytes = residentBytes(bin);
      return typedArrayByteOffset(bytes) === 0 && typedArrayByteLength(bytes) === arrayBufferByteLength(typedArrayBuffer(bytes)) ? bytes : new Uint8ArrayConstructor(bytes);
    };
    const dropChunks = (path) => {
      const parts = chunks.get(path);
      if (!parts) return;
      parts.forEach((cell) => {
        used -= RESIDENT_ROW_BYTES + payload(cell);
      });
      chunks.delete(path);
    };
    const dropFile = (path) => writeRows(path, () => {
      const row = files.get(path);
      if (row === void 0) return;
      unkey(path, row);
      files.delete(path);
      sorted = null;
      used -= RESIDENT_ROW_BYTES;
    });
    const addChunk = (path, part, cell, replace) => {
      let parts = chunks.get(path);
      if (!parts) {
        parts = new SafeMap();
        chunks.set(path, parts);
      }
      const had = parts.get(part);
      if (had !== void 0) {
        if (!replace) throw new Error2("UNIQUE constraint failed: chunk.path, chunk.part");
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
      dir.forEach((row, name) => {
        const bytes = namespaceRowBytes(parent, name, row.target);
        used -= bytes;
        namespaceBytes -= bytes;
      });
      ns.delete(parent);
    };
    const dropWhere = (keepFile, keepChunkPath) => writeRows(void 0, () => {
      chunks.forEach((_parts, path) => {
        if (!keepChunkPath(path)) dropChunks(path);
      });
      files.forEach((row, path) => {
        if (!keepFile(row)) dropFile(path);
      });
    });
    const sortedNames = (dir) => {
      const out = new SafeList();
      dir.forEach((_row, name) => {
        out[out.length] = name;
      });
      return arraySort(out, cmp);
    };
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
        meta.set(k, stringOf(v));
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
        if (!(rev >= -1)) throw new Error2("CHECK constraint failed: rev >= -1");
        writeRows(path, () => {
          const had = files.get(path);
          if (had === void 0) {
            sorted = null;
            used += RESIDENT_ROW_BYTES;
          } else unkey(path, had);
          const row = { kind: NumberOf(kind), size: NumberOf(size), chunks: NumberOf(chunkCount), rev: NumberOf(rev), ckey: ckey == null ? null : stringOf(ckey) };
          files.set(path, row);
          if (row.ckey !== null) {
            let set = byKey.get(row.ckey);
            if (!set) {
              set = new SafeSet();
              byKey.set(row.ckey, set);
            }
            set.add(path);
          }
        });
      },
      fileSetRev(path, rev) {
        writeRows(path, () => {
          const row = files.get(path);
          if (row !== void 0) row.rev = NumberOf(rev);
        });
      },
      fileStampOwn(path, rev) {
        writeRows(path, () => {
          const row = files.get(path);
          if (row !== void 0 && row.rev === RK_OWN_WRITE) row.rev = NumberOf(rev);
        });
      },
      fileDelete(path) {
        dropFile(path);
      },
      fileByKey(ckey, notPath) {
        const set = byKey.get(stringOf(ckey));
        if (!set) return void 0;
        const path = setFind(set, (candidate) => {
          const row2 = files.get(candidate);
          return candidate !== notPath && row2 !== void 0 && row2.rev >= 0;
        });
        const row = path === void 0 ? void 0 : files.get(path);
        return path === void 0 || row === void 0 ? void 0 : { path, kind: row.kind, size: row.size, chunks: row.chunks };
      },
      filePaths(from, to) {
        return arrayCopy(inRange(from, to));
      },
      fileAny(from, to) {
        const list = paths();
        const i = lowerBound(list, from);
        return i < list.length && (to === null || cmp(list[i], to) < 0);
      },
      fileRevsIn(from, to) {
        const list = inRange(from, to);
        const out = new SafeList();
        for (let i = 0; i < list.length; i++) {
          const path = list[i];
          const row = files.get(path);
          if (row !== void 0) out[out.length] = { path, rev: row.rev };
        }
        return arrayCopy(out);
      },
      fileAllPaths() {
        return arrayCopy(paths());
      },
      fileRows() {
        const list = paths();
        const out = new SafeList();
        for (let i = 0; i < list.length; i++) {
          const path = list[i];
          const row = files.get(path);
          if (row !== void 0) out[out.length] = { path, rev: row.rev, ckey: row.ckey };
        }
        return arrayCopy(out);
      },
      fileOwnPaths() {
        const list = paths();
        const out = new SafeList();
        for (let i = 0; i < list.length; i++) if (files.get(list[i])?.rev === RK_OWN_WRITE) out[out.length] = list[i];
        return arrayCopy(out);
      },
      fileStats() {
        let b = 0;
        files.forEach((row) => {
          b += row.size;
        });
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
        const numbers = new SafeList();
        parts.forEach((_cell, part) => {
          numbers[numbers.length] = part;
        });
        arraySort(numbers, (a, b) => a - b);
        const out = new SafeList();
        for (let i = 0; i < numbers.length; i++) {
          const cell = parts.get(numbers[i]);
          if (cell !== void 0) out[out.length] = copy(cell);
        }
        return arrayCopy(out);
      },
      chunkAddText(path, part, txt) {
        addChunk(path, NumberOf(part), { txt: stringOf(txt), bin: null }, false);
      },
      chunkAddBin(path, part, bin) {
        addChunk(path, NumberOf(part), { txt: null, bin: owned(bin) }, false);
      },
      chunkSetBin(path, part, bin) {
        addChunk(path, NumberOf(part), { txt: null, bin: owned(bin) }, true);
      },
      chunkCopy(to, from) {
        const parts = chunks.get(from);
        if (!parts) return;
        const held = chunks.get(to);
        if (held) parts.forEach((_cell, part) => {
          if (held.has(part)) throw new Error2("UNIQUE constraint failed: chunk.path, chunk.part");
        });
        parts.forEach((cell, part) => {
          addChunk(to, part, { txt: cell.txt, bin: cell.bin }, false);
        });
      },
      chunkDelete(path) {
        writeRows(path, () => {
          dropChunks(path);
        });
      },
      dropOwn() {
        const own = new SafeSet();
        files.forEach((row, path) => {
          if (row.rev === RK_OWN_WRITE) own.add(path);
        });
        dropWhere((row) => row.rev !== RK_OWN_WRITE, (path) => !own.has(path));
      },
      dropDated() {
        const own = new SafeSet();
        files.forEach((row, path) => {
          if (row.rev === RK_OWN_WRITE) own.add(path);
        });
        dropWhere((row) => row.rev === RK_OWN_WRITE, (path) => own.has(path));
      },
      dropDatedFiles() {
        const dated = new SafeSet();
        files.forEach((row, path) => {
          if (row.rev !== RK_OWN_WRITE) dated.add(path);
        });
        dropWhere((row) => row.rev === RK_OWN_WRITE, (path) => !dated.has(path));
      },
      clear() {
        writeRows(void 0, () => {
          files.clear();
          chunks.clear();
        });
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
          dir = new SafeMap();
          ns.set(parent, dir);
        }
        if (previous === void 0) names++;
        used += growth;
        namespaceBytes += growth;
        dir.set(name, {
          kind: NumberOf(kind),
          size: NumberOf(size),
          mode: NumberOf(mode),
          uid: NumberOf(uid),
          gid: NumberOf(gid),
          atime: NumberOf(atime),
          mtime: NumberOf(mtime),
          ctime: NumberOf(ctime),
          ino: NumberOf(ino),
          rev: NumberOf(rev),
          target: target == null ? null : stringOf(target),
          dev: NumberOf(dev) || 0,
          nlink: NumberOf(nlink) || 1
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
        ns.forEach((_dir, parent) => {
          if (cmp(parent, from) >= 0 && (to === null || cmp(parent, to) < 0)) nsDropParent(parent);
        });
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
        const out = new SafeList();
        const parents = sortedNames(ns);
        for (let i = 0; i < parents.length; i++) {
          const parent = parents[i];
          const dir = ns.get(parent);
          if (dir === void 0) continue;
          const list = sortedNames(dir);
          for (let j = 0; j < list.length; j++) out[out.length] = { parent, name: list[j] };
        }
        return arrayCopy(out);
      },
      nsOfKind(kind) {
        const out = new SafeList();
        const parents = sortedNames(ns);
        const code = NumberOf(kind);
        for (let i = 0; i < parents.length; i++) {
          const parent = parents[i];
          const dir = ns.get(parent);
          if (dir === void 0) continue;
          const list = sortedNames(dir);
          for (let j = 0; j < list.length; j++) {
            const name = list[j];
            if (dir.get(name)?.kind === code) out[out.length] = { parent, name };
          }
        }
        return arrayCopy(out);
      },
      nsUnlisted() {
        const out = new SafeList();
        const parents = sortedNames(ns);
        for (let i = 0; i < parents.length; i++) {
          const parent = parents[i];
          const dir = ns.get(parent);
          if (dir === void 0) continue;
          const list = sortedNames(dir);
          for (let j = 0; j < list.length; j++) {
            const name = list[j];
            const row = dir.get(name);
            if (row !== void 0 && row.kind === NS_DIR && row.target !== null) out[out.length] = { parent, name, target: row.target };
          }
        }
        return arrayCopy(out);
      },
      nsChildren(parent) {
        const dir = ns.get(parent);
        if (!dir) return [];
        const list = sortedNames(dir);
        const out = new SafeList();
        for (let i = 0; i < list.length; i++) {
          const name = list[i];
          const row = dir.get(name);
          if (row !== void 0) out[out.length] = { name, kind: row.kind, mode: row.mode };
        }
        return arrayCopy(out);
      },
      nsCount() {
        return names;
      }
    };
  }

  // src/vfs/resident/namespace-lookup.ts
  var NS_MAX_HOPS = 40;
  var removed = (word) => objectHasOwn(word, "absent");
  var linked = (word) => objectHasOwn(word, "target");
  var moved = (word) => objectHasOwn(word, "from");
  function standing(t, step, word) {
    if (word === void 0 || !moved(word) || word.from === void 0) return word;
    const ino = ownField(word, "ino");
    if (typeof ino !== "number") return word;
    const dev = ownField(word, "dev");
    const named = ownField(word, "link");
    const link = typeof named === "string" ? named : void 0;
    const holds = (k) => {
      const row = nsRowAt(t, k);
      return row !== void 0 && row.ino === ino && (typeof dev !== "number" || row.dev === dev);
    };
    if (holds(link ?? word.from)) return word;
    if (step !== null && holds(step)) return void 0;
    const via = ownField(word, "via");
    if (arrayIsArray(via)) {
      for (let i = 0; i < via.length; i++) {
        const at = stringOf(via[i]);
        if (holds(at)) return link === void 0 ? { from: at } : { from: word.from, link: at };
      }
    }
    return word;
  }
  function nsParent(k) {
    const i = stringLastIndexOf(k, "/");
    return i < 0 ? "" : stringSlice(k, 0, i);
  }
  function nsName(k) {
    return stringSlice(k, stringLastIndexOf(k, "/") + 1);
  }
  function nsKey(path) {
    const text = stringOf(path);
    let at = 0;
    while (at < text.length && stringCharCodeAt(text, at) === 47) at++;
    return at === 0 ? text : stringSlice(text, at);
  }
  function nsRowAt(t, k) {
    if (k === "") {
      return { kind: NS_DIR, size: 0, mode: 16877, uid: 0, gid: 0, atime: 0, mtime: 0, ctime: 0, ino: 1, rev: 0, target: null, dev: 0, nlink: 1 };
    }
    const i = stringLastIndexOf(k, "/");
    return i < 0 ? t.nsGet("", k) : t.nsGet(stringSlice(k, 0, i), stringSlice(k, i + 1));
  }
  function joinTarget(linkPath, target) {
    const text = stringOf(target);
    const out = new SafeList();
    const names = (path, reduce) => {
      for (let start = 0; start <= path.length; ) {
        let stop = stringIndexOf(path, "/", start);
        if (stop < 0) stop = path.length;
        const name = stringSlice(path, start, stop);
        start = stop + 1;
        if (name === "") continue;
        if (reduce && name === "..") {
          if (out.length > 0) out.length--;
        } else if (!reduce || name !== ".") out[out.length] = name;
      }
    };
    if (stringCharCodeAt(text, 0) !== 47) names(nsParent(linkPath), false);
    names(text, true);
    return arrayJoin(out, "/");
  }
  function walkNamespace(t, links, k, followLeaf, own, visit) {
    if (own === void 0 && links.size === 0 && visit === void 0) return { path: k, table: k, row: nsRowAt(t, k) };
    let path = k;
    walk: for (let hops = 0; hops <= NS_MAX_HOPS; hops++) {
      let table = "";
      for (let start = 0, more = path !== ""; more; ) {
        let stop = stringIndexOf(path, "/", start);
        const leaf = stop < 0;
        if (leaf) stop = path.length;
        const name = stringSlice(path, start, stop);
        const prefix = stringSlice(path, 0, stop);
        more = !leaf;
        start = stop + 1;
        if (visit !== void 0 && !visit(prefix)) return "EACCES";
        const step = table === null ? null : table ? `${table}/${name}` : name;
        const word = own === void 0 ? void 0 : standing(t, step, own(prefix));
        let target;
        if (word !== void 0 && removed(word)) {
          return { path, table: null, row: void 0, own: word };
        } else if (word !== void 0 && linked(word)) {
          if (leaf && !followLeaf) return { path, table: null, row: void 0, own: word };
          target = word.target;
        } else if (word !== void 0 && moved(word)) {
          const named = ownField(word, "link");
          const link = typeof named === "string" ? named : void 0;
          if (link !== void 0 && leaf && !followLeaf) {
            const at = nsRowAt(t, link) !== void 0 ? link : step;
            return { path, table: at, row: at === null ? void 0 : nsRowAt(t, at), own: word };
          }
          if (word.from === void 0) return { path, table: null, row: void 0, own: { absent: true } };
          if (link !== void 0) target = `/${word.from}`;
          else {
            table = word.from;
            if (leaf) return { path, table, row: nsRowAt(t, table), own: word };
            continue;
          }
        } else if (word !== void 0) {
          table = ownField(word, "hide") === true ? null : prefix;
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
        const rest = leaf ? "" : stringSlice(path, stop + 1);
        const reached = joinTarget(prefix, target);
        path = rest ? reached ? `${reached}/${rest}` : rest : reached;
        continue walk;
      }
      return { path, table, row: table === null ? void 0 : nsRowAt(t, table) };
    }
    return "ELOOP";
  }

  // src/vfs/resident/namespace.ts
  function nsKindCode(type) {
    return type === "directory" ? NS_DIR : type === "symlink" ? NS_LINK : NS_FILE;
  }
  function ownValue(record, key) {
    return objectHasOwn(record, key) ? record[key] : void 0;
  }
  function nsDescribes(stat) {
    if (stat === null || typeof stat !== "object" && typeof stat !== "function" || typeof ownField(stat, "type") !== "string") return false;
    const mode = ownField(stat, "mode");
    const uid = ownField(stat, "uid");
    const gid = ownField(stat, "gid");
    return mode !== null && mode !== void 0 && numberIsInteger(NumberOf(mode)) && uid !== null && uid !== void 0 && numberIsInteger(NumberOf(uid)) && gid !== null && gid !== void 0 && numberIsInteger(NumberOf(gid));
  }
  function prefixEnd(prefix) {
    for (let i = prefix.length - 1; i >= 0; i--) {
      const code = stringCharCodeAt(prefix, i);
      if (code < 65535) return stringSlice(prefix, 0, i) + StringFromCharCode(code + 1);
    }
    return null;
  }
  function createNamespace(coherence, admission) {
    const realNow = dateNow;
    let links = new SafeSet();
    let putListener = null;
    let unlisted = new SafeMap();
    let cred = null;
    let ok = false;
    let cause = "the process has not listed it yet";
    let lazy = false;
    const listed = new SafeSet();
    let generation = 0;
    let root;
    const learnings = new SafeSet();
    const ready = () => ok && coherence.serving();
    let relisting = new SafeMap();
    const fenced = (k) => {
      if (relisting.size === 0) return false;
      let hit = false;
      relisting.forEach((_count, dir) => {
        if (!hit && (dir === "" || k === dir || stringStartsWith(k, dir + "/"))) hit = true;
      });
      return hit;
    };
    const isListed = (dir) => {
      if (lazy) return listed.has(dir);
      if (!ready() || fenced(dir) || unlisted.get(dir) !== void 0) return false;
      if (dir === "") return true;
      const row = nsRowAt(coherence.require(), dir);
      return row !== void 0 && row.kind === NS_DIR;
    };
    const markListed = (dir) => {
      if (lazy) {
        listed.add(dir);
        return;
      }
      if (dir === "" || unlisted.get(dir) === void 0) return;
      const t = coherence.require();
      const row = nsRowAt(t, dir);
      if (row === void 0 || row.kind !== NS_DIR) return;
      t.nsPut(nsParent(dir), nsName(dir), row.kind, row.size, row.mode, row.uid, row.gid, row.atime, row.mtime, row.ctime, row.ino, row.rev, null, row.dev, row.nlink);
      unlisted.delete(dir);
    };
    const learnedMark = (k) => {
      for (let at = nsParent(k); ; at = nsParent(at)) {
        const mount = unlisted.get(at);
        if (mount !== void 0 && mount !== at) return mount;
        if (at === "") return k;
      }
    };
    const markReady = (t, isReady, why) => {
      t.metaSet("ns", isReady ? "1" : "0");
      ok = !!isReady;
      if (!isReady) {
        cause = stringOf(why || "a change it could not follow");
        generation++;
      }
    };
    const refuse = (t, why) => {
      markReady(t, false, why);
      throw objectAssign(new Error2(why), { code: "ENOSPC" });
    };
    const unlistedOver = (k, self) => {
      if (unlisted.size === 0) return null;
      const t = coherence.require();
      for (let at = self ? k : nsParent(k); at !== ""; at = nsParent(at)) {
        const mount = unlisted.get(at);
        if (mount !== void 0) return mount;
        const row = nsRowAt(t, at);
        if (row && row.kind === NS_DIR) return null;
      }
      return null;
    };
    const setRoot = (stat, rev) => {
      root = {
        kind: NS_DIR,
        size: NumberOf(stat.size) || 0,
        mode: NumberOf(stat.mode) || 0,
        uid: NumberOf(stat.uid) || 0,
        gid: NumberOf(stat.gid) || 0,
        atime: NumberOf(stat.atime) || 0,
        mtime: NumberOf(stat.mtime) || 0,
        ctime: NumberOf(stat.ctime) || 0,
        ino: NumberOf(stat.ino) || 0,
        rev: NumberOf(rev) || 0,
        target: null,
        dev: NumberOf(ownValue(stat, "dev")) || 0,
        nlink: NumberOf(ownValue(stat, "nlink")) || 1
      };
    };
    const put = (t, k, stat, rev, target, unlistedAt) => {
      const parent = nsParent(k);
      const name = nsName(k);
      const kind = nsKindCode(stat.type);
      const mount = kind !== NS_DIR ? null : unlistedAt === void 0 ? unlisted.get(k) ?? null : unlistedAt;
      const stored = kind === NS_LINK ? stringOf(target ?? "") : mount;
      const heap = coherence.heap;
      if (heap !== null && admission.inHeap) {
        const refused = admission.rowRefusal(heap.nsGrowth(parent, name, stored));
        if (refused !== null) refuse(t, refused);
      }
      const ino = NumberOf(stat.ino) || 0;
      const dev = NumberOf(ownValue(stat, "dev")) || 0;
      t.nsPut(
        parent,
        name,
        kind,
        NumberOf(stat.size) || 0,
        NumberOf(stat.mode) || 0,
        NumberOf(stat.uid) || 0,
        NumberOf(stat.gid) || 0,
        NumberOf(stat.atime) || 0,
        NumberOf(stat.mtime) || 0,
        NumberOf(stat.ctime) || 0,
        ino,
        NumberOf(rev) || 0,
        stored,
        dev,
        NumberOf(ownValue(stat, "nlink")) || 1
      );
      if (kind === NS_LINK) links.add(k);
      else links.delete(k);
      if (mount !== null) unlisted.set(k, mount);
      else unlisted.delete(k);
      putListener?.(k, dev, ino);
    };
    const tryPut = (t, k, stat, rev, target, unlistedAt) => {
      try {
        put(t, k, stat, rev, target, unlistedAt);
        return true;
      } catch (error) {
        if (admission.inHeap && error !== null && (typeof error === "object" || typeof error === "function") && ownField(error, "code") === "ENOSPC") return false;
        throw error;
      }
    };
    const forgetListed = (dir) => {
      const prefix = dir === "" ? "" : dir + "/";
      listed.forEach((done) => {
        if (done === dir || stringStartsWith(done, prefix)) listed.delete(done);
      });
    };
    const deleteTree = (t, k, self) => {
      if (lazy) forgetListed(k);
      if (k === "") {
        t.nsClear();
        links = new SafeSet();
        unlisted = new SafeMap();
        return;
      }
      const prefix = k + "/";
      const end = prefixEnd(prefix);
      t.nsDeleteChildren(k);
      t.nsDeleteParents(prefix, end);
      if (self) {
        const parent = nsParent(k);
        const name = nsName(k);
        t.nsDelete(parent, name);
        links.delete(k);
        unlisted.delete(k);
      }
      links.forEach((link) => {
        if (stringStartsWith(link, prefix)) links.delete(link);
      });
      unlisted.forEach((_mount, dir) => {
        if (stringStartsWith(dir, prefix)) unlisted.delete(dir);
      });
    };
    const forget = (t, k) => {
      const parent = nsParent(k);
      const name = nsName(k);
      t.nsDelete(parent, name);
      links.delete(k);
      unlisted.delete(k);
    };
    function lookup(k, followLeaf, own, visit) {
      return walkNamespace(coherence.require(), links, k, followLeaf, own, visit);
    }
    const traversable = (row) => {
      if (!row || row.kind !== NS_DIR) return false;
      return namespaceAllows(cred, row, "directory", 1);
    };
    const children = (k) => {
      const rows = coherence.require().nsChildren(k);
      const out = new SafeList();
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        out[out.length] = { name: stringOf(row.name), kind: NumberOf(row.kind), mode: NumberOf(row.mode) };
      }
      return arrayCopy(out);
    };
    return {
      bind(t) {
        links = new SafeSet();
        const linkRows = t.nsOfKind(NS_LINK);
        for (let i = 0; i < linkRows.length; i++) {
          const row = linkRows[i];
          const parent = stringOf(row.parent);
          links.add(parent ? parent + "/" + stringOf(row.name) : stringOf(row.name));
        }
        unlisted = new SafeMap();
        const unlistedRows = t.nsUnlisted();
        for (let i = 0; i < unlistedRows.length; i++) {
          const row = unlistedRows[i];
          const parent = stringOf(row.parent);
          unlisted.set(parent ? parent + "/" + stringOf(row.name) : stringOf(row.name), stringOf(row.target));
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
      root: () => root,
      setRoot,
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
        if (found === "ELOOP" || ownValue(found, "own") !== void 0 || found.table === null) return null;
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
        if (!stat || !numberIsInteger(NumberOf(ownValue(stat, "mode"))) || !numberIsInteger(NumberOf(ownValue(stat, "uid"))) || !numberIsInteger(NumberOf(ownValue(stat, "gid")))) return false;
        return namespaceAllows(cred, stat, "file", 4);
      },
      /**
       * Apply one delta entry that carries a stat. Returns a directory whose
       * subtree an enumerated namespace must relist — one that just became
       * searchable, whose descendants no delta names — or null.
       */
      applyEntry(t, entry) {
        const k = nsKey(entry.path);
        const moved2 = (beneath) => {
          learnings.forEach((asked) => {
            asked.reported[asked.reported.length] = { at: k, beneath };
          });
        };
        if (k === "") {
          moved2(true);
          const stat2 = ownValue(entry, "stat");
          if (stat2) setRoot(stat2, entry.rev);
          return null;
        }
        const stat = ownValue(entry, "stat");
        if (stat === null) {
          moved2(true);
          deleteTree(t, k, true);
          return null;
        }
        const before = nsRowAt(t, k);
        if (stat === void 0 || !tryPut(t, k, stat, entry.rev, ownValue(entry, "linkTarget"))) {
          moved2(true);
          return null;
        }
        const after = nsRowAt(t, k);
        if (after === void 0 || after.kind !== NS_DIR) {
          moved2(true);
          deleteTree(t, k, false);
          return null;
        }
        const was = before !== void 0 && traversable(before);
        const now = traversable(after);
        moved2(!(before !== void 0 && before.kind === NS_DIR && before.ino === after.ino && before.dev === after.dev && was === now && !ownValue(entry, "structural") && !ownValue(entry, "subtree")));
        if (lazy) {
          if (ownValue(entry, "structural") || ownValue(entry, "subtree") || was !== now) deleteTree(t, k, false);
          return null;
        }
        if (was && !now) deleteTree(t, k, false);
        if (!was && now && before !== void 0) return k;
        return null;
      },
      /**
       * Bring the table to a complete listing: upsert what differs, delete what the
       * listing no longer names. Called once per enumeration, after its last page.
       */
      replace(t, entries) {
        generation++;
        relisting = new SafeMap();
        const names = new SafeSet();
        for (let i = 0; i < entries.length; i++) names.add(nsKey(entries[i].path));
        const rows = t.nsKeys();
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const parent = stringOf(row.parent);
          const k = parent ? parent + "/" + stringOf(row.name) : stringOf(row.name);
          if (!names.has(k)) forget(t, k);
        }
        if (admission.inHeap) {
          for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const k = nsKey(entry.path);
            if (!k) continue;
            const parent = nsParent(k);
            const name = nsName(k);
            const held = t.nsGet(parent, name);
            const linkTarget = ownValue(entry, "linkTarget");
            const unlistedAt = ownValue(entry, "unlisted");
            if (held && namespaceRowBytes(parent, name, held.target) > namespaceRowBytes(parent, name, linkTarget ?? unlistedAt)) {
              put(t, k, entry.stat, entry.rev, linkTarget, unlistedAt ?? null);
            }
          }
        }
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const k = nsKey(entry.path);
          if (k === "") continue;
          names.add(k);
          const held = nsRowAt(t, k);
          const s = entry.stat;
          const linkTarget = ownValue(entry, "linkTarget");
          const unlistedAt = ownValue(entry, "unlisted");
          if (held !== void 0 && held.kind === nsKindCode(s.type) && held.size === NumberOf(s.size) && held.mode === NumberOf(s.mode) && held.uid === NumberOf(s.uid) && held.gid === NumberOf(s.gid) && held.mtime === NumberOf(s.mtime) && held.ctime === NumberOf(s.ctime) && held.ino === NumberOf(s.ino) && held.dev === (NumberOf(s.dev) || 0) && held.rev === NumberOf(entry.rev) && (held.target ?? null) === (linkTarget ?? unlistedAt ?? null)) continue;
          put(t, k, s, entry.rev, linkTarget, unlistedAt ?? null);
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
        const slash = stringLastIndexOf(k, "/");
        const parent = held === void 0 ? nsRowAt(t, slash < 0 ? "" : stringSlice(k, 0, slash)) : void 0;
        tryPut(t, k, {
          type: "file",
          size,
          mode: held ? held.mode : 33206 & ~NumberOf((cred === null ? void 0 : ownValue(cred, "umask")) ?? 18),
          uid: held ? held.uid : NumberOf(cred === null ? 0 : cred.uid),
          gid: held ? held.gid : NumberOf(cred === null ? 0 : cred.gid),
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
        const now = feedFor(cursor, k).cursor;
        if (held !== void 0 && (written === void 0 ? held.rev >= now : held.rev > written)) return;
        if (stat === null) {
          if (held !== void 0) forget(t, k);
          return;
        }
        if (!nsDescribes(stat)) return;
        const target = ownValue(stat, "linkTarget") ?? ownValue(stat, "target") ?? null;
        if (stat.type === "symlink" && target === null) return;
        tryPut(t, k, stat, written ?? now, target);
      },
      clear() {
        generation++;
        root = void 0;
        relisting = new SafeMap();
        links = new SafeSet();
        unlisted = new SafeMap();
        ok = false;
      },
      get lazy() {
        return lazy;
      },
      beginLazy() {
        generation++;
        root = void 0;
        relisting = new SafeMap();
        lazy = true;
        listed.clear();
        links = new SafeSet();
        unlisted = new SafeMap();
      },
      listedAt(k) {
        return isListed(nsParent(k));
      },
      isListed,
      markListed,
      learn(t, k, stat, rev, target) {
        if (lazy || stat.type !== "directory" || nsRowAt(t, k) !== void 0) return tryPut(t, k, stat, rev, target);
        return tryPut(t, k, stat, rev, target, learnedMark(k));
      },
      fence(dir) {
        relisting.set(dir, (relisting.get(dir) ?? 0) + 1);
      },
      relisted(dir) {
        const count = relisting.get(dir) ?? 0;
        if (count <= 1) relisting.delete(dir);
        else relisting.set(dir, count - 1);
        if (!lazy && unlisted.get(dir) === dir) markListed(dir);
      },
      fenced,
      spoilLearnings() {
        generation++;
      },
      onPut(listener) {
        putListener = listener;
      },
      learning() {
        const asked = { generation, reported: new SafeList() };
        learnings.add(asked);
        const named = (k, beneath) => {
          for (let i = 0; i < asked.reported.length; i++) {
            const { at, beneath: under } = asked.reported[i];
            if (at === k || under && (at === "" || stringStartsWith(k, at + "/")) || beneath && (k === "" || stringStartsWith(at, k + "/"))) return true;
          }
          return false;
        };
        return {
          installs: (k) => asked.generation === generation && !named(k, false),
          lists: (dir) => asked.generation === generation && !named(dir, true),
          end: () => {
            learnings.delete(asked);
          }
        };
      }
    };
  }

  // src/vfs/resident/cells.ts
  function ownValue2(record, key) {
    return objectHasOwn(record, key) ? record[key] : void 0;
  }
  function createCells(coherence, admission, namespace, observeRead) {
    const held = new SafeMap();
    const unheld = new SafeSet();
    const cellSize = (cell) => typeof cell === "string" ? cell.length * 3 : typedArrayByteLength(residentBytes(cell));
    const encoder3 = newTextEncoder();
    const encodeText = (text) => textEncoderEncode(encoder3, text);
    const sameBytes = (a, b, from = 0, to) => {
      const size = typedArrayByteLength(b);
      const start = mathMin(from, size);
      const length = mathMax(0, (to === void 0 ? size : mathMin(to, size)) - start);
      if (typedArrayByteLength(a) !== length) return false;
      for (let i = 0; i < length; i++) if (a[i] !== b[start + i]) return false;
      return true;
    };
    const holds = (t, path, incoming) => {
      if (typeof incoming === "object" && objectHasOwn(incoming, "error")) return false;
      const found = t.fileHead(path);
      if (found === void 0) {
        const cell = held.get(path)?.cell;
        if (cell === void 0 || typeof cell === "object" && objectHasOwn(cell, "error")) return false;
        if (typeof cell === "string" && typeof incoming === "string") return cell === incoming;
        return sameBytes(typeof cell === "string" ? encodeText(cell) : residentBytes(cell), typeof incoming === "string" ? encodeText(incoming) : residentBytes(incoming));
      }
      if (found.kind === RK_DENIED) return false;
      const rows = () => {
        if (found.chunks !== 1) return t.chunkParts(path);
        const out = new SafeList();
        out[out.length] = t.chunkFirst(path);
        return out;
      };
      if (found.kind === RK_TEXT && typeof incoming === "string") {
        if (found.size !== incoming.length) return false;
        if (found.chunks === 1) return t.chunkFirst(path)?.txt === incoming;
        let at2 = 0;
        const parts2 = rows();
        for (let i = 0; i < parts2.length; i++) {
          const row = parts2[i];
          if (row === void 0) return false;
          const text = row.txt ?? "";
          if (stringSlice(incoming, at2, at2 + text.length) !== text) return false;
          at2 += text.length;
        }
        return at2 === incoming.length;
      }
      const bytes = typeof incoming === "string" ? encodeText(incoming) : residentBytes(incoming);
      const size = typedArrayByteLength(bytes);
      if (found.kind === RK_BINARY ? found.size !== size : size < found.size || size > 3 * found.size) return false;
      let at = 0;
      const parts = rows();
      for (let i = 0; i < parts.length; i++) {
        const row = parts[i];
        if (row === void 0) return false;
        const part = found.kind === RK_TEXT ? encodeText(row.txt ?? "") : residentBytes(row.bin);
        const length = typedArrayByteLength(part);
        if (!sameBytes(part, bytes, at, at + length)) return false;
        at += length;
      }
      return at === size;
    };
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
      if (admission.heldBytes + size > limit) {
        held.forEach((old, oldest) => {
          if (admission.heldBytes + size <= limit) return;
          held.delete(oldest);
          admission.addHeld(-cellSize(old.cell));
          unheld.add(oldest);
        });
      }
      held.set(path, { cell, rev: RK_OWN_WRITE });
      admission.addHeld(size);
    };
    const head = (path) => coherence.require().fileHead(path);
    const dropDated = () => {
      coherence.tables("dropDated").dropDated();
      held.forEach((cell, path) => {
        if (cell.rev !== RK_OWN_WRITE) forgetHeld(path);
      });
    };
    const put = (t, path, cell, rev, ckey) => {
      forgetHeld(path);
      admission.release(path);
      t.chunkDelete(path);
      const stamp = typeof rev === "number" ? rev : RK_OWN_WRITE;
      if (cell && typeof cell === "object" && ownField(cell, "error")) {
        t.filePut(path, RK_DENIED, 0, 0, stamp, null);
        return true;
      }
      const isText = typeof cell === "string";
      const kind = isText ? RK_TEXT : RK_BINARY;
      const body = isText ? cell : residentBytes(cell);
      const size = typeof body === "string" ? body.length : typedArrayByteLength(body);
      const ends = typeof body === "string" ? textChunkEnds(body) : null;
      const chunks = ends !== null ? ends.length : mathMax(1, mathCeil(size / RESIDENT_CHUNK_BYTES));
      if (!admission.fits(residentCellCost(cell), stamp !== RK_OWN_WRITE)) {
        t.fileDelete(path);
        if (stamp === RK_OWN_WRITE) hold(path, body);
        return false;
      }
      for (let part = 0, from = 0; part < chunks; part++) {
        if (typeof body === "string" && ends !== null) {
          const end = ends[part];
          t.chunkAddText(path, part, stringSlice(body, from, end));
          from = end;
        } else if (typeof body !== "string") {
          const start = part * RESIDENT_CHUNK_BYTES;
          const slice = new Uint8ArrayConstructor(typedArrayBuffer(body), typedArrayByteOffset(body) + start, mathMin(RESIDENT_CHUNK_BYTES, size - start));
          t.chunkAddBin(path, part, slice);
        }
      }
      t.filePut(path, kind, size, chunks, stamp, stamp === RK_OWN_WRITE || ckey == null ? null : stringOf(ckey));
      return true;
    };
    const filling = new SafeMap();
    let fills = 0;
    const putChunk = (t, path, part, bytes, fill) => {
      if (filling.get(path) !== fill) return false;
      if (part === 0) admission.release(path);
      if (!admission.fits(mathCeil(typedArrayByteLength(bytes) * 1.01) + RESIDENT_ROW_BYTES + 4096)) return false;
      t.chunkSetBin(path, part, bytes);
      return true;
    };
    const admit = (result) => {
      const t = coherence.tables("admit");
      const dropped = new SafeList();
      const relist = new SafeList();
      let kept = 0, pushed = 0;
      const position = result ? ownValue2(result, "position") : void 0;
      if (!isFeedPosition(position)) {
        throw new Error2(
          "Nimbus: fsAcquire returned no cursor; the resident store stays sealed rather than serving rows it cannot date"
        );
      }
      const at = coherence.cursor();
      const floorAt = at !== null && coherence.sealed() === null && !(result && result.poison) ? at : null;
      if (at !== null && floorAt !== null && notAfter(position, floorAt)) {
        return { dropped: arrayCopy(dropped), kept, pushed: 0, relist: arrayCopy(relist), cursor: at, stale: !samePosition(position, floorAt) };
      }
      const nsOk = namespace.ok;
      const paths = result && arrayIsArray(result.paths) ? result.paths : null;
      let followable = !!result && !result.poison && (ownValue2(result, "namespace") === true || paths !== null && paths.length === 0);
      if (followable && paths !== null) {
        for (let i = 0; i < paths.length; i++) {
          const stat = ownValue2(paths[i], "stat");
          if (stat !== null && !nsDescribes(stat)) {
            followable = false;
            break;
          }
        }
      }
      const namespaced = nsOk && followable;
      if (nsOk && !followable) {
        namespace.markReady(t, false, !result || result.poison ? "the session's change log was truncated past this process's cursor" : "a change reported without the stat every name needs");
      }
      if (!result || result.poison) {
        dropDated();
      } else if (paths !== null) {
        for (let i = 0; i < paths.length; i++) {
          const entry = paths[i];
          const entryRev = NumberOf(entry.rev);
          if (floorAt !== null && entryRev <= floorFor(position, floorAt, entry.path)) continue;
          const path = entry.path;
          if (namespaced && namespace.ready()) {
            const again = namespace.applyEntry(t, entry);
            if (again !== null) {
              relist[relist.length] = again;
              namespace.fence(again);
            }
          }
          const subtree = ownValue2(entry, "subtree");
          const stat = ownValue2(entry, "stat");
          if (subtree || ownValue2(entry, "structural")) {
            const end = prefixEnd(path + "/");
            const rows = t.fileRevsIn(path + "/", end);
            for (let j = 0; j < rows.length; j++) {
              const row2 = rows[j];
              const stamped2 = row2.rev;
              if (stamped2 === RK_OWN_WRITE || stamped2 >= entryRev) continue;
              t.chunkDelete(row2.path);
              t.fileDelete(row2.path);
              dropped[dropped.length] = row2.path;
            }
            held.forEach((heldCell2, heldPath) => {
              if (!stringStartsWith(heldPath, path + "/") || heldCell2.rev === RK_OWN_WRITE || heldCell2.rev >= entryRev) return;
              forgetHeld(heldPath);
            });
            if (namespaced && !namespace.lazy && subtree && stat && stat.type === "directory") {
              relist[relist.length] = path;
              namespace.fence(path);
            }
          }
          let isHeld = false, stamped = 0, heldKey = null;
          const row = t.fileRevKey(path);
          if (row !== void 0) {
            isHeld = true;
            stamped = row.rev;
            heldKey = row.ckey;
          }
          if (isHeld && (stamped === RK_OWN_WRITE || stamped >= entryRev)) {
            kept++;
            continue;
          }
          const heldCell = held.get(path);
          if (heldCell !== void 0) {
            if (heldCell.rev === RK_OWN_WRITE || heldCell.rev >= entryRev) {
              kept++;
              continue;
            }
            forgetHeld(path);
          }
          const contentKey = ownValue2(entry, "contentKey");
          if (isHeld && heldKey !== null && contentKey != null && heldKey === stringOf(contentKey) && namespace.readable(stat)) {
            t.fileSetRev(path, entryRev);
            kept++;
            continue;
          }
          const bytes = ownValue2(entry, "bytes");
          if (bytes != null && stat && stat.type === "file") {
            const incoming = residentBytes(bytes);
            if (isHeld && holds(t, path, incoming)) {
              t.fileSetRev(path, entryRev);
              kept++;
              continue;
            }
            if (put(t, path, incoming, entryRev, contentKey)) pushed++;
            else if (isHeld) dropped[dropped.length] = path;
            continue;
          }
          if (!isHeld) continue;
          t.chunkDelete(path);
          t.fileDelete(path);
          dropped[dropped.length] = path;
        }
      }
      coherence.writeCursor(t, position);
      coherence.unseal();
      return { dropped: arrayCopy(dropped), kept, pushed, relist: arrayCopy(relist), cursor: position };
    };
    const get = (path) => {
      if (observeRead !== null) observeRead(nsKey(path));
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
        return kind === RK_TEXT ? row.txt ?? void 0 : residentBytes(row.bin);
      }
      const rows = t.chunkParts(path);
      if (rows.length === 0) return void 0;
      if (kind === RK_TEXT) {
        let text = "";
        for (let i = 0; i < rows.length; i++) text += rows[i].txt ?? "";
        return text;
      }
      let total = 0;
      for (let i = 0; i < rows.length; i++) total += typedArrayByteLength(residentBytes(rows[i].bin));
      const out = new Uint8ArrayConstructor(total);
      let offset = 0;
      for (let i = 0; i < rows.length; i++) {
        const bytes = residentBytes(rows[i].bin);
        typedArraySet(out, bytes, offset);
        offset += typedArrayByteLength(bytes);
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
    const target = objectCreate(null);
    const handler = {
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
        const descriptor = objectCreate(null);
        descriptor.configurable = true;
        descriptor.enumerable = true;
        descriptor.get = () => get(path);
        return descriptor;
      }
    };
    reflectSetPrototypeOf(handler, null);
    const bundle = new Proxy2(target, handler);
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
        return typeof cell === "object" && cell !== null && !(cell instanceof Uint8ArrayConstructor) && typeof ownField(cell, "error") === "string";
      },
      get,
      put,
      putChunk,
      publishFill(t, path, kind, size, chunks, rev, ckey, fill) {
        if (filling.get(path) !== fill) return false;
        filling.delete(path);
        t.filePut(path, kind, size, chunks, rev, ckey != null ? stringOf(ckey) : null);
        return true;
      },
      abandonFill(t, path, fill) {
        if (filling.get(path) !== fill) return;
        t.chunkDelete(path);
        t.fileDelete(path);
      },
      beginFill(paths) {
        const fill = { fill: ++fills };
        for (let i = 0; i < paths.length; i++) filling.set(paths[i], fill);
        return fill;
      },
      rowsChanged(path) {
        if (filling.size === 0) return;
        const t = coherence.tables("rowsChanged");
        const disown = (at) => {
          if (filling.delete(at) && t.fileHead(at) === void 0) t.chunkDelete(at);
        };
        if (path !== void 0) {
          disown(path);
          return;
        }
        const owned = new SafeList();
        filling.forEach((_fill, at) => {
          owned[owned.length] = at;
        });
        for (let i = 0; i < owned.length; i++) disown(owned[i]);
      },
      /**
       * The head row, written LAST by the streaming filler.
       *
       * Order is the durability rule here: without a head row `head` returns
       * undefined and the path simply misses, falling through to the supervisor
       * exactly as it would have. So a fill interrupted part way through a large
       * file leaves chunks nothing can read, never a short file something can.
       * Writing the head first would invert that into a truncated read.
       */
      /**
       * Hold `path` with the bytes of a dated row whose content identity is
       * `ckey`, by copying rows inside this store: equal keys are equal bytes, so
       * no fetch is needed. Returns whether a source existed.
       */
      copyByKey(t, path, ckey, rev) {
        const source = t.fileByKey(stringOf(ckey), path);
        if (source === void 0) return false;
        if (!admission.fits(source.size + (source.chunks + 1) * RESIDENT_ROW_BYTES)) return false;
        t.chunkDelete(path);
        t.chunkCopy(path, source.path);
        t.filePut(path, source.kind, source.size, source.chunks, rev, stringOf(ckey));
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
          throw new Error2(
            "Nimbus: refusing to fill '" + path + "' with no authority revision. An undated row cannot be invalidated, so it would be served stale forever."
          );
        }
        const t = coherence.require();
        const dated = t.fileRev(path);
        if (dated !== void 0 && (dated === RK_OWN_WRITE || dated > rev)) return false;
        const heldCell = held.get(path);
        if (heldCell !== void 0 && (heldCell.rev === RK_OWN_WRITE || heldCell.rev > rev)) return false;
        if (holds(t, path, cell)) {
          if (dated !== void 0) t.fileSetRev(path, rev);
          else if (heldCell !== void 0) heldCell.rev = rev;
          return true;
        }
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
        const from = stringOf(prefix);
        return coherence.require().filePaths(from, prefixEnd(from));
      },
      /**
       * Whether ANY path is held under a prefix — the same range, stopped at the
       * first row. The hot half: it is what answers "is this a directory" on node's
       * module-resolution path, where materialising the subtree would be the cost all
       * over again.
       */
      hasUnder(prefix) {
        const from = stringOf(prefix);
        return coherence.require().fileAny(from, prefixEnd(from));
      },
      storageMiss: (path) => unheld.has(path),
      dropHeld(all) {
        held.forEach((cell, path) => {
          if (all || cell.rev !== RK_OWN_WRITE) forgetHeld(path);
        });
      },
      heldRevisions() {
        const out = new SafeList();
        held.forEach((cell, path) => {
          out[out.length] = [path, cell.rev];
        });
        return arrayCopy(out);
      },
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
        held.forEach((cell, path) => {
          if (cell.rev !== RK_OWN_WRITE) forgetHeld(path);
        });
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
    let read = null;
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
            "Nimbus: the resident store was read before its facet bound its storage. store.bind(ctx) must run in the process DO constructor, ahead of the program."
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
        const text = t.metaGet("position");
        if (text === void 0) return null;
        if (read !== null && read.text === text) return read.cursor;
        let cursor = null;
        try {
          const parsed = JSONParse(text);
          cursor = isFeedPosition(parsed) ? parsed : null;
        } catch {
          cursor = null;
        }
        read = { text, cursor };
        return cursor;
      },
      writeCursor(tables, cursor) {
        tables.metaSet("position", JSONStringify(cursor));
      }
    };
  }

  // src/vfs/resident/view.ts
  var LOOKUP_CONTENT_BYTES = 256 * 1024;
  var REPAIR_JOINS_MAX = 4;
  function createView(coherence, admission, namespace, cells, transport, sync, pages) {
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
        answer = await supervisor.fsAcquire(null, { namespace: true });
      } catch {
        return false;
      }
      if (!answer || !isFeedPosition(answer.position)) return false;
      beginLazy(coherence.tables("bootLazy"), answer.position);
      return true;
    };
    const current = (answer) => {
      const cursor = coherence.cursor();
      if (cursor === null || answer.poison === true) return answer;
      if (notAfter(answer.position, cursor)) return { ...answer, position: cursor, paths: [] };
      const paths = answer.paths.filter((entry) => entry.rev > floorFor(answer.position, cursor, entry.path));
      return paths.length === answer.paths.length ? answer : { ...answer, paths };
    };
    const delivered = (given) => {
      if (!given || typeof given !== "object") return null;
      const { args, answer } = given;
      const cursor = coherence.cursor();
      if (cursor === null || !args || !answer || answer.poison === true || !Array.isArray(answer.paths)) return null;
      if (!isFeedPosition(answer.position) || !isFeedPosition(args.position) || !notAfter(args.position, cursor)) return null;
      return current(answer);
    };
    return {
      bootLazy,
      /**
       * The store as a process's filesystem adapter reads it: names as lstats,
       * file bytes held or fetched, and the barrier. `root` is the session's
       * root as of the store's cursor or after it (a delta that names it moves
       * it): its device is the session's SQLite device, the only one the
       * adapter answers for.
       */
      namespaceView(supervisor, root, cred) {
        const device = root.dev;
        namespace.setRoot(root, root.revision);
        namespace.setCred(cred);
        const encoder3 = new TextEncoder();
        const typeOf = (kind) => kind === NS_DIR ? "directory" : kind === NS_LINK ? "symlink" : "file";
        const argsNow = () => {
          const cursor = coherence.cursor();
          return cursor === null ? null : { position: cursor, options: sync.acquireOptions() };
        };
        const acquire = async (lease) => {
          for (let asks = 0; asks < 2; asks++) {
            const args = argsNow();
            if (args === null || typeof supervisor.fsAcquire !== "function") return null;
            let answer = null;
            try {
              answer = await supervisor.fsAcquire(args.position, lease ? { ...args.options, lease: true } : args.options);
            } catch {
              return null;
            }
            if (!answer || !isFeedPosition(answer.position)) return null;
            const now = coherence.cursor();
            if (now === null || !sameEpochs(now, args.position)) continue;
            if (lease && answer.readLease) lease.answered(answer.readLease);
            return current(answer);
          }
          return null;
        };
        const restart = async (answer, applied) => {
          if (answer === null) return bootLazy(supervisor);
          if (applied && namespace.ready()) return true;
          beginLazy(coherence.tables("restart"), applied ? coherence.cursor() : answer.position);
          return true;
        };
        let repairOwed = false;
        let repairing = null;
        const repairFromFloor = async (answer) => {
          if (typeof supervisor.fsAcquire !== "function" || !namespace.ready()) return false;
          if (answer !== null && answer.poison === true) return false;
          const floor = coherence.cursor();
          if (floor === null || answer !== null && !sameEpochs(answer.position, floor)) return false;
          let delta = null;
          try {
            delta = await supervisor.fsAcquire(floor, { namespace: true });
          } catch {
            return false;
          }
          if (!delta || delta.poison === true || !isFeedPosition(delta.position) || !sameEpochs(delta.position, floor)) return false;
          const applied = await sync.applyAcquire(supervisor, delta);
          if (!namespace.ready()) return false;
          await sync.refillFromNamespace(supervisor, applied.dropped);
          repairOwed = false;
          return true;
        };
        const runRepair = async (answer) => {
          namespace.spoilLearnings();
          if (await repairFromFloor(answer)) return;
          let repaired = null;
          try {
            repaired = await sync.synchronize(supervisor);
          } catch {
            repaired = null;
          }
          if (!repaired || !repaired.cursor) {
            if (answer !== null) cells.admit(answer);
            else cells.dropDated();
            try {
              repaired = await sync.synchronize(supervisor);
            } catch {
              repaired = null;
            }
          }
          repairOwed = !(repaired && repaired.cursor);
        };
        const repair = (answer) => {
          if (repairing === null) repairing = runRepair(answer).finally(() => {
            repairing = null;
          });
          return repairing;
        };
        const refetching = /* @__PURE__ */ new Map();
        const refetch = (keys) => {
          if (keys.length === 0) return [];
          const read = sync.refillFromNamespace(supervisor, keys).catch(() => void 0);
          const t = coherence.require();
          return keys.map((k) => {
            const record = { rev: nsRowAt(t, k)?.rev ?? 0, read, done: Promise.resolve() };
            record.done = read.then(() => {
              const newer = refetching.get(k);
              return Promise.all([newer !== void 0 && newer !== record ? newer.read : void 0, repairing ?? void 0]);
            }).then(() => void 0, () => void 0).finally(() => {
              if (refetching.get(k) === record) refetching.delete(k);
            });
            refetching.set(k, record);
            return record.done;
          });
        };
        const enumerated = async (first, lease) => {
          const joined = [...refetching.values()].map((record) => record.done);
          let answer = first;
          let namespaceAsked = false;
          let repaired = false;
          for (let joins = 0; ; joins++) {
            const joining = repairing !== null;
            const namespaceOwed = !namespaceAsked && !namespace.ready();
            const needsRepair = answer === null || answer.poison === true || repairOwed || namespaceOwed;
            if (!joining && !needsRepair) break;
            repaired = true;
            if (namespaceOwed) namespaceAsked = true;
            await (joining ? repairing : repair(answer));
            if (!joining) {
              if (repairOwed) return { landed: false };
              answer = await acquire(lease);
              if (answer === null || answer.poison === true) return { landed: namespace.ready() };
              continue;
            }
            if (joins + 1 >= REPAIR_JOINS_MAX) {
              cells.dropDated();
              repairOwed = true;
              return { landed: false };
            }
            answer = await acquire(lease);
          }
          const applied = await sync.applyAcquire(supervisor, answer);
          if (!namespace.ready()) return { landed: false };
          const named = answer.paths.map((entry) => nsKey(entry.path));
          const overtaken = [...refetching.keys()].filter((k) => !applied.dropped.includes(k) && named.some((at) => at === k || at === "" || k.startsWith(at + "/")));
          await Promise.all([...refetch([...applied.dropped, ...overtaken]), ...joined]);
          return answer.readLease ? { landed: true, applied: !repaired, readLease: answer.readLease } : { landed: true, applied: !repaired };
        };
        const lazily = async (answer) => {
          if (answer === null || answer.poison === true) return { landed: await restart(answer, false), applied: false };
          await sync.applyAcquire(supervisor, answer);
          const applied = namespace.ready();
          const landed = await restart(answer, true);
          return applied && answer.readLease ? { landed, applied, readLease: answer.readLease } : { landed, applied };
        };
        const view = {
          device: Number(device),
          cred: { uid: Number(cred.uid), gid: Number(cred.gid), groups: (cred.groups || []).map(Number) },
          ready: () => namespace.ready(),
          entry(k) {
            if (namespace.fenced(k)) return void 0;
            const row = k === "" ? namespace.root() : nsRowAt(coherence.require(), k);
            if (row === void 0) return k !== "" && namespace.listedAt(k) ? null : void 0;
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
            return typeof cell === "string" ? encoder3.encode(cell) : cell;
          },
          async fill(k, entry) {
            const cursor = coherence.cursor();
            if (cursor === null) return null;
            await transport.fetchFiles(supervisor, [{ path: k, size: entry.size, rev: entry.revision, epoch: rootEpochFor(cursor, k), ckey: null, version: entry }]);
            const bytes = view.content(k, entry.revision);
            return bytes === void 0 ? null : bytes;
          },
          pages: (k, rev, size, first, last) => pages.read(supervisor, k, rev, size, first, last),
          // Many files in batched round trips (read-ahead, core runtime/wasi/resident-filesystem.ts).
          async fillMany(files) {
            const cursor = coherence.cursor();
            if (cursor === null || files.length === 0) return;
            await transport.fetchFiles(supervisor, files.map(([k, entry]) => ({ path: k, size: entry.size, rev: entry.revision, epoch: rootEpochFor(cursor, k), ckey: null, version: entry })));
          },
          acquireArgs: () => argsNow(),
          repairOwed: () => repairOwed,
          async barrier(options = {}) {
            const standIn = options.answer === void 0 ? delivered(options.delivered) : null;
            const answer = options.answer !== void 0 ? current(options.answer) : standIn ?? await acquire(options.lease);
            const result = namespace.lazy ? await lazily(answer) : await enumerated(answer, options.lease);
            return standIn === null ? result : { ...result, fromDelivery: true };
          },
          cursor: () => coherence.cursor(),
          reserve: (bytes) => admission.pin(bytes),
          release: (bytes) => admission.unpin(bytes),
          // Each row as it is put, the process's (one listener: this view's process, a later one replacing it).
          onAdmitted(listener) {
            namespace.onPut(listener);
          }
        };
        return view;
      }
    };
  }

  // src/vfs/resident/pages.ts
  function createPages(coherence, admission, namespace) {
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
    const readWith = async (learning, supervisor, k, rev, size, first, last) => {
      const cursor = coherence.cursor();
      if (cursor === null || typeof supervisor.fsReadBatch !== "function") return null;
      const epoch = rootOf(cursor).epoch;
      const keyed = epoch + "\0" + k;
      const out = new Array(last - first + 1);
      const missing = [];
      for (let part = first; part <= last; part++) {
        const page = get(keyed, rev, part);
        if (page !== void 0) out[part - first] = page;
        else missing.push(part);
      }
      const perBatch = Math.max(1, Math.min(FS_READ_BATCH_PATH_LIMIT, Math.floor(FS_READ_BATCH_REQUEST_BYTES / RESIDENT_PAGE_BYTES)));
      for (let at = 0; at < missing.length; at += perBatch) {
        const batch = missing.slice(at, at + perBatch);
        const ranges = batch.map((part) => {
          const offset = part * RESIDENT_PAGE_BYTES;
          return { path: "/" + k, offset, length: Math.min(RESIDENT_PAGE_BYTES, Math.max(0, size - offset)), expectedEpoch: epoch, expectedRevision: rev };
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
          if (learning.installs(k)) put(keyed, rev, batch[i], bytes);
        }
      }
      return { pages: out, fetched: missing.length };
    };
    return {
      async read(supervisor, k, rev, size, first, last) {
        const learning = namespace.learning();
        try {
          return await readWith(learning, supervisor, k, rev, size, first, last);
        } finally {
          learning.end();
        }
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
  var RELIST_ATTEMPTS = 3;
  function ownValue3(record, key) {
    return objectHasOwn(record, key) ? record[key] : void 0;
  }
  function method(supervisor, name) {
    return reflectGet(supervisor, name);
  }
  var messageOf = (e) => {
    const message = e !== null && (typeof e === "object" || typeof e === "function") ? reflectGet(e, "message") : void 0;
    return stringOf(message || e);
  };
  function createTransport(coherence, admission, namespace, cells) {
    const relist = async (supervisor, dir) => {
      const t = coherence.tables("relist");
      const fsList = supervisor ? method(supervisor, "fsList") : void 0;
      if (!supervisor || typeof fsList !== "function") {
        namespace.markReady(t, false, "the session cannot list its filesystem");
        return;
      }
      for (let attempt = 0; attempt < RELIST_ATTEMPTS; attempt++) {
        const learning = namespace.learning();
        try {
          const listed = await relistWith(learning, t, supervisor, fsList, dir);
          if (listed !== "overtaken") return;
        } finally {
          learning.end();
        }
      }
      namespace.markReady(t, false, "a listing of /" + dir + " was overtaken by every barrier since");
    };
    const relistWith = async (learning, t, supervisor, fsList, dir) => {
      const prefix = dir + "/";
      const seen = new SafeList();
      let replaceBytes = 0;
      let incomingBytes = 0;
      if (admission.inHeap) {
        const rows = t.nsKeys();
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const key = row.parent ? row.parent + "/" + row.name : row.name;
          if (!stringStartsWith(key, prefix)) continue;
          replaceBytes += namespaceRowBytes(row.parent, row.name, t.nsGet(row.parent, row.name)?.target);
        }
      }
      let after = prefix;
      let done = false;
      for (let page = 0; page < MAX_LIST_PAGES && !done; page++) {
        let listed;
        try {
          listed = await reflectApply(fsList, supervisor, [after, FS_LIST_PAGE_LIMIT]);
        } catch (e) {
          namespace.markReady(t, false, "a listing of /" + dir + " failed (" + messageOf(e) + ")");
          return;
        }
        if (!listed || !arrayIsArray(listed.entries)) {
          namespace.markReady(t, false, "a listing of /" + dir + " came back without entries");
          return;
        }
        for (let i = 0; i < listed.entries.length; i++) {
          const entry = listed.entries[i];
          const k = nsKey(entry.path);
          if (!stringStartsWith(k, prefix)) {
            if (k > prefix) {
              done = true;
              break;
            }
            continue;
          }
          if (entry.stat) {
            if (admission.inHeap && admission.cap !== null) {
              incomingBytes += namespaceRowBytes(nsParent(k), nsName(k), ownValue3(entry, "linkTarget") ?? ownValue3(entry, "unlisted"));
              const refused = admission.namespaceRefusal(incomingBytes - replaceBytes);
              if (refused !== null) {
                namespace.markReady(t, false, refused);
                return;
              }
            }
            seen[seen.length] = entry;
          }
        }
        if (listed.next === null || listed.next === void 0) done = true;
        else after = listed.next;
      }
      if (!done) {
        namespace.markReady(t, false, "a listing of /" + dir + " did not finish");
        return;
      }
      for (let i = 0; i < seen.length; i++) {
        if (!nsDescribes(seen[i].stat)) {
          namespace.markReady(t, false, "a listing of /" + dir + " named an entry without its stat");
          return;
        }
      }
      if (!learning.lists(dir)) return "overtaken";
      namespace.deleteTree(t, dir, false);
      for (let i = 0; i < seen.length; i++) {
        const entry = seen[i];
        namespace.put(t, nsKey(entry.path), entry.stat, entry.rev, ownValue3(entry, "linkTarget"), ownValue3(entry, "unlisted") ?? null);
      }
      namespace.relisted(dir);
    };
    const outdated = (t, learning, path, rev) => {
      if (!learning.installs(path)) return true;
      const listed = t.nsGet(nsParent(path), nsName(path));
      return listed !== void 0 && NumberOf(listed.rev) > rev;
    };
    const fetchFiles = async (supervisor, wantedFiles) => {
      const learning = namespace.learning();
      try {
        return await fetchWith(learning, supervisor, wantedFiles);
      } finally {
        learning.end();
      }
    };
    const fetchWith = async (learning, supervisor, wantedFiles) => {
      const t = coherence.tables("fetchFiles");
      const requested = wantedFiles.length;
      let copied = 0;
      const files = new SafeList();
      const later = new SafeList();
      const fetching = new SafeSet();
      for (let i = 0; i < wantedFiles.length; i++) {
        const file = wantedFiles[i];
        const ckey = ownValue3(file, "ckey");
        if (ckey != null) {
          if (cells.copyByKey(t, file.path, ckey, file.rev)) {
            copied++;
            continue;
          }
          if (fetching.has(ckey)) {
            later[later.length] = file;
            continue;
          }
          fetching.add(ckey);
        }
        files[files.length] = file;
      }
      const ranges = new SafeList();
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const parts = mathMax(1, mathCeil(file.size / RESIDENT_CHUNK_BYTES));
        const dated = file.rev !== 0 && file.epoch !== null;
        const version = dated ? null : ownValue3(file, "version") ?? ownValue3(file, "stat") ?? null;
        const ckey = ownValue3(file, "ckey") ?? null;
        for (let part = 0; part < parts; part++) {
          const offset = part * RESIDENT_CHUNK_BYTES;
          ranges[ranges.length] = {
            path: file.path,
            rev: file.rev,
            epoch: file.epoch,
            version,
            part,
            parts,
            offset,
            length: mathMin(RESIDENT_CHUNK_BYTES, mathMax(0, file.size - offset)),
            size: file.size,
            ckey
          };
        }
      }
      const landed = new SafeMap();
      let filled = 0, failed = 0, fetchedBytes = 0;
      const failedPaths = new SafeSet();
      const paths = new SafeList();
      for (let i = 0; i < files.length; i++) paths[paths.length] = files[i].path;
      const fill = cells.beginFill(paths);
      for (let at = 0; at < ranges.length; ) {
        const batch = new SafeList();
        let bytes = 0;
        while (at < ranges.length && batch.length < BATCH_PATHS && (batch.length === 0 || bytes + ranges[at].length <= BATCH_BYTES)) {
          const range = ranges[at];
          bytes += range.length;
          batch[batch.length] = range;
          at++;
        }
        if (!await admission.ensureRoom(bytes + batch.length * RESIDENT_ROW_BYTES)) {
          for (let i = 0; i < batch.length; i++) failedPaths.add(batch[i].path);
          continue;
        }
        let results;
        try {
          const fsReadBatch = method(supervisor, "fsReadBatch");
          if (typeof fsReadBatch !== "function") throw new TypeError2("supervisor.fsReadBatch is not a function");
          const requests = new SafeList();
          for (let i = 0; i < batch.length; i++) {
            const r = batch[i];
            requests[requests.length] = r.version === null ? { path: r.path, offset: r.offset, length: r.length, expectedEpoch: r.epoch, expectedRevision: r.rev } : { path: r.path, offset: r.offset, length: r.length, expectedFile: fileVersionOf(r.version) };
          }
          results = await reflectApply(fsReadBatch, supervisor, [arrayCopy(requests)]);
        } catch {
          for (let i = 0; i < batch.length; i++) failedPaths.add(batch[i].path);
          continue;
        }
        for (let i = 0; i < batch.length; i++) {
          const range = batch[i];
          const entry = results && ownValue3(results, i);
          const error = entry && ownValue3(entry, "error");
          if (!entry || error) {
            const code = error ? ownField(error, "code") : void 0;
            if (code === "EACCES" && range.part === 0) {
              cells.put(t, range.path, { error: "EACCES" }, range.rev);
              filled++;
            } else failedPaths.add(range.path);
            continue;
          }
          const bytes2 = ownValue3(entry, "bytes");
          if (bytes2 === null || bytes2 === void 0) {
            failedPaths.add(range.path);
            continue;
          }
          const chunk = residentBytes(bytes2);
          const chunkBytes = typedArrayByteLength(chunk);
          if (chunkBytes !== range.length) {
            failedPaths.add(range.path);
            continue;
          }
          if (outdated(t, learning, range.path, range.rev)) {
            failedPaths.add(range.path);
            continue;
          }
          fetchedBytes += chunkBytes;
          if (!cells.putChunk(t, range.path, range.part, chunk, fill)) {
            failedPaths.add(range.path);
            continue;
          }
          const seen = (landed.get(range.path) || 0) + 1;
          landed.set(range.path, seen);
          if (seen === range.parts && !failedPaths.has(range.path)) {
            if (cells.publishFill(t, range.path, RK_BINARY, range.size, range.parts, range.rev, range.ckey, fill)) filled++;
            else failedPaths.add(range.path);
          }
        }
      }
      failedPaths.forEach((path) => {
        failed++;
        cells.abandonFill(t, path, fill);
      });
      for (let i = 0; i < later.length; i++) {
        const file = later[i];
        if (!outdated(t, learning, file.path, file.rev) && cells.copyByKey(t, file.path, ownValue3(file, "ckey"), file.rev)) copied++;
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
      const entries = new SafeList();
      const names = new SafeList();
      let namespaceBytes = 0;
      let after = null;
      let cursor = null;
      const fsList = method(supervisor, "fsList");
      if (typeof fsList !== "function") throw new TypeError2("supervisor.fsList is not a function");
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const listed = await reflectApply(fsList, supervisor, [after, FS_LIST_PAGE_LIMIT]);
        if (!listed || !arrayIsArray(listed.entries)) {
          throw new Error2("Nimbus: fsList returned no page");
        }
        if (!isFeedPosition(listed.position)) throw new Error2("Nimbus: fsList returned no position");
        if (cursor === null) {
          cursor = listed.position;
        } else if (!sameEpochs(listed.position, cursor)) {
          return { entries: arrayCopy(entries), names: arrayCopy(names), cursor, complete: false, reason: "the supervisor changed incarnation mid-enumeration" };
        }
        for (let i = 0; i < listed.entries.length; i++) {
          const entry = listed.entries[i];
          if (entry.stat) {
            if (admission.inHeap && admission.cap !== null) {
              const key = nsKey(entry.path);
              if (key) namespaceBytes += namespaceRowBytes(nsParent(key), nsName(key), ownValue3(entry, "linkTarget") ?? ownValue3(entry, "unlisted"));
              const heap = coherence.heap;
              const refused = admission.namespaceRefusal(namespaceBytes - (heap === null ? 0 : heap.nsBytes()));
              if (refused !== null) namespace.refuse(t, refused);
            }
            names[names.length] = entry;
          }
          if (entry.kind !== "file") continue;
          const path = nsKey(entry.path);
          if (!path) continue;
          const size = NumberOf(entry.size);
          const rev = NumberOf(entry.rev);
          if (!numberIsSafeInteger(size) || size < 0 || !numberIsSafeInteger(rev) || rev < 0) {
            throw new Error2("Nimbus: fsList returned unusable metadata for '" + path + "'");
          }
          const contentKey = ownValue3(entry, "contentKey");
          entries[entries.length] = { path, size, rev, epoch: rootEpochFor(cursor, path), ckey: contentKey == null ? null : stringOf(contentKey), stat: entry.stat ?? null };
        }
        if (listed.next === null || listed.next === void 0) {
          return { entries: arrayCopy(entries), names: arrayCopy(names), namespaceBytes, cursor, complete: true, reason: null };
        }
        after = listed.next;
      }
      return { entries: arrayCopy(entries), names: arrayCopy(names), cursor, complete: false, reason: "the filesystem exceeded the enumeration page bound" };
    };
    const lookupKeys = async (supervisor, keys, contentBytes) => {
      const fsReadBatch = supervisor ? method(supervisor, "fsReadBatch") : void 0;
      if (!supervisor || typeof fsReadBatch !== "function" || keys.length === 0) return false;
      const t = coherence.require();
      const batch = new SafeList();
      for (let i = 0, end = mathMin(keys.length, BATCH_PATHS - 2); i < end; i++) batch[batch.length] = keys[i];
      const last = batch[batch.length - 1];
      const withContent = contentBytes > 0 && batch.length === keys.length;
      const requests = new SafeList();
      for (let i = 0; i < batch.length; i++) requests[requests.length] = { path: "/" + batch[i], lstat: true };
      if (withContent) {
        requests[requests.length] = { path: "/" + last, offset: 0, length: contentBytes };
        requests[requests.length] = { path: "/" + last, lstat: true };
      }
      const learning = namespace.learning();
      try {
        let answers;
        try {
          answers = await reflectApply(fsReadBatch, supervisor, [arrayCopy(requests)]);
        } catch {
          return false;
        }
        if (!arrayIsArray(answers) || answers.length !== requests.length) return false;
        let reachedLast = false;
        for (let i = 0; i < batch.length; i++) {
          const answer = ownValue3(answers, i);
          const stat = answer && ownValue3(answer, "stat");
          if (!answer || ownValue3(answer, "error") || stat === null || stat === void 0 || !nsDescribes(stat)) break;
          let target;
          if (stat.type === "symlink") {
            try {
              const readlink = method(supervisor, "readlink");
              if (typeof readlink !== "function") break;
              target = await reflectApply(readlink, supervisor, ["/" + batch[i]]);
            } catch {
              break;
            }
            if (typeof target !== "string") break;
          }
          if (!learning.installs(batch[i]) || !namespace.learn(t, batch[i], stat, NumberOf(stat.revision) || 0, target)) return false;
          if (i === batch.length - 1) reachedLast = true;
          if (stat.type !== "directory") break;
        }
        if (withContent && reachedLast) {
          const lastAnswer = ownValue3(answers, batch.length - 1);
          const before = lastAnswer && ownValue3(lastAnswer, "stat");
          const read = ownValue3(answers, batch.length);
          const after = ownValue3(answers, batch.length + 1);
          const content = read && !ownValue3(read, "error") && ownValue3(read, "bytes");
          const bytes = content ? residentBytes(content) : null;
          const size = bytes === null ? 0 : typedArrayByteLength(bytes);
          const afterStat = after && !ownValue3(after, "error") ? ownValue3(after, "stat") : null;
          if (before && before.type === "file" && bytes !== null && size === NumberOf(before.size) && afterStat && afterStat.type === "file" && NumberOf(afterStat.ino) === NumberOf(before.ino) && NumberOf(afterStat.revision) === NumberOf(before.revision) && await admission.ensureRoom(residentCellCost(bytes)) && learning.installs(last)) {
            cells.fill(last, bytes, NumberOf(before.revision) || 0);
          }
        }
        return true;
      } finally {
        learning.end();
      }
    };
    const listDirectory = async (supervisor, dir) => {
      const readdir = supervisor ? method(supervisor, "readdir") : void 0;
      const fsReadBatch = supervisor ? method(supervisor, "fsReadBatch") : void 0;
      if (!supervisor || typeof readdir !== "function" || typeof fsReadBatch !== "function") return false;
      const t = coherence.require();
      const learning = namespace.learning();
      try {
        let names;
        try {
          names = await reflectApply(readdir, supervisor, ["/" + dir]);
        } catch {
          return false;
        }
        if (!arrayIsArray(names)) return false;
        const keys = new SafeList();
        for (let i = 0; i < names.length; i++) keys[keys.length] = (dir === "" ? "" : dir + "/") + stringOf(names[i].name);
        const stats = new SafeMap();
        for (let i = 0; i < keys.length; i += BATCH_PATHS) {
          const batch = new SafeList();
          const requests = new SafeList();
          for (let j = i, end = mathMin(keys.length, i + BATCH_PATHS); j < end; j++) {
            batch[batch.length] = keys[j];
            requests[requests.length] = { path: "/" + keys[j], lstat: true };
          }
          let answers;
          try {
            answers = await reflectApply(fsReadBatch, supervisor, [arrayCopy(requests)]);
          } catch {
            return false;
          }
          if (!arrayIsArray(answers) || answers.length !== batch.length) return false;
          for (let j = 0; j < batch.length; j++) {
            const answer = ownValue3(answers, j);
            if (!answer || ownValue3(answer, "error")) return false;
            const stat = ownValue3(answer, "stat");
            if (stat === null || stat === void 0 || !nsDescribes(stat)) return false;
            stats.set(batch[j], stat);
          }
        }
        const statKeys = new SafeList();
        stats.forEach((_stat, k) => {
          statKeys[statKeys.length] = k;
        });
        const targets = new SafeMap();
        for (let i = 0; i < statKeys.length; i++) {
          const k = statKeys[i];
          const stat = stats.get(k);
          if (stat === void 0 || stat.type !== "symlink") continue;
          let target;
          try {
            const readlink = method(supervisor, "readlink");
            if (typeof readlink !== "function") return false;
            target = await reflectApply(readlink, supervisor, ["/" + k]);
          } catch {
            return false;
          }
          if (typeof target !== "string") return false;
          targets.set(k, target);
        }
        if (!learning.lists(dir)) return false;
        const children = namespace.children(dir);
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          const k = (dir === "" ? "" : dir + "/") + child.name;
          if (!stats.has(k)) namespace.deleteTree(t, k, true);
        }
        for (let i = 0; i < statKeys.length; i++) {
          const k = statKeys[i];
          const stat = stats.get(k);
          if (stat !== void 0 && !namespace.learn(t, k, stat, NumberOf(stat.revision) || 0, targets.get(k))) return false;
        }
        namespace.markListed(dir);
        return true;
      } finally {
        learning.end();
      }
    };
    const listSubtree = async (supervisor, dir) => {
      const fsListTree = supervisor ? method(supervisor, "fsListTree") : void 0;
      if (!supervisor || typeof fsListTree !== "function") return false;
      const t = coherence.require();
      const learning = namespace.learning();
      try {
        let tree;
        try {
          tree = await reflectApply(fsListTree, supervisor, ["/" + dir, FS_LIST_TREE_MAX_ENTRIES]);
        } catch {
          return false;
        }
        if (!tree || !arrayIsArray(tree.entries) || !learning.lists(dir)) return false;
        const listed = new SafeList();
        listed[listed.length] = dir;
        const written = new SafeSet();
        for (let i = 0; i < tree.entries.length; i++) {
          const entry = tree.entries[i];
          const k = nsKey(entry.path);
          if (!entry.stat || !nsDescribes(entry.stat)) return false;
          const unlisted = ownValue3(entry, "unlisted");
          if (!namespace.tryPut(t, k, entry.stat, entry.rev, ownValue3(entry, "linkTarget"), unlisted ?? null)) return false;
          written.add(k);
          if (entry.kind === "directory" && !unlisted) listed[listed.length] = k;
        }
        for (let i = 0; i < listed.length; i++) {
          const directory = listed[i];
          const children = namespace.children(directory);
          for (let j = 0; j < children.length; j++) {
            const child = children[j];
            const k = (directory === "" ? "" : directory + "/") + child.name;
            if (!written.has(k)) namespace.deleteTree(t, k, true);
          }
        }
        for (let i = 0; i < listed.length; i++) namespace.markListed(listed[i]);
        return true;
      } finally {
        learning.end();
      }
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
      for (const dir of applied.relist) await transport.relist(supervisor, dir);
      return applied;
    };
    const catchUp = async (supervisor, cursor) => {
      if (!supervisor || typeof supervisor.fsAcquire !== "function") return cursor;
      let result;
      try {
        result = await supervisor.fsAcquire(cursor, acquireOptions());
      } catch {
        result = null;
      }
      if (!result || result.poison || !isFeedPosition(result.position)) {
        return cursor;
      }
      const applied = await applyAcquire(supervisor, result);
      const refetch = [];
      for (const path of applied.dropped) {
        const found = namespace.resolve(path, false);
        if (!found || found === "ELOOP" || found.row.kind !== NS_FILE) continue;
        refetch.push({ path, size: found.row.size, rev: found.row.rev, epoch: rootEpochFor(applied.cursor, path), version: versionOf(found.row) });
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
      const at = listing.cursor;
      const comparable = (path) => judgeable && held !== null && sameClock(held, at, path);
      const vouches = (entry, rev) => entry !== void 0 && comparable(entry.path) && entry.rev > 0 && rev >= entry.rev;
      const listed = /* @__PURE__ */ new Map();
      for (const file of listing.entries) listed.set(file.path, file);
      const rows = t.fileRows();
      const current = /* @__PURE__ */ new Set();
      const dropped = [];
      const own = [];
      let rekeyed = 0;
      let vouched = 0;
      for (const row of rows) {
        const entry = listed.get(row.path);
        if (row.rev === RK_OWN_WRITE) {
          current.add(row.path);
          own.push({
            path: row.path,
            rev: !comparable(row.path) ? null : entry !== void 0 ? entry.rev : feedFor(at, row.path).cursor
          });
          continue;
        }
        if (vouches(entry, row.rev)) {
          vouched++;
          current.add(row.path);
          continue;
        }
        if (!judgeable) {
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
          own.push({ path, rev: !comparable(path) ? null : entry !== void 0 ? entry.rev : feedFor(at, path).cursor });
          continue;
        }
        if (vouches(entry, rev)) {
          vouched++;
          current.add(path);
          continue;
        }
        if (!judgeable) {
          current.add(path);
          continue;
        }
        cells.forget(path);
        dropped.push(path);
      }
      if (dropped.length > 0 && vouched === 0 && rekeyed === 0) {
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
        if (plan.has(file.path) || wanted.has(file.path) || pushable(file.path) && (!comparable(file.path) || file.rev > feedFor(held, file.path).cursor)) fetch.push(file);
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
        reconciled: comparable(""),
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
      if (!isFeedPosition(moduleCursor)) {
        coherence.setUndated(true);
        coherence.unseal();
        return null;
      }
      for (const path of Object.keys(bundle || {})) {
        cells.put(t, path, bundle[path], feedFor(moduleCursor, path).cursor);
      }
      return cells.admit({ poison: false, paths: [], position: moduleCursor }).cursor;
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
          fetch.push({ path, size: row.size, rev: row.rev, epoch: rootEpochFor(cursor, path), ckey: null, version: versionOf(row) });
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

  // src/vfs/resident/kv-tables.ts
  var UNCONFIRMED = { allowUnconfirmed: true };
  var DELETE_BATCH = 128;
  var SEP = "";
  var RESERVED = /[\u0000\u0001]/;
  var encodePart = (text) => RESERVED.test(text) ? text.replace(/[\u0000\u0001]/g, (c) => c === "\0" ? "" : "") : text;
  var decodePart = (text) => text.indexOf("") < 0 ? text : text.replace(/\u0001[\u0002\u0003]/g, (c) => c === "" ? "\0" : "");
  var pad = (n) => stringOf(NumberOf(n)).padStart(17, "0");
  var FILE = "F";
  var CHUNK = "C";
  var CHUNK_KEYS = "X";
  var BY_CKEY = "K";
  var NS = "N";
  var PAGE = "P";
  var PAGE_ROWS = "Q";
  var PAGE_USED = "U";
  var META = "M";
  var SEQ = META + "seq";
  var END = { [FILE]: StringFromCharCode(71), [NS]: StringFromCharCode(79) };
  function kvTables(storage, rowsChanged = () => {
  }) {
    const writeRows = (path, write) => {
      rowsChanged(path);
      write();
    };
    const kv = storage.kv;
    const put = (key, value) => {
      storage.put(key, value, UNCONFIRMED);
    };
    const drop = (keys) => {
      let batch = new SafeList();
      for (let i = 0; i < keys.length; i++) {
        batch[batch.length] = keys[i];
        if (batch.length === DELETE_BATCH) {
          storage.delete(arrayCopy(batch), UNCONFIRMED);
          batch = new SafeList();
        }
      }
      if (batch.length > 0) storage.delete(arrayCopy(batch), UNCONFIRMED);
    };
    const dropOne = (key) => {
      storage.delete(key, UNCONFIRMED);
    };
    const keysOf = (options) => {
      const out = new SafeList();
      for (const [key] of kv.list(options)) out[out.length] = key;
      return out;
    };
    const rangeOf = (tag, from, to) => ({
      start: tag + encodePart(from),
      end: to === null ? END[tag] : tag + encodePart(to)
    });
    const fileKey = (path) => FILE + encodePart(path);
    const fileOf = (path) => kv.get(fileKey(path));
    const chunkKey = (path, n) => CHUNK + encodePart(path) + SEP + pad(n);
    const chunkIndex = (path, n) => CHUNK_KEYS + encodePart(path) + SEP + pad(n);
    const byKeyPrefix = (ckey) => BY_CKEY + encodePart(ckey) + SEP;
    const byKey = (row, path) => byKeyPrefix(row[4]) + pad(row[5]) + SEP + encodePart(path);
    const nsKey2 = (parent, name) => NS + encodePart(parent) + SEP + encodePart(name);
    const nsChildren = (parent) => NS + encodePart(parent) + SEP;
    const pageTail = (path, rev, n) => encodePart(path) + SEP + pad(rev) + SEP + pad(n);
    const NUMBER = SEP.length + 17;
    const unpage = (tail) => {
      const at = tail.length - 2 * NUMBER;
      return { path: decodePart(tail.slice(0, at)), rev: NumberOf(tail.slice(at + SEP.length, at + NUMBER)), part: NumberOf(tail.slice(at + NUMBER + SEP.length)) };
    };
    const chunkRow = (value) => typeof value === "string" ? { txt: value, bin: null } : { txt: null, bin: value };
    const setFile = (path, kind, size, chunks, rev, ckey) => {
      const had = fileOf(path);
      if (had !== void 0 && had[4] !== null) dropOne(byKey(had, path));
      const seq = NumberOf(kv.get(SEQ) ?? 0) + 1;
      put(SEQ, seq);
      const row = [kind, size, chunks, rev, ckey, seq];
      put(fileKey(path), row);
      if (ckey !== null) put(byKey(row, path), 1);
    };
    const setRev = (path, row, rev) => {
      put(fileKey(path), [row[0], row[1], row[2], NumberOf(rev), row[4], row[5]]);
    };
    const deleteFile = (path) => {
      const had = fileOf(path);
      if (had === void 0) return;
      if (had[4] !== null) dropOne(byKey(had, path));
      dropOne(fileKey(path));
    };
    const deleteChunks = (path) => {
      const parts = keysOf({ prefix: CHUNK_KEYS + encodePart(path) + SEP });
      const keys = new SafeList();
      for (let i = 0; i < parts.length; i++) {
        keys[keys.length] = parts[i];
        keys[keys.length] = CHUNK + parts[i].slice(1);
      }
      drop(keys);
    };
    const addChunk = (path, part, value, replace) => {
      const index = chunkIndex(path, part);
      if (!replace && kv.get(index) !== void 0) throw new Error2("UNIQUE constraint failed: chunk.path, chunk.part");
      put(chunkKey(path, part), value);
      put(index, 1);
    };
    const files = () => {
      const out = new SafeList();
      for (const [key, value] of kv.list({ prefix: FILE })) out[out.length] = [decodePart(key.slice(1)), value];
      return out;
    };
    const chunkPaths = () => {
      const out = new SafeList();
      let last = null;
      for (const [key] of kv.list({ prefix: CHUNK_KEYS })) {
        const path = decodePart(key.slice(1, key.lastIndexOf(SEP)));
        if (path !== last) {
          out[out.length] = path;
          last = path;
        }
      }
      return out;
    };
    const dropWhere = (keepFile, keepChunkPath) => writeRows(void 0, () => {
      const paths = chunkPaths();
      for (let i = 0; i < paths.length; i++) if (!keepChunkPath(paths[i])) deleteChunks(paths[i]);
      const rows = files();
      for (let i = 0; i < rows.length; i++) if (!keepFile(rows[i][1])) deleteFile(rows[i][0]);
    });
    const ownPaths = () => {
      const own = new SafeSet();
      const rows = files();
      for (let i = 0; i < rows.length; i++) if (rows[i][1][3] === RK_OWN_WRITE) own.add(rows[i][0]);
      return own;
    };
    const nsRows = (options) => {
      const out = new SafeList();
      for (const [key, value] of kv.list(options)) {
        const at = key.indexOf(SEP);
        out[out.length] = [{ parent: decodePart(key.slice(1, at)), name: decodePart(key.slice(at + SEP.length)) }, value];
      }
      return out;
    };
    const deleteKeys = (options) => drop(keysOf(options));
    if (kv.get(META + "schema") !== RESIDENT_SCHEMA) {
      for (const tag of [FILE, CHUNK, CHUNK_KEYS, BY_CKEY, NS, PAGE, PAGE_ROWS, PAGE_USED, META]) deleteKeys({ prefix: tag });
      put(META + "schema", RESIDENT_SCHEMA);
    }
    return {
      bytes() {
        return NumberOf(storage.sql?.databaseSize ?? 0);
      },
      databaseSize() {
        return NumberOf(storage.sql?.databaseSize ?? 0);
      },
      metaGet(k) {
        const v = kv.get(META + k);
        return v === void 0 ? void 0 : stringOf(v);
      },
      metaSet(k, v) {
        put(META + k, stringOf(v));
      },
      fileHead(path) {
        const row = fileOf(path);
        return row === void 0 ? void 0 : { kind: row[0], size: row[1], chunks: row[2] };
      },
      fileRev(path) {
        return fileOf(path)?.[3];
      },
      fileRevKey(path) {
        const row = fileOf(path);
        return row === void 0 ? void 0 : { rev: row[3], ckey: row[4] };
      },
      fileOwnSize(path) {
        const row = fileOf(path);
        return row !== void 0 && row[3] === RK_OWN_WRITE ? row[1] : void 0;
      },
      filePut(path, kind, size, chunks, rev, ckey) {
        if (!(rev >= -1)) throw new Error2("CHECK constraint failed: rev >= -1");
        writeRows(path, () => {
          setFile(path, NumberOf(kind), NumberOf(size), NumberOf(chunks), NumberOf(rev), ckey == null ? null : stringOf(ckey));
        });
      },
      fileSetRev(path, rev) {
        writeRows(path, () => {
          const row = fileOf(path);
          if (row !== void 0) setRev(path, row, rev);
        });
      },
      fileStampOwn(path, rev) {
        writeRows(path, () => {
          const row = fileOf(path);
          if (row !== void 0 && row[3] === RK_OWN_WRITE) setRev(path, row, rev);
        });
      },
      fileDelete(path) {
        writeRows(path, () => {
          deleteFile(path);
        });
      },
      fileByKey(ckey, notPath) {
        const prefix = byKeyPrefix(stringOf(ckey));
        for (const [key] of kv.list({ prefix })) {
          const path = decodePart(key.slice(prefix.length + NUMBER));
          if (path === notPath) continue;
          const row = fileOf(path);
          if (row !== void 0 && row[3] >= 0) return { path, kind: row[0], size: row[1], chunks: row[2] };
        }
        return void 0;
      },
      filePaths(from, to) {
        const out = new SafeList();
        for (const [key] of kv.list(rangeOf(FILE, from, to))) out[out.length] = decodePart(key.slice(1));
        return arrayCopy(out);
      },
      fileAny(from, to) {
        for (const _entry of kv.list({ ...rangeOf(FILE, from, to), limit: 1 })) return true;
        return false;
      },
      fileRevsIn(from, to) {
        const out = new SafeList();
        for (const [key, value] of kv.list(rangeOf(FILE, from, to))) out[out.length] = { path: decodePart(key.slice(1)), rev: value[3] };
        return arrayCopy(out);
      },
      fileAllPaths() {
        const rows = files();
        const out = new SafeList();
        for (let i = 0; i < rows.length; i++) out[out.length] = rows[i][0];
        return arrayCopy(out);
      },
      fileRows() {
        const rows = files();
        const out = new SafeList();
        for (let i = 0; i < rows.length; i++) out[out.length] = { path: rows[i][0], rev: rows[i][1][3], ckey: rows[i][1][4] };
        return arrayCopy(out);
      },
      fileOwnPaths() {
        const rows = files();
        const out = new SafeList();
        for (let i = 0; i < rows.length; i++) if (rows[i][1][3] === RK_OWN_WRITE) out[out.length] = rows[i][0];
        return arrayCopy(out);
      },
      fileStats() {
        const rows = files();
        let b = 0;
        for (let i = 0; i < rows.length; i++) b += rows[i][1][1];
        return { n: rows.length, b };
      },
      chunkFirst(path) {
        const value = kv.get(chunkKey(path, 0));
        return value === void 0 ? void 0 : chunkRow(value);
      },
      chunkParts(path) {
        const out = new SafeList();
        for (const [, value] of kv.list({ prefix: CHUNK + encodePart(path) + SEP })) out[out.length] = chunkRow(value);
        return arrayCopy(out);
      },
      chunkAddText(path, part, txt) {
        addChunk(path, NumberOf(part), stringOf(txt), false);
      },
      chunkAddBin(path, part, bin) {
        addChunk(path, NumberOf(part), residentBytes(bin).slice(), false);
      },
      chunkSetBin(path, part, bin) {
        addChunk(path, NumberOf(part), residentBytes(bin).slice(), true);
      },
      chunkCopy(to, from) {
        const parts = new SafeList();
        for (const [key, value] of kv.list({ prefix: CHUNK + encodePart(from) + SEP })) parts[parts.length] = [key.slice(key.lastIndexOf(SEP) + SEP.length), value];
        for (let i = 0; i < parts.length; i++) {
          if (kv.get(CHUNK_KEYS + encodePart(to) + SEP + parts[i][0]) !== void 0) throw new Error2("UNIQUE constraint failed: chunk.path, chunk.part");
        }
        for (let i = 0; i < parts.length; i++) {
          put(CHUNK + encodePart(to) + SEP + parts[i][0], parts[i][1]);
          put(CHUNK_KEYS + encodePart(to) + SEP + parts[i][0], 1);
        }
      },
      chunkDelete(path) {
        writeRows(path, () => {
          deleteChunks(path);
        });
      },
      dropOwn() {
        const own = ownPaths();
        dropWhere((row) => row[3] !== RK_OWN_WRITE, (path) => !own.has(path));
      },
      dropDated() {
        const own = ownPaths();
        dropWhere((row) => row[3] === RK_OWN_WRITE, (path) => own.has(path));
      },
      dropDatedFiles() {
        const dated = new SafeSet();
        const rows = files();
        for (let i = 0; i < rows.length; i++) if (rows[i][1][3] !== RK_OWN_WRITE) dated.add(rows[i][0]);
        dropWhere((row) => row[3] === RK_OWN_WRITE, (path) => !dated.has(path));
      },
      clear() {
        writeRows(void 0, () => {
          for (const tag of [CHUNK, CHUNK_KEYS, FILE, BY_CKEY]) deleteKeys({ prefix: tag });
        });
        for (const tag of [NS, PAGE, PAGE_ROWS, PAGE_USED]) deleteKeys({ prefix: tag });
        const meta = keysOf({ prefix: META });
        const keep = new SafeList();
        for (let i = 0; i < meta.length; i++) if (meta[i] !== META + "schema") keep[keep.length] = meta[i];
        drop(keep);
      },
      pageGet(path, rev, part) {
        const value = kv.get(PAGE + pageTail(path, rev, part));
        return value === void 0 ? void 0 : value;
      },
      pageUse(path, rev, part, used) {
        const tail = pageTail(path, rev, part);
        const row = kv.get(PAGE_ROWS + tail);
        if (row === void 0) return;
        dropOne(PAGE_USED + pad(row[0]) + SEP + tail);
        put(PAGE_USED + pad(used) + SEP + tail, row[1]);
        put(PAGE_ROWS + tail, [NumberOf(used), row[1]]);
      },
      pagePut(path, rev, part, bin, used) {
        const tail = pageTail(path, rev, part);
        const had = kv.get(PAGE_ROWS + tail);
        const bytes = residentBytes(bin).slice();
        if (had !== void 0) dropOne(PAGE_USED + pad(had[0]) + SEP + tail);
        put(PAGE + tail, bytes);
        put(PAGE_ROWS + tail, [NumberOf(used), bytes.byteLength]);
        put(PAGE_USED + pad(used) + SEP + tail, bytes.byteLength);
        return had === void 0 ? 0 : had[1];
      },
      pageDelete(path, rev, part) {
        const tail = pageTail(path, rev, part);
        const had = kv.get(PAGE_ROWS + tail);
        if (had === void 0) return;
        const keys = new SafeList();
        keys[0] = PAGE + tail;
        keys[1] = PAGE_ROWS + tail;
        keys[2] = PAGE_USED + pad(had[0]) + SEP + tail;
        drop(keys);
      },
      pageOldest(limit) {
        const out = new SafeList();
        for (const [key, value] of kv.list({ prefix: PAGE_USED, limit })) {
          const { path, rev, part: n } = unpage(key.slice(1 + NUMBER));
          out[out.length] = { path, rev, part: n, size: value };
        }
        return arrayCopy(out);
      },
      pageBytes() {
        let n = 0;
        for (const [, value] of kv.list({ prefix: PAGE_ROWS })) n += value[1];
        return n;
      },
      pageMaxUsed() {
        for (const [key] of kv.list({ prefix: PAGE_USED, reverse: true, limit: 1 })) return NumberOf(key.slice(1, 18));
        return 0;
      },
      nsPut(parent, name, kind, size, mode, uid, gid, atime, mtime, ctime, ino, rev, target, dev, nlink) {
        put(nsKey2(parent, name), {
          kind: NumberOf(kind),
          size: NumberOf(size),
          mode: NumberOf(mode),
          uid: NumberOf(uid),
          gid: NumberOf(gid),
          atime: NumberOf(atime),
          mtime: NumberOf(mtime),
          ctime: NumberOf(ctime),
          ino: NumberOf(ino),
          rev: NumberOf(rev),
          target: target == null ? null : stringOf(target),
          dev: NumberOf(dev) || 0,
          nlink: NumberOf(nlink) || 1
        });
      },
      nsGet(parent, name) {
        return kv.get(nsKey2(parent, name));
      },
      nsDelete(parent, name) {
        dropOne(nsKey2(parent, name));
      },
      nsDeleteChildren(parent) {
        deleteKeys({ prefix: nsChildren(parent) });
      },
      nsDeleteParents(from, to) {
        deleteKeys(rangeOf(NS, from, to));
      },
      nsClear() {
        deleteKeys({ prefix: NS });
      },
      nsKeys() {
        const rows = nsRows({ prefix: NS });
        const out = new SafeList();
        for (let i = 0; i < rows.length; i++) out[out.length] = rows[i][0];
        return arrayCopy(out);
      },
      nsOfKind(kind) {
        const rows = nsRows({ prefix: NS });
        const out = new SafeList();
        for (let i = 0; i < rows.length; i++) if (rows[i][1].kind === NumberOf(kind)) out[out.length] = rows[i][0];
        return arrayCopy(out);
      },
      nsUnlisted() {
        const rows = nsRows({ prefix: NS });
        const out = new SafeList();
        for (let i = 0; i < rows.length; i++) {
          const [key, row] = rows[i];
          if (row.kind === NS_DIR && row.target !== null) out[out.length] = { parent: key.parent, name: key.name, target: row.target };
        }
        return arrayCopy(out);
      },
      nsChildren(parent) {
        const out = new SafeList();
        const prefix = nsChildren(parent);
        for (const [key, value] of kv.list({ prefix })) {
          const row = value;
          out[out.length] = { name: decodePart(key.slice(prefix.length)), kind: row.kind, mode: row.mode };
        }
        return arrayCopy(out);
      },
      nsCount() {
        let n = 0;
        for (const _entry of kv.list({ prefix: NS })) n++;
        return n;
      }
    };
  }

  // ../core/dist/vfs/composite.js
  var ANONYMOUS_DEV = 65536;
  var utf8 = new TextEncoder();

  // src/vfs/resident/index.ts
  function dropSqlStore(storage) {
    const exec = storage.sql?.exec;
    if (typeof exec !== "function") return;
    const sql = storage.sql;
    const held = new SafeList();
    for (const row of exec.call(sql, "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('file', 'chunk', 'ns', 'meta', 'page')")) {
      held[held.length] = stringOf(row.name);
    }
    for (let i = 0; i < held.length; i++) exec.call(sql, "DROP TABLE IF EXISTS " + held[i]);
  }
  function createResidentStore(options = {}) {
    const coherence = createCoherence();
    const admission = createAdmission(coherence);
    const namespace = createNamespace(coherence, admission);
    const observeRead = options.observeRead ?? null;
    const cells = createCells(coherence, admission, namespace, observeRead);
    const transport = createTransport(coherence, admission, namespace, cells);
    const sync = createSync(coherence, admission, namespace, cells, transport);
    const pages = createPages(coherence, admission, namespace);
    const view = createView(coherence, admission, namespace, cells, transport, sync, pages);
    const bindTables = (t, heap) => {
      t.dropOwn();
      coherence.bind(t, heap);
      namespace.bind(t);
      pages.reset();
    };
    return {
      bundle: cells.bundle,
      bind(ctx) {
        const storage = ctx?.storage;
        if (!storage || typeof storage.kv?.get !== "function" || typeof storage.put !== "function") {
          throw new Error(
            "Nimbus: this facet has no synchronous key-value storage (ctx.storage.kv); the resident set cannot be served and every sync read would raise EAGAIN"
          );
        }
        dropSqlStore(storage);
        bindTables(kvTables(storage, cells.rowsChanged), null);
      },
      bindInMemory(budget) {
        const t = heapTables(cells.rowsChanged);
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
      view
    };
  }
  return __toCommonJS(index_exports);
})();
