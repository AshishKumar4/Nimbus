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
    procFileGenerator: () => procFileGenerator,
    processFilesystem: () => processFilesystem,
    residentFileCost: () => residentFileCost,
    rootOf: () => rootOf,
    sameEpochs: () => sameEpochs,
    samePosition: () => samePosition,
    utimesRefusal: () => utimesRefusal
  });

  // ../platform/dist/limits.js
  var CHUNK_SIZE = 65536;
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

  // nimbus-launch-captures:launch-captures
  var { ArrayBufferConstructor, ArrayConstructor, ArrayFrom, ArrayIteratorNext, ArrayIteratorPrototype, ArrayPrototypeIndexOf, ArrayPrototypeLastIndexOf, ArrayPrototypePop, ArrayPrototypeToSpliced, ArrayPrototypeWith, ArrayValues, BigInt: BigInt2, BigIntPrototypeToString, Error: Error2, FunctionPrototypeBind, GeneratorPrototypeNext, GeneratorPrototypeReturn, GeneratorPrototypeThrow, JSONParse, JSONStringify, MapConstructor, NumberOf, NumberPrototypeToString, ObjectOf, ObjectPrototype, ObjectPrototypeHasOwnProperty, ObjectPrototypePropertyIsEnumerable, ObjectPrototypePropertyIsEnumerableOf, ObjectPrototypeToString, PromiseConstructor, PromisePrototypeThen, PromiseReject, PromiseResolve, Proxy: Proxy2, RangeError: RangeError2, ReferenceError: ReferenceError2, RegExp, RegExpPrototypeAccessors, RegExpPrototypeExec, SafeAsyncGeneratorPrototype, SafeGeneratorPrototype, SafeList, SafeMap, SafeRegExpPrototype, SafeSet, SafeWeakMap, SafeWeakSet, StringFromCharCode, StringPrototypeCharAt, StringPrototypeCharCodeAt, StringPrototypeIndexOf, StringPrototypeLastIndexOf, StringPrototypeSlice, StringPrototypeSubstr, SymbolConstructor, SymbolPrototypeDescription, SymbolPrototypeToString, SyntaxError: SyntaxError2, TypeError: TypeError2, URIError: URIError2, URL, Uint8ArrayConstructor, arrayBufferByteLength, arrayCopy, arrayIncludes, arrayIndexOf, arrayIsArray, arrayJoin, arrayPop, arrayPush, arrayShift, arraySort, arraySplice, bytesCopy, bytesView, captureStackTraceOf, dataDescriptor, dateNow, decodeURIComponentOf, encodeURIComponentOf, generatorNext, generatorThrow, globalObject, mapFind, mapGet, mapKeyList, mapValueList, mathAbs, mathCeil, mathFloor, mathMax, mathMin, mathTrunc, newTextEncoder, newURL, numberIsFinite, numberIsInteger, numberIsSafeInteger, objectAssign, objectCreate, objectDefineProperties, objectDefineProperty, objectFreeze, objectGetOwnPropertyNames, objectHasOwn, objectIs, objectIsExtensible, objectKeys, objectPreventExtensions, ownField, ownValue, parseFloatOf, parseIntOf, promiseAll, promiseFinally, promiseRace, promiseReject, promiseResolve, promiseSettled, promiseThen, reflectApply, reflectConstruct, reflectDefineProperty, reflectDeleteProperty, reflectGet, reflectGetOwnPropertyDescriptor, reflectGetPrototypeOf, reflectHas, reflectOwnKeys, reflectSet, reflectSetPrototypeOf, regExpExec, safeGenerator, setFind, setForEach, setList, setOfList, setOwnValue, stringCharCodeAt, stringCodePointAt, stringEndsWith, stringIncludes, stringIndexOf, stringLastIndexOf, stringLocaleCompare, stringOf, stringPadStart, stringSlice, stringSplit, stringStartsWith, stringToLowerCase, symbolAsyncIterator, symbolFor, symbolIterator, symbolToStringTag, symbolUnscopables, textEncoderEncode, textEncoderEncodeInto, typedArrayBuffer, typedArrayByteLength, typedArrayByteOffset, typedArrayFill, typedArraySet, useCaptureStackTrace } = __nimbusLaunchCaptures;

  // ../core/dist/vfs/vfs-error.js
  var VFS_ERRNO = {
    E2BIG: -7,
    EPERM: -1,
    ENOENT: -2,
    EIO: -5,
    ENXIO: -6,
    EAGAIN: -11,
    EACCES: -13,
    EBUSY: -16,
    EEXIST: -17,
    EXDEV: -18,
    ENOTDIR: -20,
    EISDIR: -21,
    EINVAL: -22,
    ENOSPC: -28,
    EROFS: -30,
    ELOOP: -40,
    ENAMETOOLONG: -36,
    ENOTEMPTY: -39,
    ENOTSUP: -95,
    ESTALE: -116,
    EBADF: -9,
    EFBIG: -27
  };
  function errnoCodeOf(error) {
    const code = typeof error === "object" && error !== null ? ownField(error, "code") : void 0;
    return typeof code === "string" && regExpExec(/^E[A-Z0-9]+$/, code) !== null ? code : void 0;
  }
  function isVfsErrorCode(code) {
    return typeof code === "string" && objectHasOwn(VFS_ERRNO, code);
  }
  var SYSCALL_VERDICTS = new SafeSet([
    "ENOENT",
    "EEXIST",
    "EISDIR",
    "ENOTDIR",
    "ENOTEMPTY",
    "EBADF",
    "EINVAL",
    "EPERM",
    "EACCES",
    "ELOOP",
    "ENAMETOOLONG",
    "ENOSPC",
    "EROFS",
    "EBUSY",
    "ENOTSUP",
    "EXDEV",
    "ENXIO",
    "E2BIG"
  ]);
  var RENAME_REFUSALS = new SafeSet([
    "EACCES",
    "EPERM",
    "EBUSY",
    "EEXIST",
    "ENOTEMPTY",
    "ENOTDIR",
    "EISDIR",
    "EINVAL",
    "EXDEV",
    "EROFS",
    "ENOSPC"
  ]);
  var VFS_DESCRIPTION = {
    E2BIG: "argument list too long",
    EPERM: "operation not permitted",
    ENOENT: "no such file or directory",
    EIO: "i/o error",
    ENXIO: "no such device or address",
    EAGAIN: "resource temporarily unavailable",
    EACCES: "permission denied",
    EBUSY: "resource busy or locked",
    EEXIST: "file already exists",
    EXDEV: "cross-device link not permitted",
    ENOTDIR: "not a directory",
    EISDIR: "illegal operation on a directory",
    EINVAL: "invalid argument",
    ENOSPC: "no space left on device",
    EROFS: "read-only file system",
    ELOOP: "too many symbolic links encountered",
    ENAMETOOLONG: "name too long",
    ENOTEMPTY: "directory not empty",
    ENOTSUP: "operation not supported on socket",
    ESTALE: "stale file handle",
    EBADF: "bad file descriptor",
    EFBIG: "file too large"
  };
  var ERRNO_DESCRIPTION = {
    ...VFS_DESCRIPTION,
    EBADF: "bad file descriptor",
    ENODATA: "no data available",
    ENOSYS: "function not implemented",
    EMFILE: "too many open files",
    ENFILE: "file table overflow",
    ENOMEM: "not enough memory",
    ETXTBSY: "text file is busy",
    EMLINK: "too many links",
    ENODEV: "no such device",
    ESPIPE: "invalid seek",
    EPIPE: "broken pipe",
    EINTR: "interrupted system call",
    ERANGE: "result too large",
    EOVERFLOW: "value too large for defined data type",
    ETIMEDOUT: "connection timed out",
    ECANCELED: "operation canceled",
    EFAULT: "bad address in system call argument",
    EHOSTDOWN: "host is down"
  };
  function errnoDescription(code) {
    return objectHasOwn(ERRNO_DESCRIPTION, code) ? ERRNO_DESCRIPTION[code] : void 0;
  }
  var OTHER_ERRNO = {
    ENODATA: -61,
    ENOSYS: -38,
    EMFILE: -24,
    ENFILE: -23,
    ENOMEM: -12,
    ETXTBSY: -26,
    EMLINK: -31,
    ENODEV: -19,
    ESPIPE: -29,
    EPIPE: -32,
    EINTR: -4,
    ERANGE: -34,
    EOVERFLOW: -75,
    ETIMEDOUT: -110,
    ECANCELED: -125,
    EFAULT: -14,
    EHOSTDOWN: -112
  };
  function errnoOf(code) {
    if (isVfsErrorCode(code))
      return VFS_ERRNO[code];
    return objectHasOwn(OTHER_ERRNO, code) ? OTHER_ERRNO[code] : void 0;
  }
  function systemErrorMessage(code, said, path, dest) {
    return `${code}: ${said}${path !== void 0 ? ` '${path}'` : ""}${dest !== void 0 ? ` -> '${dest}'` : ""}`;
  }
  function fsError(code, syscall, path, dest, options = {}) {
    const given = ownValue(options, "detail");
    const cause = ownValue(options, "cause");
    const words = given ?? errnoDescription(code);
    const error = new Error2(systemErrorMessage(code, words === void 0 ? syscall : `${words}, ${syscall}`, path, dest), cause === void 0 ? void 0 : { cause });
    const errno2 = errnoOf(code);
    return objectAssign(error, {
      code,
      ...errno2 === void 0 ? {} : { errno: errno2 },
      syscall,
      ...path === void 0 ? {} : { path },
      ...dest === void 0 ? {} : { dest },
      ...given === void 0 ? {} : { detail: given }
    });
  }

  // ../core/dist/runtime/storage-ledger.js
  var LEDGER_ROW_BYTES = 256;

  // ../core/dist/constants.js
  var NODE_RELEASE = "22.23.4";
  var NODE_VERSION = `v${NODE_RELEASE}`;
  var FS_READ_BATCH_PATH_LIMIT = 1024;
  var FS_READ_BATCH_REQUEST_BYTES = 4 * 1024 * 1024;
  var FS_LIST_PAGE_LIMIT = 8192;
  var DIRECTORY_PREFETCH_LIMIT = 128;
  var DIRECTORY_BATCH_LIMIT = 64;
  var DIRECTORY_END_WAIT_MS = 1e4;
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
  var scratch;
  function utf8Length(text) {
    if (text.length >= UTF8_LONG_UNITS)
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
    scratch ??= new Uint8Array(UTF8_SCRATCH_BYTES);
    let bytes = 0;
    for (let read = 0; read < text.length; ) {
      const done = encoder.encodeInto(read === 0 ? text : text.slice(read), scratch);
      read += done.read;
      bytes += done.written;
    }
    return bytes;
  }

  // src/vfs/resident/cell-cost.ts
  var encoder2;
  var scratch2;
  function utf8Length2(text) {
    if (text.length >= UTF8_LONG_UNITS) {
      scratch2 ??= new Uint8ArrayConstructor(UTF8_SCRATCH_BYTES);
      encoder2 ??= newTextEncoder();
      let bytes2 = 0;
      for (let read = 0; read < text.length; ) {
        const done = textEncoderEncodeInto(encoder2, read === 0 ? text : stringSlice(text, read), scratch2);
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
  var SQLITE_PAGE_BYTES = 4096;
  function residentCellCost(cell) {
    const isText = typeof cell === "string";
    const size = isText ? utf8Length2(cell) : typedArrayByteLength(residentBytes(cell));
    const chunks = isText ? textChunkEnds(cell).length : mathMax(1, mathCeil(size / RESIDENT_CHUNK_BYTES));
    return mathCeil(size * 1.01) + (chunks + 1) * RESIDENT_ROW_BYTES + SQLITE_PAGE_BYTES;
  }
  function residentChunkCost(size) {
    return mathCeil(size * 1.01) + RESIDENT_ROW_BYTES + SQLITE_PAGE_BYTES;
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
    let shedHeld = null;
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
      if (cap === null) return promiseResolve(true);
      if (facet === null || !asked || typeof asked.fsStorageGrant !== "function") return promiseResolve(false);
      if (grantAsk) {
        return promiseThen(grantAsk, () => dbBytes() + reservedBytes + bytes <= cap || askGrant(bytes));
      }
      const want = mathMax(0, dbBytes() + reservedBytes + bytes - cap);
      const named = facet;
      grantAsk = promiseFinally((async () => {
        try {
          const answer = await asked.fsStorageGrant(named, want, dbBytes());
          cap += NumberOf(answer && answer.granted) || 0;
          if (answer && typeof answer.available === "number") available = answer.available;
        } catch {
        }
      })(), () => {
        grantAsk = null;
      });
      return promiseThen(grantAsk, () => dbBytes() + reservedBytes + bytes <= cap);
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
        cap = NumberOf(budget);
        namespaceOverlayBytes = 0;
        namespaceReserveBytes = 0;
        pinnedBytes = 0;
      },
      setStorage(storage, given) {
        supervisor = given || null;
        const allowance = typeof storage === "object" && storage !== null ? storage : null;
        const room = allowance === null ? void 0 : ownField(allowance, "available");
        available = typeof room === "number" ? room : null;
        const named = allowance === null ? void 0 : ownField(allowance, "facet");
        const grant = allowance === null ? void 0 : ownField(allowance, "grant");
        if (typeof named !== "string" || typeof grant !== "number") return;
        facet = named;
        cap = dbBytes() + grant;
      },
      storageCap() {
        return cap;
      },
      get available() {
        return available;
      },
      pin(bytes) {
        if (!inHeap && pinnedBytes + heldBytes + bytes > FACET_OWN_WRITE_MEMORY_BYTES) shedHeld?.(pinnedBytes + heldBytes + bytes - FACET_OWN_WRITE_MEMORY_BYTES);
        if (inHeap ? !fits(bytes, false) : pinnedBytes + heldBytes + bytes > FACET_OWN_WRITE_MEMORY_BYTES) return false;
        pinnedBytes += bytes;
        return true;
      },
      setHeldShedder(shed) {
        shedHeld = shed;
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
        return inHeap ? mathMax(0, NumberOf(cap) - tablesBytes() - namespaceOverlayBytes - namespaceReserveBytes) : mathMax(0, maxBytes - pinnedBytes);
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
        if (cap === null) return promiseResolve(true);
        if (reserveQueue.length === 0 && holdRoom(path, bytes)) return promiseResolve(true);
        return new PromiseConstructor((resolve) => {
          arrayPush(reserveQueue, { path, bytes, resolve });
          void serveReserves();
        });
      },
      release,
      fits,
      ensureRoom,
      /** Room for what an ACQUIRE answer pushes, asked for before it is applied. */
      async roomForPushed(result) {
        const listed = cap === null || typeof result !== "object" || result === null ? void 0 : ownField(result, "paths");
        if (cap === null || !arrayIsArray(listed)) return;
        const paths = listed;
        let bytes = 0;
        for (let i = 0; i < paths.length; i++) {
          const entry = paths[i];
          const held = typeof entry === "object" && entry !== null ? ownField(entry, "bytes") : void 0;
          if (held != null) bytes += residentCellCost(residentBytes(held));
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
  function modeAllows(stat, want, cred) {
    const mode = ownValue(stat, "mode");
    if (mode === void 0)
      return true;
    return posixAccess({ mode, uid: ownValue(stat, "uid") ?? -1, gid: ownValue(stat, "gid") ?? -1, type: stat.type }, want, cred);
  }
  function stickyRefusal(parent, entry, cred) {
    return (parent.mode & 512) !== 0 && cred.uid !== 0 && cred.uid !== parent.uid && cred.uid !== entry.uid ? "EPERM" : null;
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
  function explicitTimes(atime, mtime) {
    return typeof atime === "number" || typeof mtime === "number";
  }
  function timeAt(time, kept, now) {
    return time === "omit" ? kept : time === "now" ? now : mathTrunc(time);
  }
  function utimesRefusal(entry, explicit, cred) {
    if (!explicit)
      return cred.uid === 0 || cred.uid === entry.uid || posixAccess(entry, 2, cred) ? null : "EACCES";
    return cred.uid !== 0 && cred.uid !== entry.uid ? "EPERM" : null;
  }

  // src/vfs/resident/permissions.ts
  var groupsOf = (cred) => {
    const groups = ownValue(cred, "groups");
    const out = new SafeList();
    if (arrayIsArray(groups)) for (let i = 0; i < groups.length; i++) out[i] = NumberOf(groups[i]);
    return out;
  };
  function namespaceAllows(cred, meta, type, want) {
    if (!cred) return true;
    return posixAccess(
      { mode: NumberOf(meta === void 0 ? void 0 : ownValue(meta, "mode")), uid: NumberOf(meta === void 0 ? void 0 : ownValue(meta, "uid")), gid: NumberOf(meta === void 0 ? void 0 : ownValue(meta, "gid")), type },
      want,
      { uid: NumberOf(cred.uid), gid: NumberOf(cred.gid), groups: groupsOf(cred) }
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
    const table = ownField(value, "table");
    const feeds = ownField(value, "feeds");
    if (typeof table !== "string" || feeds === null || typeof feeds !== "object")
      return false;
    const points = objectKeys(feeds);
    for (let i = 0; i < points.length; i++) {
      const feed = feeds[points[i]];
      if (feed === null || typeof feed !== "object" || typeof ownField(feed, "epoch") !== "string" || typeof ownField(feed, "cursor") !== "number")
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
  var mountPoints = new SafeWeakMap();
  function mountPointsOf(position) {
    let points = mountPoints.get(position.feeds);
    if (points === void 0) {
      const all = objectKeys(feedsOf(position));
      const found = [];
      for (let i = 0; i < all.length; i++) {
        if (all[i] !== ROOT_FEED)
          found[found.length] = { point: all[i], name: stringSlice(all[i], 1), first: stringCharCodeAt(all[i], 1) };
      }
      points = found;
      mountPoints.set(position.feeds, points);
    }
    return points;
  }
  function feedPointOf(position, key) {
    const points = mountPointsOf(position);
    if (points.length === 0)
      return ROOT_FEED;
    const at = key.length > 0 && stringCharCodeAt(key, 0) === 47 ? 1 : 0;
    const first = stringCharCodeAt(key, at);
    const rest = key.length - at;
    let found = null;
    for (let i = 0; i < points.length; i++) {
      const mount = points[i];
      const length = mount.name.length;
      if (mount.first !== first || rest < length || found !== null && length <= found.name.length)
        continue;
      if ((rest === length || stringCharCodeAt(key, at + length) === 47) && stringStartsWith(key, mount.name, at))
        found = mount;
    }
    return found === null ? ROOT_FEED : found.point;
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
  function abovePoint(position, key) {
    const path = key.length > 0 && stringCharCodeAt(key, 0) === 47 ? key : "/" + key;
    const under = path === "/" ? "/" : path + "/";
    const points = mountPointsOf(position);
    for (let i = 0; i < points.length; i++) {
      if (points[i].point.length > under.length && stringStartsWith(points[i].point, under))
        return true;
    }
    return false;
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
    const payload = (cell) => cell.txt != null ? utf8Length2(cell.txt) : cell.bin ? typedArrayByteLength(cell.bin) : 0;
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
    const owned2 = (bin) => {
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
      const row = dir === void 0 ? void 0 : dir.get(name);
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
        addChunk(path, NumberOf(part), { txt: null, bin: owned2(bin) }, false);
      },
      chunkSetBin(path, part, bin) {
        addChunk(path, NumberOf(part), { txt: null, bin: owned2(bin) }, true);
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
        const row = pages.get(pageKey(path, rev, part));
        return row === void 0 ? void 0 : bytesCopy(row.bin);
      },
      pageUse(path, rev, part, stamp) {
        const row = pages.get(pageKey(path, rev, part));
        if (row !== void 0) row.used = stamp;
      },
      pagePut(path, rev, part, bin, stamp) {
        const key = pageKey(path, rev, part);
        const had = pages.get(key);
        const bytes = bytesCopy(residentBytes(bin));
        if (had !== void 0) used -= RESIDENT_ROW_BYTES + typedArrayByteLength(had.bin);
        pages.set(key, { path, rev, part, bin: bytes, used: stamp });
        used += RESIDENT_ROW_BYTES + typedArrayByteLength(bytes);
        return had === void 0 ? 0 : typedArrayByteLength(had.bin);
      },
      pageDelete(path, rev, part) {
        const key = pageKey(path, rev, part);
        const had = pages.get(key);
        if (had === void 0) return;
        pages.delete(key);
        used -= RESIDENT_ROW_BYTES + typedArrayByteLength(had.bin);
      },
      pageOldest(limit) {
        const rows = arraySort(mapValueList(pages), (a, b) => a.used - b.used || cmp(a.path, b.path) || a.rev - b.rev || a.part - b.part);
        const out = new SafeList();
        for (let i = 0; i < rows.length && i < limit; i++) out[out.length] = { path: rows[i].path, rev: rows[i].rev, part: rows[i].part, size: typedArrayByteLength(rows[i].bin) };
        return arrayCopy(out);
      },
      pageBytes() {
        let n = 0;
        pages.forEach((row) => {
          n += typedArrayByteLength(row.bin);
        });
        return n;
      },
      pageMaxUsed() {
        let n = 0;
        pages.forEach((row) => {
          n = mathMax(n, row.used);
        });
        return n;
      },
      nsPut(parent, name, kind, size, mode, uid, gid, atime, mtime, ctime, ino, rev, target, dev, nlink) {
        let dir = ns.get(parent);
        const previous = dir === void 0 ? void 0 : dir.get(name);
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
  function ownValue2(record, key) {
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
        dev: NumberOf(ownValue2(stat, "dev")) || 0,
        nlink: NumberOf(ownValue2(stat, "nlink")) || 1
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
      const dev = NumberOf(ownValue2(stat, "dev")) || 0;
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
        NumberOf(ownValue2(stat, "nlink")) || 1
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
        if (found === "ELOOP" || ownValue2(found, "own") !== void 0 || found.table === null) return null;
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
        if (!stat || !numberIsInteger(NumberOf(ownValue2(stat, "mode"))) || !numberIsInteger(NumberOf(ownValue2(stat, "uid"))) || !numberIsInteger(NumberOf(ownValue2(stat, "gid")))) return false;
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
          const stat2 = ownValue2(entry, "stat");
          if (stat2) setRoot(stat2, entry.rev);
          return null;
        }
        const stat = ownValue2(entry, "stat");
        if (stat === null) {
          moved2(true);
          deleteTree(t, k, true);
          return null;
        }
        const before = nsRowAt(t, k);
        if (stat === void 0 || !tryPut(t, k, stat, entry.rev, ownValue2(entry, "linkTarget"))) {
          moved2(true);
          return null;
        }
        const after3 = nsRowAt(t, k);
        if (after3 === void 0 || after3.kind !== NS_DIR) {
          moved2(true);
          deleteTree(t, k, false);
          return null;
        }
        const was = before !== void 0 && traversable(before);
        const now = traversable(after3);
        moved2(!(before !== void 0 && before.kind === NS_DIR && before.ino === after3.ino && before.dev === after3.dev && was === now && !ownValue2(entry, "structural") && !ownValue2(entry, "subtree")));
        if (lazy) {
          if (ownValue2(entry, "structural") || ownValue2(entry, "subtree") || was !== now) deleteTree(t, k, false);
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
            const linkTarget = ownValue2(entry, "linkTarget");
            const unlistedAt = ownValue2(entry, "unlisted");
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
          const linkTarget = ownValue2(entry, "linkTarget");
          const unlistedAt = ownValue2(entry, "unlisted");
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
          mode: held ? held.mode : 33206 & ~NumberOf((cred === null ? void 0 : ownValue2(cred, "umask")) ?? 18),
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
        const target = ownValue2(stat, "linkTarget") ?? ownValue2(stat, "target") ?? null;
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
  function ownValue3(record, key) {
    return objectHasOwn(record, key) ? record[key] : void 0;
  }
  function createCells(coherence, admission, namespace, observeRead) {
    const held = new SafeMap();
    const unheld = new SafeSet();
    const cellSize = (cell) => typeof cell === "string" ? cell.length * 3 : typedArrayByteLength(residentBytes(cell));
    const encoder6 = newTextEncoder();
    const encodeText = (text) => textEncoderEncode(encoder6, text);
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
    const shedTo = (under) => {
      held.forEach((old, oldest) => {
        if (admission.heldBytes <= under) return;
        held.delete(oldest);
        admission.addHeld(-cellSize(old.cell));
        unheld.add(oldest);
      });
    };
    admission.setHeldShedder((bytes) => shedTo(admission.heldBytes - bytes));
    const hold = (path, cell, rev = RK_OWN_WRITE) => {
      forgetHeld(path);
      const size = cellSize(cell);
      const limit = admission.heldLimit(FACET_OWN_WRITE_MEMORY_BYTES);
      if (size > limit) {
        unheld.add(path);
        return;
      }
      if (admission.heldBytes + size > limit) shedTo(limit - size);
      held.set(path, { cell, rev });
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
      if (!admission.fits(residentChunkCost(typedArrayByteLength(bytes)))) return false;
      t.chunkSetBin(path, part, bytes);
      return true;
    };
    const admit = (result) => {
      const t = coherence.tables("admit");
      const dropped = new SafeList();
      const relist = new SafeList();
      let kept = 0, pushed = 0;
      const position = result ? ownValue3(result, "position") : void 0;
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
      let followable = !!result && !result.poison && (ownValue3(result, "namespace") === true || paths !== null && paths.length === 0);
      if (followable && paths !== null) {
        for (let i = 0; i < paths.length; i++) {
          const stat = ownValue3(paths[i], "stat");
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
          const subtree = ownValue3(entry, "subtree");
          const stat = ownValue3(entry, "stat");
          if (subtree || ownValue3(entry, "structural")) {
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
          const contentKey = ownValue3(entry, "contentKey");
          if (isHeld && heldKey !== null && contentKey != null && heldKey === stringOf(contentKey) && namespace.readable(stat)) {
            t.fileSetRev(path, entryRev);
            kept++;
            continue;
          }
          const bytes = ownValue3(entry, "bytes");
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
      keep(t, path, bytes, rev) {
        if (!put(t, path, bytes, rev)) hold(path, bytes, rev);
      },
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
        const owned2 = new SafeList();
        filling.forEach((_fill, at) => {
          owned2[owned2.length] = at;
        });
        for (let i = 0; i < owned2.length; i++) disown(owned2[i]);
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
      provenance: (path) => coherence.require().fileRev(path) ?? held.get(path)?.rev,
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
        read = null;
      },
      bound: () => t !== null,
      serving: () => t !== null && !isSealed,
      tables(doing) {
        if (t === null) throw new Error2("Nimbus: " + doing + " before the store was bound");
        return t;
      },
      get heap() {
        return heap;
      },
      require() {
        if (t === null) {
          throw new Error2(
            "Nimbus: the resident store was read before its facet bound its storage. store.bind(ctx) must run in the process DO constructor, ahead of the program."
          );
        }
        if (isSealed) {
          throw new Error2(
            "Nimbus: the resident store is sealed \u2014 " + sealReason + ". cells.admit(fsAcquire(...)) must apply the authority's delta before the program runs; serving a row now would serve bytes of unknown age."
          );
        }
        return t;
      },
      sealed: () => isSealed ? sealReason : null,
      seal(reason) {
        isSealed = true;
        sealReason = stringOf(reason || "resealed");
        read = null;
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
        if (read !== null && read.tables === t) return read.cursor;
        const text = t.metaGet("position");
        let cursor = null;
        if (text !== void 0) {
          try {
            const parsed = JSONParse(text);
            cursor = isFeedPosition(parsed) ? parsed : null;
          } catch {
            cursor = null;
          }
        }
        read = { tables: t, cursor };
        return cursor;
      },
      writeCursor(tables, cursor) {
        tables.metaSet("position", JSONStringify(cursor));
        read = { tables, cursor };
      }
    };
  }

  // ../core/dist/vfs/vfs.js
  var encoder3 = new TextEncoder();
  var decoder = new TextDecoder();
  var S_IFMT = 61440;
  var S_IFREG = 32768;
  var S_IFDIR = 16384;
  var S_IFCHR = 8192;
  var S_IFLNK = 40960;
  function copiedPermissions(mode, directory) {
    return mode & (directory ? 1023 : 511);
  }
  function copyfileMode(mode, size, uid) {
    const bits = mode & 4095;
    if (uid === 0 || size === 0)
      return bits;
    return bits & ~(2048 | (bits & 8 ? 1024 : 0));
  }
  function isCharacterDevice(mode) {
    return mode !== void 0 && (mode & S_IFMT) === S_IFCHR;
  }

  // ../core/dist/vfs/dirent-type.js
  var DIRENT_TYPES = {
    file: { format: S_IFREG, node: "isFile" },
    directory: { format: S_IFDIR, node: "isDirectory" },
    symlink: { format: S_IFLNK, node: "isSymbolicLink" },
    character: { format: S_IFCHR, node: "isCharacterDevice" },
    block: { format: 24576, node: "isBlockDevice" },
    fifo: { format: 4096, node: "isFIFO" },
    socket: { format: 49152, node: "isSocket" }
  };

  // src/vfs/resident/view.ts
  function direntTypeOfRow(kind, mode) {
    if (kind === NS_DIR) return "directory";
    if (kind === NS_LINK) return "symlink";
    const format = NumberOf(mode) & S_IFMT;
    for (const type in DIRENT_TYPES) if (DIRENT_TYPES[type].format === format) return type;
    return "file";
  }
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
      const news = new SafeList();
      for (let i = 0; i < answer.paths.length; i++) {
        const entry = answer.paths[i];
        if (entry.rev > floorFor(answer.position, cursor, entry.path)) news[news.length] = entry;
      }
      return news.length === answer.paths.length ? answer : { ...answer, paths: arrayCopy(news) };
    };
    const delivered = (given) => {
      if (!given || typeof given !== "object") return null;
      const { args, answer } = given;
      const cursor = coherence.cursor();
      if (cursor === null || !args || !answer || answer.poison === true || !arrayIsArray(answer.paths)) return null;
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
        const known = namespace.root();
        if (known === void 0 || known.rev < (NumberOf(root.revision) || 0)) namespace.setRoot(root, root.revision);
        namespace.setCred(cred);
        const encoder6 = new TextEncoder();
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
          if (!repaired || !ownValue(repaired, "cursor")) {
            if (answer !== null) cells.admit(answer);
            else cells.dropDated();
            try {
              repaired = await sync.synchronize(supervisor);
            } catch {
              repaired = null;
            }
          }
          repairOwed = !(repaired && ownValue(repaired, "cursor"));
        };
        const repair = (answer) => {
          if (repairing === null) repairing = promiseFinally(runRepair(answer), () => {
            repairing = null;
          });
          return repairing;
        };
        const refetching = new SafeMap();
        const refetch = (keys) => {
          const done = new SafeList();
          if (keys.length === 0) return done;
          const read = promiseThen(sync.refillFromNamespace(supervisor, keys), void 0, () => void 0);
          const t = coherence.require();
          for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            const record = { rev: nsRowAt(t, k)?.rev ?? 0, read, done: promiseResolve() };
            record.done = promiseFinally(promiseThen(promiseThen(read, () => {
              const newer = refetching.get(k);
              const waits = new SafeList();
              waits[0] = newer !== void 0 && newer !== record ? newer.read : void 0;
              waits[1] = repairing ?? void 0;
              return promiseAll(waits);
            }), () => void 0, () => void 0), () => {
              if (refetching.get(k) === record) refetching.delete(k);
            });
            refetching.set(k, record);
            done[i] = record.done;
          }
          return done;
        };
        const enumerated = async (first, lease) => {
          const joined = new SafeList();
          refetching.forEach((record) => {
            joined[joined.length] = record.done;
          });
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
          const named = new SafeList();
          for (let i = 0; i < answer.paths.length; i++) named[i] = nsKey(answer.paths[i].path);
          const again = new SafeList();
          for (let i = 0; i < applied.dropped.length; i++) again[again.length] = applied.dropped[i];
          const fetching = mapKeyList(refetching);
          for (let i = 0; i < fetching.length; i++) {
            const k = fetching[i];
            if (arrayIncludes(applied.dropped, k)) continue;
            for (let j = 0; j < named.length; j++) {
              const at = named[j];
              if (at === k || at === "" || stringStartsWith(k, at + "/")) {
                again[again.length] = k;
                break;
              }
            }
          }
          const waits = refetch(again);
          for (let i = 0; i < joined.length; i++) waits[waits.length] = joined[i];
          await promiseAll(waits);
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
          device: NumberOf(device),
          cred: { uid: NumberOf(cred.uid), gid: NumberOf(cred.gid), groups: arrayCopy(groupsOf(cred)) },
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
              target: row.target == null ? null : stringOf(row.target)
            };
          },
          children(k) {
            if (!namespace.isListed(k)) return void 0;
            const listed = namespace.children(k);
            const entries = [];
            for (let i = 0; i < listed.length; i++) entries[entries.length] = { name: listed[i].name, type: direntTypeOfRow(listed[i].kind, listed[i].mode) };
            return entries;
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
            if (cell === void 0 || typeof cell === "object" && objectHasOwn(cell, "error")) return void 0;
            return typeof cell === "string" ? encoder6.encode(cell) : cell;
          },
          async fill(k, entry) {
            const cursor = coherence.cursor();
            if (cursor === null) return null;
            const fetched = await transport.fetchFiles(supervisor, [{ path: k, size: entry.size, rev: entry.revision, epoch: rootEpochFor(cursor, k), ckey: null, version: entry }]);
            const bytes = view.content(k, entry.revision);
            const outdated = ownValue(fetched, "outdated");
            return bytes !== void 0 ? bytes : (outdated === void 0 ? void 0 : outdated.get(k)) ?? null;
          },
          pages: (k, rev, size, first, last) => pages.read(supervisor, k, rev, size, first, last),
          // Many files in batched round trips (read-ahead, core runtime/wasi/resident-filesystem.ts).
          async fillMany(files) {
            const cursor = coherence.cursor();
            if (cursor === null || files.length === 0) return;
            const wanted = new SafeList();
            for (let i = 0; i < files.length; i++) {
              const k = files[i][0];
              const entry = files[i][1];
              wanted[i] = { path: k, size: entry.size, rev: entry.revision, epoch: rootEpochFor(cursor, k), ckey: null, version: entry };
            }
            await transport.fetchFiles(supervisor, wanted);
          },
          acquireArgs: () => argsNow(),
          repairOwed: () => repairOwed,
          async barrier(options = {}) {
            const given = ownValue(options, "answer");
            const lease = ownValue(options, "lease");
            const standIn = given === void 0 ? delivered(ownValue(options, "delivered")) : null;
            const answer = given !== void 0 ? current(given) : standIn ?? await acquire(lease);
            const result = namespace.lazy ? await lazily(answer) : await enumerated(answer, lease);
            const dropped = answer === null && given === void 0 && standIn === null;
            return { ...result, ...standIn === null ? {} : { fromDelivery: true }, ...dropped ? { dropped: true } : {} };
          },
          cursor: () => coherence.cursor(),
          reserve: (bytes) => admission.pin(bytes),
          release: (bytes) => admission.unpin(bytes),
          keep(k, revision, bytes) {
            const row = nsRowAt(coherence.require(), k);
            if (row === void 0 || row.rev !== revision || view.content(k, revision) !== void 0) return;
            cells.keep(coherence.require(), k, new Uint8ArrayConstructor(bytes), revision);
          },
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
      const half = admission.inHeap && admission.cap !== null ? mathFloor(admission.cap / 2) : Infinity;
      const share = admission.available === null ? Infinity : mathFloor(RESIDENT_PAGE_CACHE_FREE_SHARE * (held() + admission.available));
      return mathMin(RESIDENT_PAGE_CACHE_BYTES, half, share);
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
      const size = typedArrayByteLength(bytes);
      const limit = bound();
      if (size > limit) return false;
      while (held() + size > limit) {
        const oldest = t.pageOldest(16);
        if (oldest.length === 0) break;
        for (let i = 0; i < oldest.length; i++) {
          const row = oldest[i];
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
      const out = new SafeList(last - first + 1);
      const missing = new SafeList();
      for (let part = first; part <= last; part++) {
        const page = get(keyed, rev, part);
        if (page !== void 0) out[part - first] = page;
        else missing[missing.length] = part;
      }
      const perBatch = mathMax(1, mathMin(FS_READ_BATCH_PATH_LIMIT, mathFloor(FS_READ_BATCH_REQUEST_BYTES / RESIDENT_PAGE_BYTES)));
      for (let at = 0; at < missing.length; at += perBatch) {
        const batch = new SafeList();
        for (let i = at; i < missing.length && i < at + perBatch; i++) batch[batch.length] = missing[i];
        const ranges = new SafeList();
        let room = 0;
        for (let i = 0; i < batch.length; i++) {
          const offset = batch[i] * RESIDENT_PAGE_BYTES;
          ranges[i] = { path: "/" + k, offset, length: mathMin(RESIDENT_PAGE_BYTES, mathMax(0, size - offset)), expectedEpoch: epoch, expectedRevision: rev };
          room += ranges[i].length + RESIDENT_ROW_BYTES;
        }
        await admission.ensureRoom(room);
        let results;
        try {
          results = await supervisor.fsReadBatch(arrayCopy(ranges));
        } catch {
          return null;
        }
        if (!arrayIsArray(results) || results.length !== ranges.length) return null;
        for (let i = 0; i < batch.length; i++) {
          const entry = results[i];
          if (!entry || entry.error || entry.bytes == null) return null;
          const bytes = residentBytes(entry.bytes);
          if (typedArrayByteLength(bytes) !== ranges[i].length) return null;
          out[batch[i] - first] = bytes;
          if (learning.installs(k)) put(keyed, rev, batch[i], bytes);
        }
      }
      return { pages: arrayCopy(out), fetched: missing.length };
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
  function ownValue4(record, key) {
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
      let after3 = prefix;
      let done = false;
      for (let page = 0; page < MAX_LIST_PAGES && !done; page++) {
        let listed;
        try {
          listed = await reflectApply(fsList, supervisor, [after3, FS_LIST_PAGE_LIMIT]);
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
              incomingBytes += namespaceRowBytes(nsParent(k), nsName(k), ownValue4(entry, "linkTarget") ?? ownValue4(entry, "unlisted"));
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
        else after3 = listed.next;
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
        namespace.put(t, nsKey(entry.path), entry.stat, entry.rev, ownValue4(entry, "linkTarget"), ownValue4(entry, "unlisted") ?? null);
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
      const served = new SafeMap();
      const files = new SafeList();
      const later = new SafeList();
      const fetching = new SafeSet();
      for (let i = 0; i < wantedFiles.length; i++) {
        const file = wantedFiles[i];
        const ckey = ownValue4(file, "ckey");
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
        const version = dated ? null : ownValue4(file, "version") ?? ownValue4(file, "stat") ?? null;
        const ckey = ownValue4(file, "ckey") ?? null;
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
        let room = 0;
        for (let i = 0; i < batch.length; i++) room += residentChunkCost(batch[i].length);
        if (!await admission.ensureRoom(room)) {
          let admitted = 0;
          for (let fits = 0; admitted < batch.length; admitted++) {
            fits += residentChunkCost(batch[admitted].length);
            if (!admission.fits(fits, false)) break;
          }
          for (let i = admitted; i < batch.length; i++) failedPaths.add(batch[i].path);
          if (admitted === 0) continue;
          batch.length = admitted;
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
          const entry = results && ownValue4(results, i);
          const error = entry && ownValue4(entry, "error");
          if (!entry || error) {
            const code = error ? ownField(error, "code") : void 0;
            if (code === "EACCES" && range.part === 0) {
              cells.put(t, range.path, { error: "EACCES" }, range.rev);
              filled++;
            } else failedPaths.add(range.path);
            continue;
          }
          const bytes2 = ownValue4(entry, "bytes");
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
            if (range.parts === 1) served.set(range.path, chunk);
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
        if (!outdated(t, learning, file.path, file.rev) && cells.copyByKey(t, file.path, ownValue4(file, "ckey"), file.rev)) copied++;
        else failed++;
      }
      if (ranges.length > 0) await admission.reportSize();
      return {
        requested,
        filled: filled + copied,
        failed,
        bytes: fetchedBytes,
        ranges: ranges.length,
        copied,
        ...served.size === 0 ? {} : { outdated: served }
      };
    };
    const enumerate = async (supervisor) => {
      const t = coherence.tables("enumerate");
      const entries = new SafeList();
      const names = new SafeList();
      let namespaceBytes = 0;
      let after3 = null;
      let cursor = null;
      const fsList = method(supervisor, "fsList");
      if (typeof fsList !== "function") throw new TypeError2("supervisor.fsList is not a function");
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const listed = await reflectApply(fsList, supervisor, [after3, FS_LIST_PAGE_LIMIT]);
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
              if (key) namespaceBytes += namespaceRowBytes(nsParent(key), nsName(key), ownValue4(entry, "linkTarget") ?? ownValue4(entry, "unlisted"));
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
          const contentKey = ownValue4(entry, "contentKey");
          entries[entries.length] = { path, size, rev, epoch: rootEpochFor(cursor, path), ckey: contentKey == null ? null : stringOf(contentKey), stat: entry.stat ?? null };
        }
        if (listed.next === null || listed.next === void 0) {
          return { entries: arrayCopy(entries), names: arrayCopy(names), namespaceBytes, cursor, complete: true, reason: null };
        }
        after3 = listed.next;
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
          const answer = ownValue4(answers, i);
          const stat = answer && ownValue4(answer, "stat");
          if (!answer || ownValue4(answer, "error") || stat === null || stat === void 0 || !nsDescribes(stat)) break;
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
          const lastAnswer = ownValue4(answers, batch.length - 1);
          const before = lastAnswer && ownValue4(lastAnswer, "stat");
          const read = ownValue4(answers, batch.length);
          const after3 = ownValue4(answers, batch.length + 1);
          const content = read && !ownValue4(read, "error") && ownValue4(read, "bytes");
          const bytes = content ? residentBytes(content) : null;
          const size = bytes === null ? 0 : typedArrayByteLength(bytes);
          const afterStat = after3 && !ownValue4(after3, "error") ? ownValue4(after3, "stat") : null;
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
            const answer = ownValue4(answers, j);
            if (!answer || ownValue4(answer, "error")) return false;
            const stat = ownValue4(answer, "stat");
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
          const unlisted = ownValue4(entry, "unlisted");
          if (!namespace.tryPut(t, k, entry.stat, entry.rev, ownValue4(entry, "linkTarget"), unlisted ?? null)) return false;
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
    let plan = new SafeSet();
    let manifests = null;
    const isManifest = (path) => (path === "package.json" || stringEndsWith(path, "/package.json")) && !stringIncludes("/" + path, "/.git/");
    const pushable = (path) => {
      for (let i = 0; i < pushRoots.length; i++) {
        const root = pushRoots[i];
        if (root !== "" && path !== root && !stringStartsWith(path, root + "/")) continue;
        const rest = root === "" ? path : stringSlice(path, root.length + 1);
        const segments = stringSplit(rest, "/");
        let excluded = false;
        for (let j = 0; j < segments.length && !excluded; j++) excluded = arrayIncludes(PUSH_EXCLUDE, segments[j]);
        if (!excluded) return true;
      }
      return false;
    };
    const acquireOptions = () => pushRoots.length > 0 ? { namespace: true, push: { roots: pushRoots, exclude: PUSH_EXCLUDE } } : { namespace: true };
    const applyAcquire = async (supervisor, result) => {
      await admission.roomForPushed(result);
      const applied = cells.admit(result);
      for (let i = 0; i < applied.relist.length; i++) {
        const dir = applied.relist[i];
        await transport.relist(supervisor, dir);
      }
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
      for (let i = 0; i < applied.dropped.length; i++) {
        const path = applied.dropped[i];
        const found = namespace.resolve(path, false);
        if (!found || found === "ELOOP" || found.row.kind !== NS_FILE) continue;
        refetch[refetch.length] = { path, size: found.row.size, rev: found.row.rev, epoch: rootEpochFor(applied.cursor, path), version: versionOf(found.row) };
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
      let describable = judgeable;
      for (let i = 0; describable && i < listing.names.length; i++) describable = nsDescribes(listing.names[i].stat);
      const at = listing.cursor;
      const comparable = (path) => judgeable && held !== null && sameClock(held, at, path);
      const vouches = (entry, rev) => entry !== void 0 && comparable(entry.path) && entry.rev > 0 && rev >= entry.rev;
      const listed = new SafeMap();
      for (let i = 0; i < listing.entries.length; i++) {
        const file = listing.entries[i];
        listed.set(file.path, file);
      }
      const rows = t.fileRows();
      const current = new SafeSet();
      const dropped = [];
      const own = [];
      let rekeyed = 0;
      let vouched = 0;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const entry = listed.get(row.path);
        if (row.rev === RK_OWN_WRITE) {
          current.add(row.path);
          own[own.length] = {
            path: row.path,
            rev: !comparable(row.path) ? null : entry !== void 0 ? entry.rev : feedFor(at, row.path).cursor
          };
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
        if (entry !== void 0 && row.ckey !== null && ownValue(entry, "ckey") != null && row.ckey === ownValue(entry, "ckey") && namespace.readable(ownValue(entry, "stat"))) {
          t.fileSetRev(row.path, entry.rev);
          current.add(row.path);
          rekeyed++;
          continue;
        }
        dropped[dropped.length] = row.path;
      }
      const heldRevisions = cells.heldRevisions();
      for (let i = 0; i < heldRevisions.length; i++) {
        const path = heldRevisions[i][0];
        const rev = heldRevisions[i][1];
        if (current.has(path)) continue;
        const entry = listed.get(path);
        if (rev === RK_OWN_WRITE) {
          current.add(path);
          own[own.length] = { path, rev: !comparable(path) ? null : entry !== void 0 ? entry.rev : feedFor(at, path).cursor };
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
        dropped[dropped.length] = path;
      }
      if (dropped.length > 0 && vouched === 0 && rekeyed === 0) {
        t.dropDatedFiles();
      } else {
        for (let i = 0; i < dropped.length; i++) {
          const path = dropped[i];
          t.chunkDelete(path);
          t.fileDelete(path);
        }
      }
      const wanted = new SafeSet(dropped);
      const fetch = [];
      const copied = [];
      for (let i = 0; i < listing.entries.length; i++) {
        const file = listing.entries[i];
        if (current.has(file.path)) continue;
        if (manifests !== null && isManifest(file.path)) {
          const copy = manifests.get(file.path);
          const ckey = ownValue(file, "ckey");
          if (arrayIsArray(copy) && ckey !== null && copy[0] === ckey && namespace.readable(ownValue(file, "stat"))) copied[copied.length] = { file, text: stringOf(copy[1]) };
          else fetch[fetch.length] = file;
          continue;
        }
        if (plan.has(file.path) || wanted.has(file.path) || pushable(file.path) && (!comparable(file.path) || file.rev > feedFor(held, file.path).cursor)) fetch[fetch.length] = file;
      }
      const heap = coherence.heap;
      const namespaceGrowth = admission.inHeap && describable && heap !== null ? mathMax(0, ownValue(listing, "namespaceBytes") - heap.nsBytes()) : 0;
      const refused = admission.namespaceRefusal(namespaceGrowth);
      if (refused !== null) namespace.refuse(t, refused);
      const giveBack = admission.reserveNamespace(namespaceGrowth);
      let filled;
      try {
        let copiedBytes = 0;
        for (let i = 0; i < copied.length; i++) {
          const { text } = copied[i];
          copiedBytes += residentCellCost(text);
        }
        if (copiedBytes > 0) await admission.ensureRoom(copiedBytes);
        for (let i = 0; i < copied.length; i++) {
          const { file, text } = copied[i];
          if (!cells.put(t, file.path, text, file.rev, ownValue(file, "ckey"))) fetch[fetch.length] = file;
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
        throw new Error2("Nimbus: a module bundle is adopted only into an empty store");
      }
      if (!isFeedPosition(moduleCursor)) {
        coherence.setUndated(true);
        coherence.unseal();
        return null;
      }
      const paths = objectKeys(bundle || {});
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        cells.put(t, path, bundle[path], feedFor(moduleCursor, path).cursor);
      }
      return cells.admit({ poison: false, paths: [], position: moduleCursor }).cursor;
    };
    const fail2 = (pass) => pass && (ownValue(pass, "skipped") || ownValue(pass, "incomplete")) || null;
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
        let failure2 = null;
        if (coherence.cursor() !== null) {
          let pass2 = null;
          try {
            pass2 = await synchronize(supervisor);
          } catch (e) {
            failure2 = messageOf(e);
          }
          const passed2 = pass2 === null ? void 0 : ownValue(pass2, "cursor");
          if (passed2) return { cursor: await catchUp(supervisor, passed2), failure: null };
          failure2 = "a kept store could not be reconciled (" + (failure2 || fail2(pass2) || "the listing vouched for nothing") + "); it was emptied and this launch booted from its own snapshot";
        }
        cells.clear();
        const bundle = takeBundle();
        let bytes = moduleBytes;
        if (typeof bytes !== "number") {
          bytes = 0;
          const paths = objectKeys(bundle || {});
          for (let i = 0; i < paths.length; i++) bytes += residentCellCost(bundle[paths[i]]);
        }
        if (!await admission.ensureRoom(bytes)) {
          throw objectAssign(new Error2(
            "ENOSPC: workspace storage is full: this process's modules (" + mathCeil(bytes / 1048576) + " MiB) do not fit in what is left of the session's storage"
          ), { code: "ENOSPC" });
        }
        const adopted = adoptModuleBundle(bundle, moduleCursor);
        if (failure2 !== null) return { cursor: adopted, failure: failure2 };
        let pass = null;
        try {
          pass = await synchronize(supervisor);
        } catch (e) {
          failure2 = messageOf(e);
        }
        const passed = pass === null ? void 0 : ownValue(pass, "cursor");
        if (passed) return { cursor: await catchUp(supervisor, passed), failure: failure2 };
        return { cursor: adopted, failure: failure2 || fail2(pass) };
      },
      setPushRoots(roots) {
        const given = arrayIsArray(roots) ? roots : [];
        const trimmed = new SafeList();
        for (let i = 0; i < given.length; i++) {
          const root = stringOf(given[i]);
          let from = 0;
          let to = root.length;
          while (from < to && stringCharCodeAt(root, from) === 47) from++;
          while (to > from && stringCharCodeAt(root, to - 1) === 47) to--;
          trimmed[i] = stringSlice(root, from, to);
        }
        pushRoots = trimmed;
      },
      pushable,
      acquireOptions,
      applyAcquire,
      setPlan(paths) {
        plan = new SafeSet();
        if (arrayIsArray(paths)) for (let i = 0; i < paths.length; i++) plan.add(nsKey(paths[i]));
      },
      setManifests(given) {
        const listed = given && typeof given === "object" ? ownValue(given, "files") : void 0;
        const files = listed && typeof listed === "object" ? listed : null;
        if (files === null) {
          manifests = null;
          return;
        }
        manifests = new SafeMap();
        const names = objectKeys(files);
        for (let i = 0; i < names.length; i++) manifests.set(names[i], files[names[i]]);
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
        const seen = new SafeSet();
        const asked = new SafeList();
        for (let i = 0; i < dropped.length; i++) asked[asked.length] = dropped[i];
        plan.forEach((path) => {
          asked[asked.length] = path;
        });
        for (let i = 0; i < asked.length; i++) {
          const path = asked[i];
          if (seen.has(path)) continue;
          seen.add(path);
          if (cells.has(path)) continue;
          const row = nsRowAt(t, path);
          if (row === void 0 || row.kind !== NS_FILE) continue;
          fetch[fetch.length] = { path, size: row.size, rev: row.rev, epoch: rootEpochFor(cursor, path), ckey: null, version: versionOf(row) };
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
        let failure2 = bootFailure;
        try {
          const repaired = await synchronize(supervisor);
          failure2 = fail2(repaired) || failure2;
        } catch (e) {
          failure2 = messageOf(e);
        }
        if (namespace.ready()) return null;
        return "node: the process was not started: its view of the filesystem could not be listed (" + (failure2 || namespace.notReadyCause()) + ")";
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
  var encodePart = (text) => {
    if (regExpExec(RESERVED, text) === null) return text;
    let out = "";
    for (let i = 0; i < text.length; i++) {
      const c = stringCharCodeAt(text, i);
      out += c === 0 ? "" : c === 1 ? "" : text[i];
    }
    return out;
  };
  var decodePart = (text) => {
    let at = stringIndexOf(text, "");
    if (at < 0) return text;
    let out = "";
    let from = 0;
    while (at >= 0) {
      const next = stringCharCodeAt(text, at + 1);
      if (next !== 2 && next !== 3) {
        at = stringIndexOf(text, "", at + 1);
        continue;
      }
      out += stringSlice(text, from, at) + (next === 2 ? "\0" : "");
      from = at + 2;
      at = stringIndexOf(text, "", from);
    }
    return out + stringSlice(text, from);
  };
  var pad = (n) => stringPadStart(stringOf(NumberOf(n)), 17, "0");
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
    const listEach = (options, visit) => {
      const listed = kv.list(options);
      const iterator = reflectApply(reflectGet(listed, symbolIterator), listed, []);
      const next = reflectGet(iterator, "next");
      for (; ; ) {
        const step = reflectApply(next, iterator, []);
        if (step.done) return;
        let stop = false;
        let visited = false;
        try {
          stop = visit(step.value[0], step.value[1]);
          visited = true;
        } finally {
          if (!visited || stop === true) {
            const close = reflectGet(iterator, "return");
            if (typeof close === "function") {
              if (visited) reflectApply(close, iterator, []);
              else try {
                reflectApply(close, iterator, []);
              } catch {
              }
            }
          }
        }
        if (stop === true) return;
      }
    };
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
      listEach(options, (key) => {
        out[out.length] = key;
      });
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
      return { path: decodePart(stringSlice(tail, 0, at)), rev: NumberOf(stringSlice(tail, at + SEP.length, at + NUMBER)), part: NumberOf(stringSlice(tail, at + NUMBER + SEP.length)) };
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
        keys[keys.length] = CHUNK + stringSlice(parts[i], 1);
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
      listEach({ prefix: FILE }, (key, value) => {
        out[out.length] = [decodePart(stringSlice(key, 1)), value];
      });
      return out;
    };
    const chunkPaths = () => {
      const out = new SafeList();
      let last = null;
      listEach({ prefix: CHUNK_KEYS }, (key) => {
        const path = decodePart(stringSlice(key, 1, stringLastIndexOf(key, SEP)));
        if (path !== last) {
          out[out.length] = path;
          last = path;
        }
      });
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
      listEach(options, (key, value) => {
        const at = stringIndexOf(key, SEP);
        out[out.length] = [{ parent: decodePart(stringSlice(key, 1, at)), name: decodePart(stringSlice(key, at + SEP.length)) }, value];
      });
      return out;
    };
    const deleteKeys = (options) => drop(keysOf(options));
    const sqlSize = () => {
      const sql = reflectGet(storage, "sql");
      return sql === void 0 || sql === null ? void 0 : reflectGet(sql, "databaseSize");
    };
    if (kv.get(META + "schema") !== RESIDENT_SCHEMA) {
      const tags = [FILE, CHUNK, CHUNK_KEYS, BY_CKEY, NS, PAGE, PAGE_ROWS, PAGE_USED, META];
      for (let i = 0; i < tags.length; i++) deleteKeys({ prefix: tags[i] });
      put(META + "schema", RESIDENT_SCHEMA);
    }
    return {
      bytes() {
        return NumberOf(sqlSize() ?? 0);
      },
      databaseSize() {
        return NumberOf(sqlSize() ?? 0);
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
        let found;
        listEach({ prefix }, (key) => {
          const path = decodePart(stringSlice(key, prefix.length + NUMBER));
          if (path === notPath) return false;
          const row = fileOf(path);
          if (row === void 0 || row[3] < 0) return false;
          found = { path, kind: row[0], size: row[1], chunks: row[2] };
          return true;
        });
        return found;
      },
      filePaths(from, to) {
        const out = new SafeList();
        listEach(rangeOf(FILE, from, to), (key) => {
          out[out.length] = decodePart(stringSlice(key, 1));
        });
        return arrayCopy(out);
      },
      fileAny(from, to) {
        let any = false;
        listEach({ ...rangeOf(FILE, from, to), limit: 1 }, () => any = true);
        return any;
      },
      fileRevsIn(from, to) {
        const out = new SafeList();
        listEach(rangeOf(FILE, from, to), (key, value) => {
          out[out.length] = { path: decodePart(stringSlice(key, 1)), rev: value[3] };
        });
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
        listEach({ prefix: CHUNK + encodePart(path) + SEP }, (_key, value) => {
          out[out.length] = chunkRow(value);
        });
        return arrayCopy(out);
      },
      chunkAddText(path, part, txt) {
        addChunk(path, NumberOf(part), stringOf(txt), false);
      },
      chunkAddBin(path, part, bin) {
        addChunk(path, NumberOf(part), bytesCopy(residentBytes(bin)), false);
      },
      chunkSetBin(path, part, bin) {
        addChunk(path, NumberOf(part), bytesCopy(residentBytes(bin)), true);
      },
      chunkCopy(to, from) {
        const parts = new SafeList();
        listEach({ prefix: CHUNK + encodePart(from) + SEP }, (key, value) => {
          parts[parts.length] = [stringSlice(key, stringLastIndexOf(key, SEP) + SEP.length), value];
        });
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
          const tags2 = [CHUNK, CHUNK_KEYS, FILE, BY_CKEY];
          for (let i = 0; i < tags2.length; i++) deleteKeys({ prefix: tags2[i] });
        });
        const tags = [NS, PAGE, PAGE_ROWS, PAGE_USED];
        for (let i = 0; i < tags.length; i++) deleteKeys({ prefix: tags[i] });
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
        const bytes = bytesCopy(residentBytes(bin));
        if (had !== void 0) dropOne(PAGE_USED + pad(had[0]) + SEP + tail);
        put(PAGE + tail, bytes);
        put(PAGE_ROWS + tail, [NumberOf(used), typedArrayByteLength(bytes)]);
        put(PAGE_USED + pad(used) + SEP + tail, typedArrayByteLength(bytes));
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
        listEach({ prefix: PAGE_USED, limit }, (key, value) => {
          const { path, rev, part: n } = unpage(stringSlice(key, 1 + NUMBER));
          out[out.length] = { path, rev, part: n, size: value };
        });
        return arrayCopy(out);
      },
      pageBytes() {
        let n = 0;
        listEach({ prefix: PAGE_ROWS }, (_key, value) => {
          n += value[1];
        });
        return n;
      },
      pageMaxUsed() {
        let most = 0;
        listEach({ prefix: PAGE_USED, reverse: true, limit: 1 }, (key) => {
          most = NumberOf(stringSlice(key, 1, 18));
          return true;
        });
        return most;
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
          const key = rows[i][0];
          const row = rows[i][1];
          if (row.kind === NS_DIR && row.target !== null) out[out.length] = { parent: key.parent, name: key.name, target: row.target };
        }
        return arrayCopy(out);
      },
      nsChildren(parent) {
        const out = new SafeList();
        const prefix = nsChildren(parent);
        listEach({ prefix }, (key, value) => {
          const row = value;
          out[out.length] = { name: decodePart(stringSlice(key, prefix.length)), kind: row.kind, mode: row.mode };
        });
        return arrayCopy(out);
      },
      nsCount() {
        let n = 0;
        listEach({ prefix: NS }, () => {
          n++;
        });
        return n;
      }
    };
  }

  // ../platform/dist/lexical-path.js
  function rootClampedSegments(path, base = []) {
    const out = [...base];
    for (const segment of path.split("/")) {
      if (segment === "..")
        out.pop();
      else if (segment !== "" && segment !== ".")
        out.push(segment);
    }
    return out;
  }

  // ../core/dist/vfs/path.js
  function parentKey(key) {
    const at = key.lastIndexOf("/");
    return at < 0 ? "" : key.slice(0, at);
  }

  // ../core/dist/vfs/composite.js
  var ANONYMOUS_DEV = 65536;
  var utf8 = new TextEncoder();

  // ../core/dist/vfs/proc-files.js
  var host = () => globalThis.navigator;
  var PROC_MOUNT_POINT = "/proc";
  var PROC_FILES = {
    cpuinfo: {
      generate: () => {
        const cores = host()?.hardwareConcurrency ?? 1;
        const lines = [];
        for (let i = 0; i < cores; i++) {
          lines.push(`processor	: ${i}`, "model name	: Browser Virtual CPU", `cpu cores	: ${cores}`, "");
        }
        return lines.join("\n");
      }
    },
    meminfo: {
      generate: () => {
        const memory = globalThis.performance?.memory;
        if (!memory)
          return ["MemTotal:       2097152 kB", "MemFree:        1048576 kB", "MemUsed:        1048576 kB", ""].join("\n");
        const totalKB = Math.floor(memory.jsHeapSizeLimit / 1024);
        const usedKB = Math.floor(memory.usedJSHeapSize / 1024);
        return [
          `MemTotal:       ${totalKB} kB`,
          `MemFree:        ${totalKB - usedKB} kB`,
          `MemUsed:        ${usedKB} kB`,
          `HeapTotal:      ${Math.floor(memory.totalJSHeapSize / 1024)} kB`,
          ""
        ].join("\n");
      }
    },
    uptime: {
      generate: () => {
        const seconds = typeof performance !== "undefined" ? (performance.now() / 1e3).toFixed(2) : "0.00";
        return `${seconds} ${seconds}
`;
      }
    },
    version: {
      generate: () => `Lifo 1.0.0 (${host()?.userAgent ?? "Cloudflare-Workers"})
`
    },
    "net/info": {
      generate: () => {
        const conn = host()?.connection;
        if (!conn)
          return "Network information not available\n";
        return [
          `type:          ${conn.type ?? "unknown"}`,
          `effectiveType: ${conn.effectiveType ?? "unknown"}`,
          `downlink:      ${conn.downlink ?? 0} Mbps`,
          `rtt:           ${conn.rtt ?? 0} ms`,
          ""
        ].join("\n");
      }
    }
  };
  function procFileGenerator(name) {
    return Object.hasOwn(PROC_FILES, name) ? PROC_FILES[name].generate : void 0;
  }

  // ../core/dist/_shared/process-fs-journal.js
  function dataOf(op) {
    return op.type === "call" && "data" in op.call ? op.call.data : null;
  }
  function rowOf(op) {
    const data = dataOf(op);
    if (data === null)
      return { json: JSON.stringify(op), data: null };
    const { data: _data, ...call } = op.call;
    return { json: JSON.stringify({ type: "call", call }), data };
  }
  function currentCall(call) {
    if (call.call === "open" && call.access === void 0) {
      const { read, ...open } = call;
      return { ...open, access: read === true ? "readwrite" : "write" };
    }
    return call;
  }
  function opOf(json, data) {
    const journaled = JSON.parse(json);
    const op = journaled.type === "call" ? { type: "call", call: currentCall(journaled.call) } : journaled;
    if (data === null || data === void 0)
      return op;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    return { type: "call", call: { ...op.call, data: bytes } };
  }
  function sqlJournal(sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS nimbus_fs_journal (jid INTEGER PRIMARY KEY, op TEXT NOT NULL, data BLOB)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS nimbus_fs_numbering (jid INTEGER PRIMARY KEY, writer TEXT, seq INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS nimbus_fs_journal_parts (part INTEGER PRIMARY KEY, jid INTEGER NOT NULL, data BLOB NOT NULL)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS nimbus_fs_journal_parts_jid ON nimbus_fs_journal_parts (jid, part)`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS nimbus_fs_journal_replace AFTER UPDATE ON nimbus_fs_journal WHEN EXISTS (SELECT 1 FROM nimbus_fs_journal_parts WHERE jid = OLD.jid) BEGIN DELETE FROM nimbus_fs_journal_parts WHERE jid = OLD.jid; END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS nimbus_fs_journal_drop AFTER DELETE ON nimbus_fs_journal WHEN EXISTS (SELECT 1 FROM nimbus_fs_journal_parts WHERE jid = OLD.jid) BEGIN DELETE FROM nimbus_fs_journal_parts WHERE jid = OLD.jid; END`);
    const last = [...sql.exec("SELECT MAX(jid) AS jid FROM nimbus_fs_journal")][0];
    let next = Number(last?.jid ?? 0) + 1;
    const held = [...sql.exec("SELECT (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM nimbus_fs_journal) + (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM nimbus_fs_journal_parts) AS bytes")][0];
    let bytes = Number(held?.bytes ?? 0);
    const withParts = new Set([...sql.exec("SELECT DISTINCT jid FROM nimbus_fs_journal_parts")].map((row) => Number(row.jid)));
    const readRow = (row) => {
      const op = opOf(String(row.op), row.data);
      if (!withParts.has(Number(row.jid)))
        return op;
      const extra = [...sql.exec("SELECT COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM nimbus_fs_journal_parts WHERE jid = ?", row.jid)][0];
      const size = Number(extra?.bytes ?? 0);
      if (size === 0)
        return op;
      const first = dataOf(op);
      const data = new Uint8Array(first.byteLength + size);
      data.set(first);
      let at = first.byteLength;
      for (const part of sql.exec("SELECT data FROM nimbus_fs_journal_parts WHERE jid = ? ORDER BY part", row.jid)) {
        const piece = part.data instanceof Uint8Array ? part.data : new Uint8Array(part.data);
        data.set(piece, at);
        at += piece.byteLength;
      }
      return { type: "call", call: { ...op.call, data } };
    };
    return {
      durable: true,
      append(op) {
        const jid = next++;
        const row = rowOf(op);
        sql.exec("INSERT INTO nimbus_fs_journal (jid, op, data) VALUES (?, ?, ?)", jid, row.json, row.data);
        bytes += row.data?.byteLength ?? 0;
        return jid;
      },
      read(jid) {
        const row = [...sql.exec("SELECT jid, op, data FROM nimbus_fs_journal WHERE jid = ?", jid)][0];
        if (row === void 0)
          throw new Error(`process-fs journal: entry ${jid} is not held`);
        return readRow(row);
      },
      replace(jid, op) {
        const before = withParts.has(jid) ? [...sql.exec("SELECT COALESCE(LENGTH(data), 0) + (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM nimbus_fs_journal_parts WHERE jid = ?) AS bytes FROM nimbus_fs_journal WHERE jid = ?", jid, jid)][0] : [...sql.exec("SELECT LENGTH(data) AS bytes FROM nimbus_fs_journal WHERE jid = ?", jid)][0];
        const row = rowOf(op);
        sql.exec("UPDATE nimbus_fs_journal SET op = ?, data = ? WHERE jid = ?", row.json, row.data, jid);
        withParts.delete(jid);
        bytes += (row.data?.byteLength ?? 0) - Number(before?.bytes ?? 0);
      },
      entries() {
        return [...sql.exec("SELECT jid, op, data FROM nimbus_fs_journal ORDER BY jid")].map((row) => ({ jid: Number(row.jid), op: readRow(row) }));
      },
      readAfter(after3, maxBytes) {
        const out = [];
        let taken = 0;
        for (const row of sql.exec("SELECT jid, op, data FROM nimbus_fs_journal WHERE jid > ? ORDER BY jid", after3)) {
          const op = readRow(row);
          const size = dataOf(op)?.byteLength ?? 0;
          if (out.length > 0 && taken + size > maxBytes)
            break;
          out.push({ jid: Number(row.jid), op });
          taken += size;
        }
        return out;
      },
      dropThrough(jid) {
        const freed = [...sql.exec("SELECT (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM nimbus_fs_journal WHERE jid <= ?) + (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM nimbus_fs_journal_parts WHERE jid <= ?) AS bytes", jid, jid)][0];
        bytes -= Number(freed?.bytes ?? 0);
        sql.exec("DELETE FROM nimbus_fs_journal WHERE jid <= ?", jid);
        for (const at of withParts)
          if (at <= jid)
            withParts.delete(at);
        sql.exec("DELETE FROM nimbus_fs_numbering WHERE jid < (SELECT COALESCE(MAX(jid), 0) FROM nimbus_fs_numbering WHERE jid <= ?)", jid + 1);
      },
      number(numbering) {
        sql.exec("DELETE FROM nimbus_fs_numbering WHERE jid >= ?", numbering.jid);
        sql.exec("INSERT INTO nimbus_fs_numbering (jid, writer, seq) VALUES (?, ?, ?)", numbering.jid, numbering.writer, numbering.seq);
      },
      numberings() {
        return [...sql.exec("SELECT jid, writer, seq FROM nimbus_fs_numbering ORDER BY jid")].map((row) => ({ jid: Number(row.jid), writer: row.writer === null ? null : String(row.writer), seq: Number(row.seq) }));
      },
      get bytes() {
        return bytes;
      }
    };
  }
  function memoryJournal() {
    const held = /* @__PURE__ */ new Map();
    const numbered = [];
    let next = 1;
    let bytes = 0;
    return {
      durable: false,
      append(op) {
        const jid = next++;
        held.set(jid, op);
        bytes += dataOf(op)?.byteLength ?? 0;
        return jid;
      },
      read(jid) {
        const op = held.get(jid);
        if (op === void 0)
          throw new Error(`process-fs journal: entry ${jid} is not held`);
        return op;
      },
      replace(jid, op) {
        const before = held.get(jid);
        if (before === void 0)
          throw new Error(`process-fs journal: entry ${jid} is not held`);
        bytes += (dataOf(op)?.byteLength ?? 0) - (dataOf(before)?.byteLength ?? 0);
        held.set(jid, op);
      },
      entries() {
        return [...held].map(([jid, op]) => ({ jid, op }));
      },
      readAfter(after3, maxBytes) {
        const out = [];
        let taken = 0;
        for (const [jid, op] of held) {
          if (jid <= after3)
            continue;
          const size = dataOf(op)?.byteLength ?? 0;
          if (out.length > 0 && taken + size > maxBytes)
            break;
          out.push({ jid, op });
          taken += size;
        }
        return out;
      },
      dropThrough(jid) {
        for (const [at, op] of held) {
          if (at > jid)
            break;
          bytes -= dataOf(op)?.byteLength ?? 0;
          held.delete(at);
        }
        while (numbered.length > 1 && numbered[1].jid <= jid + 1)
          numbered.shift();
      },
      number(numbering) {
        while (numbered.length > 0 && numbered[numbered.length - 1].jid >= numbering.jid)
          numbered.pop();
        numbered.push({ ...numbering });
      },
      numberings() {
        return numbered.map((numbering) => ({ ...numbering }));
      },
      get bytes() {
        return bytes;
      }
    };
  }

  // ../platform/dist/rpc-dispose.js
  function disposeRpcResource(value) {
    if (typeof value !== "object" && typeof value !== "function" || value === null)
      return false;
    const disposerKey = Symbol.dispose;
    if (!disposerKey)
      return false;
    const disposer = Reflect.get(value, disposerKey);
    if (typeof disposer !== "function")
      return false;
    try {
      Reflect.apply(disposer, value, []);
      return true;
    } catch {
      return false;
    }
  }

  // ../core/dist/runtime/filesystem-methods.js
  var FILESYSTEM_METHODS = {
    stat: { rpc: "stat", answer: "value" },
    readFile: { rpc: "readFileBytes", answer: "bytes" },
    writeFile: { rpc: "writeFile", answer: "value" },
    readRange: { rpc: "fsReadRange", answer: "bytes" },
    writeRange: { rpc: "fsWriteRange", answer: "value" },
    truncate: { rpc: "fsTruncate", answer: "value" },
    utimes: { rpc: "utimes", answer: "value" },
    chmod: { rpc: "chmod", answer: "value" },
    access: { rpc: "access", answer: "value" },
    chown: { rpc: "chown", answer: "value" },
    open: { rpc: "fsOpen", answer: "value" },
    reopen: { rpc: "fsReopen", answer: "value" },
    read: { rpc: "fsRead", answer: "bytes" },
    write: { rpc: "fsWrite", answer: "value" },
    close: { rpc: "fsClose", answer: "value" },
    readdir: { rpc: "readdir", answer: "value" },
    mkdir: { rpc: "mkdir", answer: "value" },
    unlink: { rpc: "unlink", answer: "value" },
    rmdir: { rpc: "rmdir", answer: "value" },
    rename: { rpc: "rename", answer: "value" },
    readlink: { rpc: "readlink", answer: "value" },
    linkLeadsTo: { rpc: "fsLinkLeadsTo", answer: "value" },
    symlink: { rpc: "symlink", answer: "value" },
    fsync: { rpc: "fsSync", answer: "value" },
    revision: { rpc: "fsRevision", answer: "value" },
    acquire: { rpc: "fsAcquire", answer: "value" },
    list: { rpc: "fsList", answer: "value" },
    realpath: { rpc: "fsRealpath", answer: "value" },
    remove: { rpc: "fsRemove", answer: "removal" },
    copyFile: { rpc: "fsCopyFile", answer: "value" },
    copyTree: { rpc: "fsCopyTree", answer: "value" },
    fstat: { rpc: "fsFstat", answer: "value" },
    dup: { rpc: "fsDup", answer: "value" },
    seek: { rpc: "fsSeek", answer: "value" },
    setStatus: { rpc: "fsSetStatus", answer: "value" },
    readdirHandle: { rpc: "fsReaddirHandle", answer: "value" },
    ftruncate: { rpc: "fsFtruncate", answer: "value" },
    fchmod: { rpc: "fsFchmod", answer: "value" },
    fchown: { rpc: "fsFchown", answer: "value" },
    futimes: { rpc: "fsFutimes", answer: "value" },
    writeBatch: { rpc: "writeBatch", answer: "value" },
    writeStream: { rpc: "writeBatchStream", answer: "stream" },
    acquireExclusiveMutation: { rpc: "fsAcquireExclusiveMutation", answer: "value" },
    releaseExclusiveMutation: { rpc: "fsReleaseExclusiveMutation", answer: "value" },
    // Waits for a recall for as long as the session has none to send: never work a program waits on.
    awaitRecall: { rpc: "fsAwaitRecall", answer: "value", waits: true },
    recalled: { rpc: "fsRecalled", answer: "value" },
    published: { rpc: "fsPublished", answer: "value" }
  };
  function pending(result) {
    return (typeof result === "object" || typeof result === "function") && result !== null && typeof result.then === "function";
  }
  function answerValue(result) {
    return pending(result) ? Promise.resolve(result) : result;
  }
  function answerBytes(result) {
    return pending(result) ? Promise.resolve(result).then(asBytes) : asBytes(result);
  }
  function answerStream(result) {
    return Promise.resolve(result);
  }
  function asBytes(value) {
    return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  }
  var STANDARD_ERRORS = {
    EvalError,
    RangeError,
    ReferenceError,
    SyntaxError,
    TypeError,
    URIError
  };
  function supervisorRefusalError(refusal) {
    const Standard = Object.hasOwn(STANDARD_ERRORS, refusal.name) ? STANDARD_ERRORS[refusal.name] : void 0;
    const error = new (Standard ?? Error)(refusal.message);
    if (!Standard && refusal.name !== "Error") {
      Object.defineProperty(error, "name", { value: refusal.name, configurable: true, writable: true });
    }
    for (const [key, value] of Object.entries(refusal.properties)) {
      Object.defineProperty(error, key, { value, configurable: true, enumerable: true, writable: true });
    }
    for (const [key, value] of Object.entries(refusal.errors)) {
      Object.defineProperty(error, key, { value: supervisorRefusalError(value), configurable: true, enumerable: true, writable: true });
    }
    return error;
  }
  function answerRemoval(result) {
    return pending(result) ? Promise.resolve(result).then(removalErrors) : removalErrors(result);
  }
  function removalErrors(report) {
    if (report === void 0)
      return report;
    const failures = report.failures.map(({ path, error }) => ({
      path,
      error: error instanceof Error ? error : supervisorRefusalError(error)
    }));
    return { ...report, failures };
  }

  // ../core/dist/runtime/filesystem-mirrors.generated.js
  var FILESYSTEM_ANSWERED_RPC_METHODS = [
    "stat",
    "readFileBytes",
    "writeFile",
    "fsReadRange",
    "fsWriteRange",
    "fsTruncate",
    "utimes",
    "chmod",
    "access",
    "chown",
    "fsOpen",
    "fsReopen",
    "fsRead",
    "fsWrite",
    "fsClose",
    "readdir",
    "mkdir",
    "unlink",
    "rmdir",
    "rename",
    "readlink",
    "fsLinkLeadsTo",
    "symlink",
    "fsSync",
    "fsRevision",
    "fsAcquire",
    "fsList",
    "fsRealpath",
    "fsRemove",
    "fsCopyFile",
    "fsCopyTree",
    "fsFstat",
    "fsDup",
    "fsSeek",
    "fsSetStatus",
    "fsReaddirHandle",
    "fsFtruncate",
    "fsFchmod",
    "fsFchown",
    "fsFutimes",
    "writeBatch",
    "fsAcquireExclusiveMutation",
    "fsReleaseExclusiveMutation",
    "fsAwaitRecall",
    "fsRecalled",
    "fsPublished"
  ];
  function bridgeOverSupervisor(supervisor, local) {
    return {
      synchronous: local.synchronous,
      writeFileFrom: local.writeFileFrom,
      stat: (...args) => answerValue(supervisor.stat(...args)),
      readFile: (...args) => answerBytes(supervisor.readFileBytes(...args)),
      writeFile: (...args) => answerValue(supervisor.writeFile(...args)),
      readRange: (...args) => answerBytes(supervisor.fsReadRange(...args)),
      writeRange: (...args) => answerValue(supervisor.fsWriteRange(...args)),
      truncate: (...args) => answerValue(supervisor.fsTruncate(...args)),
      utimes: (...args) => answerValue(supervisor.utimes(...args)),
      chmod: (...args) => answerValue(supervisor.chmod(...args)),
      access: (...args) => answerValue(supervisor.access(...args)),
      chown: (...args) => answerValue(supervisor.chown(...args)),
      open: (...args) => answerValue(supervisor.fsOpen(...args)),
      reopen: (...args) => answerValue(supervisor.fsReopen(...args)),
      read: (...args) => answerBytes(supervisor.fsRead(...args)),
      write: (...args) => answerValue(supervisor.fsWrite(...args)),
      close: (...args) => answerValue(supervisor.fsClose(...args)),
      readdir: (...args) => answerValue(supervisor.readdir(...args)),
      mkdir: (...args) => answerValue(supervisor.mkdir(...args)),
      unlink: (...args) => answerValue(supervisor.unlink(...args)),
      rmdir: (...args) => answerValue(supervisor.rmdir(...args)),
      rename: (...args) => answerValue(supervisor.rename(...args)),
      readlink: (...args) => answerValue(supervisor.readlink(...args)),
      linkLeadsTo: (...args) => answerValue(supervisor.fsLinkLeadsTo(...args)),
      symlink: (...args) => answerValue(supervisor.symlink(...args)),
      fsync: (...args) => answerValue(supervisor.fsSync(...args)),
      revision: (...args) => answerValue(supervisor.fsRevision(...args)),
      acquire: (...args) => answerValue(supervisor.fsAcquire(...args)),
      list: (...args) => answerValue(supervisor.fsList(...args)),
      realpath: (...args) => answerValue(supervisor.fsRealpath(...args)),
      remove: (...args) => answerRemoval(supervisor.fsRemove(...args)),
      copyFile: (...args) => answerValue(supervisor.fsCopyFile(...args)),
      copyTree: (...args) => answerValue(supervisor.fsCopyTree(...args)),
      fstat: (...args) => answerValue(supervisor.fsFstat(...args)),
      dup: (...args) => answerValue(supervisor.fsDup(...args)),
      seek: (...args) => answerValue(supervisor.fsSeek(...args)),
      setStatus: (...args) => answerValue(supervisor.fsSetStatus(...args)),
      readdirHandle: (...args) => answerValue(supervisor.fsReaddirHandle(...args)),
      ftruncate: (...args) => answerValue(supervisor.fsFtruncate(...args)),
      fchmod: (...args) => answerValue(supervisor.fsFchmod(...args)),
      fchown: (...args) => answerValue(supervisor.fsFchown(...args)),
      futimes: (...args) => answerValue(supervisor.fsFutimes(...args)),
      writeBatch: (...args) => answerValue(supervisor.writeBatch(...args)),
      writeStream: (...args) => answerStream(supervisor.writeBatchStream(...args)),
      acquireExclusiveMutation: (...args) => answerValue(supervisor.fsAcquireExclusiveMutation(...args)),
      releaseExclusiveMutation: (...args) => answerValue(supervisor.fsReleaseExclusiveMutation(...args)),
      awaitRecall: (...args) => answerValue(supervisor.fsAwaitRecall(...args)),
      recalled: (...args) => answerValue(supervisor.fsRecalled(...args)),
      published: (...args) => answerValue(supervisor.fsPublished(...args))
    };
  }

  // ../core/dist/runtime/vfs-supervisor.js
  var NODE_SHIM_RPC_METHODS = [
    "readFile",
    "writeFileStat",
    "lstat",
    "exists",
    "setUmask",
    "fsAcquired",
    "fsStorageGrant",
    "fsReadRangeUncached",
    "fsReadBatch",
    "fsListTree",
    "fsReadDirectories"
  ];
  var SUPERVISOR_ANSWERED_METHODS = (() => {
    const methods = new SafeList();
    for (let i = 0; i < FILESYSTEM_ANSWERED_RPC_METHODS.length; i++)
      methods[methods.length] = FILESYSTEM_ANSWERED_RPC_METHODS[i];
    for (let i = 0; i < NODE_SHIM_RPC_METHODS.length; i++)
      methods[methods.length] = NODE_SHIM_RPC_METHODS[i];
    return arrayCopy(methods);
  })();
  var ANSWERED = {};
  reflectSetPrototypeOf(ANSWERED, null);
  for (let i = 0; i < SUPERVISOR_ANSWERED_METHODS.length; i++) {
    const name = SUPERVISOR_ANSWERED_METHODS[i];
    ANSWERED[name] = true;
  }
  var WAITS = {};
  reflectSetPrototypeOf(WAITS, null);
  {
    const names = objectKeys(FILESYSTEM_METHODS);
    for (let i = 0; i < names.length; i++) {
      const method2 = FILESYSTEM_METHODS[names[i]];
      if (objectHasOwn(method2, "waits"))
        WAITS[method2.rpc] = true;
    }
  }
  function isSupervisorAnsweredMethod(name) {
    return typeof name === "string" && ANSWERED[name] === true;
  }
  var ANSWERING = symbolFor("nimbus.answering-supervisor");
  function isAnsweringStub(supervisor) {
    return reflectGet(supervisor, ANSWERING) !== true && typeof reflectGet(supervisor, "answer") === "function";
  }
  function answeringSupervisor(supervisor, live) {
    if (!isAnsweringStub(supervisor))
      return supervisor;
    const stub = supervisor;
    return new Proxy2(supervisor, {
      get(target, name) {
        if (name === ANSWERING)
          return true;
        if (!isSupervisorAnsweredMethod(name))
          return reflectGet(target, name);
        return async (...args) => {
          const asked = WAITS[name] === true ? stub.answer(name, args) : toldLive(stub.answer(name, args), live);
          const answer = await asked;
          try {
            if (objectHasOwn(answer, "refusal"))
              throw supervisorRefusalError(answer.refusal);
            return answer.value;
          } finally {
            disposeRpcResource(answer);
          }
        };
      }
    });
  }
  function supervisorFilesystem(remote, local, live) {
    return bridgeOverSupervisor(answeringSupervisor(remote, live), {
      synchronous: local,
      // An iterable does not cross RPC. A program with a large file to write
      // sends it as a W7 stream (writeStream), which does.
      writeFileFrom: async (path) => {
        const name = typeof path === "string" ? path : path.path;
        throw objectAssign(new Error2(`ENOTSUP: a streamed whole-file write is a host operation, write '${name}' as a W7 stream`), { code: "ENOTSUP" });
      }
    });
  }
  function toldLive(call, live) {
    const native = promiseResolve(call);
    live?.(native);
    return native;
  }
  function supervisorSession(stub, authority, live, holdsGrants = true) {
    const waves = stub;
    const grants = {
      acquire: async (path, delegate) => await authority.acquireExclusiveMutation(path, { delegate }),
      release: async (owner) => {
        await authority.releaseExclusiveMutation(owner);
      },
      awaitRecall: async (owner, waitMs) => await authority.awaitRecall(owner, waitMs),
      recalled: async (owner, kind) => {
        await authority.recalled(owner, kind);
      }
    };
    return {
      // Called as methods of the stub, never through .call/.apply: on an RPC stub those are remote method names too.
      openWriter: (first) => toldLive(waves.openWaveWriter(first), live),
      writeBatchStream: (stream, fence, owner) => toldLive(owner === void 0 ? waves.writeBatchStream(stream, fence) : waves.writeBatchStream(stream, fence, owner), live),
      retireWriter: async (writer) => {
        await toldLive(waves.retireWaveWriter(writer), live);
      },
      published: async (escape) => {
        await toldLive(escape ? waves.fsPublished({ escape: true }) : waves.fsPublished(), live);
      },
      // A process that cannot answer a recall (holdsGrants false) holds none: the session decides each of its changes.
      ...holdsGrants ? { grants } : {}
    };
  }

  // ../core/dist/runtime/beneath-walk.js
  var MAX_LINK_HOPS = 40;
  function fsError2(code, syscall, path, dest, options = {}) {
    const name = typeof path === "string" ? path : path.path;
    const second = dest === void 0 ? void 0 : typeof dest === "string" ? dest : dest.path;
    return fsError(code, syscall, name, second, options);
  }
  function handedSpelling(handoff, reached, trailing) {
    if (handoff === null)
      return reached;
    const spelling = `${handoff.base === "/" ? "" : handoff.base}/${arrayJoin(handoff.rest, "/")}`;
    return trailing && !stringEndsWith(spelling, "/") ? spelling + "/" : spelling;
  }
  var SEGMENTS = new SafeMap();
  var SEGMENTS_KEPT = 4096;
  function segmentsOf(name) {
    let segments = SEGMENTS.get(name);
    if (segments === void 0) {
      if (SEGMENTS.size >= SEGMENTS_KEPT)
        SEGMENTS.clear();
      SEGMENTS.set(name, segments = stringSplit(name, "/"));
    }
    return segments;
  }
  function suffixesOf(segments) {
    const suffixes = new SafeList();
    let joined = "";
    suffixes[segments.length] = joined;
    for (let at = segments.length - 1; at >= 0; at--) {
      const segment = segments[at];
      if (segment !== "")
        joined = joined === "" ? segment : `${segment}/${joined}`;
      suffixes[at] = joined;
    }
    return suffixes;
  }
  var walkBeneath = safeGenerator(function* (root, path, follow, cred, handedOver, rootSpelling = "/" + root) {
    const name = typeof path === "string" ? path : path.path;
    const anchored = rootSpelling !== "/" + root;
    let fromRoot = true;
    const named = (reached2) => !anchored || !fromRoot ? "/" + reached2 : reached2.length === root.length ? rootSpelling : `${rootSpelling === "/" ? "" : rootSpelling}${stringSlice(reached2, root.length)}`;
    if (root !== "")
      yield { stat: rootSpelling };
    if (name[0] === "/")
      throw fsError2("ENOTCAPABLE", "path", path);
    let pending2 = segmentsOf(name);
    let suffixes = suffixesOf(pending2);
    let next = 0;
    const resolved = new SafeList();
    if (root !== "") {
      const rooted = segmentsOf(root);
      for (let i = 0; i < rooted.length; i++)
        resolved[i] = rooted[i];
    }
    let joined = arrayJoin(resolved, "/");
    let hops = 0;
    let handoff = null;
    while (next < pending2.length) {
      const segment = pending2[next++];
      if (segment === void 0)
        break;
      const dir = joined;
      const candidate = dir === "" ? segment : `${dir}/${segment}`;
      let spelled = segment === "" ? dir : candidate;
      const after3 = suffixes[next];
      if (after3 !== "")
        spelled = spelled === "" ? after3 : `${spelled}/${after3}`;
      const to = "/" + spelled;
      const handed = handedOver("/" + dir, to) || segment !== "." && segment !== ".." && handedOver("/" + candidate, to);
      if (!handed) {
        const searched = yield { stat: named(dir) };
        if (searched === null)
          throw fsError2("ENOENT", "path", path);
        if (searched.type !== "directory")
          throw fsError2("ENOTDIR", "path", path);
        if (!modeAllows({ ...searched, type: "directory" }, 1, cred))
          throw fsError2("EACCES", "path", path);
      }
      if (segment === "" || segment === ".")
        continue;
      if (segment === "..") {
        if (dir === root)
          throw fsError2("ENOTCAPABLE", "path", path);
        arrayPop(resolved);
        joined = arrayJoin(resolved, "/");
        continue;
      }
      if (handed) {
        if (handoff === null) {
          const rest = new SafeList();
          rest[0] = segment;
          for (let i = next; i < pending2.length; i++)
            rest[rest.length] = pending2[i];
          handoff = { base: named(dir), rest };
        }
        resolved[resolved.length] = segment;
        joined = candidate;
        continue;
      }
      const isFinal = next === pending2.length;
      const stat = yield { stat: named(candidate) };
      if (stat === null && !isFinal)
        throw fsError2("ENOENT", "path", path);
      if (stat === null || stat.type !== "symlink" || isFinal && !follow) {
        resolved[resolved.length] = segment;
        joined = candidate;
        continue;
      }
      if (++hops > MAX_LINK_HOPS)
        return null;
      const target = yield { readlink: named(candidate) };
      if (target === null)
        throw fsError2("ENOTCAPABLE", "path", path);
      if (target[0] === "/") {
        resolved.length = 0;
        joined = "";
        fromRoot = false;
      }
      const parts = stringSplit(target, "/");
      for (let i = next; i < pending2.length; i++)
        parts[parts.length] = pending2[i];
      pending2 = parts;
      suffixes = suffixesOf(pending2);
      next = 0;
      handoff = null;
    }
    const reached = joined;
    if (root !== "" && reached !== root && !stringStartsWith(reached, root + "/"))
      throw fsError2("ENOTCAPABLE", "path", path);
    return { reached, spelling: handedSpelling(handoff, named(reached), name.length > 0 && name[name.length - 1] === "/") };
  });

  // ../core/dist/vfs/open-rules.js
  function openFollows(flags) {
    return flags.followSymlinks && !(flags.create && flags.exclusive);
  }
  function flagsRefusal(flags) {
    return flags.create && flags.directory ? "EINVAL" : null;
  }
  function refusesDirectory(flags, describes = true) {
    return ownValue(flags, "create") === true || ownValue(flags, "truncate") === true || ownValue(flags, "append") === true || ownValue(flags, "write") === true && !describes;
  }

  // ../core/dist/runtime/descriptors.js
  function openFlags(flags) {
    if (flags.path === true) {
      return { read: false, write: false, append: false, create: false, exclusive: false, directory: !!flags.directory, truncate: false, followSymlinks: flags.followSymlinks !== false };
    }
    return {
      read: !!flags.read || !flags.write,
      write: !!flags.write,
      append: !!flags.append,
      create: !!flags.create,
      exclusive: !!flags.exclusive,
      directory: !!flags.directory,
      truncate: !!flags.truncate,
      followSymlinks: flags.followSymlinks !== false,
      expectedRevision: flags.expectedRevision
    };
  }

  // ../core/dist/runtime/wasi/filesystem.js
  var encoder4 = new TextEncoder();
  var decoder2 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  var VFS_ERRNO2 = {
    E2BIG: 1,
    EACCES: 2,
    EAGAIN: 6,
    EBADF: 8,
    EBUSY: 10,
    EEXIST: 20,
    EFBIG: 22,
    EINVAL: 28,
    EIO: 29,
    EISDIR: 31,
    ELOOP: 32,
    ENAMETOOLONG: 37,
    ENOENT: 44,
    ENOSPC: 51,
    ENOTDIR: 54,
    ENOTEMPTY: 55,
    ENOTSUP: 58,
    ENXIO: 60,
    EPERM: 63,
    EROFS: 69,
    ESTALE: 72,
    EXDEV: 75
  };
  var errno = {
    ...VFS_ERRNO2,
    // The codec's own refusals, and the session's for a process it no longer holds.
    EFAULT: 21,
    EINTR: 27,
    EMFILE: 33,
    ENFILE: 41,
    ENOMEM: 48,
    ENOSYS: 52,
    EPIPE: 64,
    ESPIPE: 70,
    ESRCH: 71,
    ENOTCAPABLE: 76
  };
  function after(value, next) {
    return value instanceof Promise ? value.then(next) : next(value);
  }
  function fail(code) {
    throw Object.assign(new Error(code), { code });
  }
  function closeUnawaited(fs, handle) {
    try {
      const closing = fs.close(handle);
      if (closing instanceof Promise)
        closing.catch(() => {
        });
    } catch {
    }
  }
  function openIdentified(fs, name, follow, flags, identity2) {
    if (flags.create && flags.exclusive)
      fail("EEXIST");
    return after(fs.open(name, { ...flags, create: false, exclusive: false, truncate: false, followSymlinks: follow }), (handle) => {
      if (handle.stat.dev !== identity2.dev || handle.stat.ino !== identity2.ino) {
        closeUnawaited(fs, handle.id);
        fail("ENOENT");
      }
      if (!flags.truncate)
        return handle;
      return after(fs.ftruncate(handle.id, 0), () => ({ ...handle, stat: { ...handle.stat, size: 0 } }));
    });
  }

  // ../core/dist/runtime/wasi/own-names.js
  function parentKey2(key) {
    const at = stringLastIndexOf(key, "/");
    return at < 0 ? "" : stringSlice(key, 0, at);
  }
  function nameOf(key) {
    return stringSlice(key, stringLastIndexOf(key, "/") + 1);
  }
  function within(key, root) {
    return key === root || stringStartsWith(key, `${root}/`);
  }
  function ownNames(options) {
    const decided = new SafeMap();
    const born = new SafeMap();
    let generations = 0;
    const own = new SafeMap();
    const added = new SafeMap();
    const removed2 = new SafeMap();
    let barriers = 0;
    const made = new SafeSet();
    const madeHere = (key) => made.has(key) && decided.get(key)?.type === "directory" && !options.entry(key);
    const forget = (key) => {
      const entry = decided.get(key);
      own.delete(key);
      decided.delete(key);
      born.delete(key);
      made.delete(key);
      const madeIn = added.get(parentKey2(key));
      if (madeIn !== void 0)
        madeIn.delete(nameOf(key));
      const goneIn = removed2.get(parentKey2(key));
      if (goneIn !== void 0)
        goneIn.delete(nameOf(key));
      const madeThere = added.get(key);
      if (madeThere !== void 0 && madeThere.size === 0)
        added.delete(key);
      options.forgot(key, entry);
    };
    return {
      entry: (key) => {
        const mine = decided.get(key);
        if (mine !== void 0 || made.size === 0)
          return mine;
        const dir = parentKey2(key);
        if (key === "" || !madeHere(dir))
          return void 0;
        const madeIn = added.get(dir);
        return madeIn === void 0 || !madeIn.has(nameOf(key)) ? null : void 0;
      },
      decided,
      decide: (key, entry) => {
        decided.set(key, entry);
        born.set(key, ++generations);
      },
      generation: (key) => born.get(key),
      current: (key) => own.has(key) ? void 0 : decided.get(key),
      rewritten: (key) => {
        if (own.size !== 0)
          own.delete(key);
      },
      undecide: (key) => {
        decided.delete(key);
        born.delete(key);
      },
      superseded: (key) => {
        const names = mapKeyList(decided);
        for (let i = 0; i < names.length; i++)
          if (within(names[i], key))
            forget(names[i]);
      },
      settled: (key, generation) => {
        if (generation === void 0 || born.get(key) !== generation)
          return false;
        forget(key);
        return true;
      },
      note: (dir, name, type) => {
        if (type === null) {
          const madeIn = added.get(dir);
          if (madeIn !== void 0)
            madeIn.delete(name);
          let gone = removed2.get(dir);
          if (gone === void 0)
            removed2.set(dir, gone = new SafeSet());
          gone.add(name);
        } else {
          const goneIn = removed2.get(dir);
          if (goneIn !== void 0)
            goneIn.delete(name);
          let made2 = added.get(dir);
          if (made2 === void 0)
            added.set(dir, made2 = new SafeMap());
          made2.set(name, type);
        }
      },
      madeDirectory: (key) => {
        made.add(key);
        added.set(key, added.get(key) ?? new SafeMap());
      },
      removedDirectory: (key) => {
        made.delete(key);
        added.delete(key);
        removed2.delete(key);
      },
      children: (key, base) => {
        const made2 = added.get(key);
        const gone = removed2.get(key);
        if (made2 === void 0 && gone === void 0)
          return base;
        if (base === void 0 && !madeHere(key))
          return void 0;
        const out = new SafeMap();
        if (base !== void 0) {
          for (let i = 0; i < base.length; i++)
            if (gone === void 0 || !gone.has(base[i].name))
              out.set(base[i].name, base[i].type);
        }
        if (made2 !== void 0)
          made2.forEach((type, name) => {
            out.set(name, type);
          });
        const listed = new SafeList();
        out.forEach((type, name) => {
          listed[listed.length] = { name, type };
        });
        return arrayCopy(listed);
      },
      move: (from, to) => {
        const moved2 = (key) => to + stringSlice(key, from.length);
        const keys = mapKeyList(decided);
        const values = mapValueList(decided);
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          if (key === from || !within(key, from))
            continue;
          decided.delete(key);
          born.delete(key);
          decided.set(moved2(key), values[i]);
          born.set(moved2(key), ++generations);
        }
        const dirs = setList(made);
        for (let i = 0; i < dirs.length; i++)
          if (within(dirs[i], from)) {
            made.delete(dirs[i]);
            made.add(moved2(dirs[i]));
          }
        const moveAll = (map) => {
          const at = mapKeyList(map);
          const held = mapValueList(map);
          for (let i = 0; i < at.length; i++)
            if (within(at[i], from)) {
              map.delete(at[i]);
              map.set(moved2(at[i]), held[i]);
            }
        };
        moveAll(added);
        moveAll(removed2);
        const owned2 = mapKeyList(own);
        for (let i = 0; i < owned2.length; i++)
          if (owned2[i] !== from && within(owned2[i], from))
            own.delete(owned2[i]);
      },
      released: (root) => {
        decided.forEach((_entry, key) => {
          if (within(key, root))
            own.set(key, { barrier: barriers, generation: born.get(key) });
        });
      },
      barrierBegun: () => ++barriers,
      // A subtree held again since does not keep it: what the session has there now is what the view read.
      retire: (begun) => {
        const keys = mapKeyList(own);
        const stamps = mapValueList(own);
        for (let i = 0; i < keys.length; i++) {
          const { barrier, generation } = stamps[i];
          if (born.get(keys[i]) !== generation)
            own.delete(keys[i]);
          else if (barrier < begun)
            forget(keys[i]);
        }
      }
    };
  }

  // ../core/dist/runtime/wasi/inode-fold.js
  function owned(bytes, length = bytes.length) {
    const copy = new Uint8ArrayConstructor(length);
    typedArraySet(copy, length === bytes.length ? bytes : bytesView(bytes, 0, length));
    return copy;
  }
  var SMALL_WRITE = 64;
  var smallWrite = new Uint8ArrayConstructor(SMALL_WRITE);
  function copyInto(target, source, offset) {
    const length = source.length;
    if (length > SMALL_WRITE) {
      typedArraySet(target, source, offset);
      return;
    }
    for (let i = 0; i < length; i++)
      smallWrite[i] = source[i];
    for (let i = 0; i < length; i++)
      target[offset + i] = smallWrite[i];
  }
  function copyState(state) {
    return { ...state, bytes: state.bytes === null ? null : owned(state.bytes, state.size) };
  }
  function grown(state, size) {
    const bytes = state.bytes;
    if (size <= bytes.length)
      return bytes;
    const next = new Uint8ArrayConstructor(mathMax(size, bytes.length * 2, 4096));
    typedArraySet(next, state.size === bytes.length ? bytes : bytesView(bytes, 0, state.size));
    return next;
  }
  function applyOp(state, op) {
    switch (op.kind) {
      case "write":
      case "append": {
        if (op.data.length === 0)
          return state;
        const offset = op.kind === "append" ? state.size : op.offset;
        const end = offset + op.data.length;
        if (state.bytes !== null) {
          const bytes = grown(state, end);
          if (offset > state.size)
            typedArrayFill(bytes, 0, state.size, offset);
          copyInto(bytes, op.data, offset);
          state.bytes = bytes;
        }
        state.size = mathMax(state.size, end);
        state.mtime = state.ctime = op.at;
        return state;
      }
      case "truncate": {
        if (op.size === 0)
          state.bytes = new Uint8ArrayConstructor(0);
        else if (state.bytes !== null && op.size > state.size) {
          const bytes = grown(state, op.size);
          typedArrayFill(bytes, 0, state.size, op.size);
          state.bytes = bytes;
        }
        state.size = op.size;
        state.mtime = state.ctime = op.at;
        return state;
      }
      case "chmod":
        state.mode = state.mode & ~4095 | op.mode & 4095;
        state.ctime = op.at;
        return state;
      case "chown":
        state.uid = op.uid ?? state.uid;
        state.gid = op.gid ?? state.gid;
        state.mode = chownedMode(state.mode, { uid: op.by });
        state.ctime = op.at;
        return state;
      case "utimes":
        state.atime = timeAt(op.atime, state.atime, op.at);
        state.mtime = timeAt(op.mtime, state.mtime, op.at);
        state.ctime = op.at;
        return state;
    }
  }
  function foldOps(baseline, ops) {
    let state = copyState(baseline);
    for (let i = 0; i < ops.length; i++)
      state = applyOp(state, ops[i]);
    return state;
  }

  // ../core/dist/runtime/wasi/provisional.js
  var LOCAL_INOS = 2 ** 50;
  var RECORD_COST = 160;
  var INODE_COST = 320;
  var stringCost = (text) => text.length * 2;
  var retained = (bytes) => bytes === null || bytes === void 0 ? 0 : arrayBufferByteLength(typedArrayBuffer(bytes));
  var payloadOf = (op) => op.kind === "write" || op.kind === "append" ? op.data.length : 0;
  function parentKey3(key) {
    const at = stringLastIndexOf(key, "/");
    return at < 0 ? "" : stringSlice(key, 0, at);
  }
  function nameOf2(key) {
    return stringSlice(key, stringLastIndexOf(key, "/") + 1);
  }
  function within2(key, root) {
    return key === root || stringStartsWith(key, `${root}/`);
  }
  var descriptionId = () => crypto.randomUUID().replaceAll("-", "");
  var NO_RECORDS = Object.freeze([]);
  var NO_RETAINED = Object.freeze([]);
  var WHOLE_WRITTEN = /* @__PURE__ */ Symbol("written whole");
  function provisional(host2) {
    const table = new SafeMap();
    const held = new SafeSet();
    const loose = new SafeSet();
    const inodeAtNumber = (dev, ino) => {
      const numbers = table.get(dev);
      return numbers === void 0 ? void 0 : numbers.get(ino);
    };
    const addInode = (inode) => {
      let numbers = table.get(inode.dev);
      if (numbers === void 0)
        table.set(inode.dev, numbers = new SafeMap());
      numbers.set(inode.ino, inode);
      (ownValue(inode, "cell") === void 0 ? loose : held).add(inode);
    };
    const removeInode = (inode) => {
      const numbers = table.get(inode.dev);
      if (numbers === void 0 || numbers.get(inode.ino) !== inode)
        return;
      numbers.delete(inode.ino);
      if (numbers.size === 0)
        table.delete(inode.dev);
      held.delete(inode);
      loose.delete(inode);
    };
    const setCell = (inode, cell) => {
      if (cell === void 0)
        delete inode.cell;
      else
        inode.cell = cell;
      if (inodeAtNumber(inode.dev, inode.ino) !== inode)
        return;
      (cell === void 0 ? held : loose).delete(inode);
      (cell === void 0 ? loose : held).add(inode);
    };
    const everyInode = () => {
      const every = setList(held);
      loose.forEach((inode) => {
        every[every.length] = inode;
      });
      return arrayCopy(every);
    };
    const pendingMoves = new SafeSet();
    const pendingGrowth = (key, origin) => {
      if (pendingMoves.size === 0)
        return 0;
      let total = 0;
      pendingMoves.forEach(({ from, to }) => {
        if (within2(key, from))
          total += mathMax(0, 2 * stringCost(to + stringSlice(key, from.length)) - stringCost(key) - stringCost(origin));
      });
      return total;
    };
    const descs = /* @__PURE__ */ new Map();
    const sessions = /* @__PURE__ */ new Map();
    const layer = new SafeMap();
    const added = new SafeMap();
    const removed2 = new SafeMap();
    const nameRecords = [];
    const touched = new SafeSet();
    let ids = 0;
    let barriers = 0;
    let localIno = LOCAL_INOS;
    let wasActive = false;
    const activity = () => {
      const on = layer.size > 0 || touched.size > 0;
      if (on === wasActive)
        return;
      wasActive = on;
      host2.active(on);
    };
    const admit = (bytes, syscall, path) => {
      if (bytes > 0 && !host2.reserve(bytes))
        throw fsError2("ENOSPC", syscall, path);
    };
    const rowAt = (key) => {
      const own = provisionalEntry(key);
      return own !== void 0 ? own : host2.row(key);
    };
    const entryOf = (inode) => {
      const s = inode.state;
      const row = inode.row;
      const nlink = inode.unnamed ? 0 : row.nlink;
      return s === null ? nlink === row.nlink ? row : { ...row, nlink } : { ...row, size: s.size, mode: s.mode, uid: s.uid, gid: s.gid, atime: s.atime, mtime: s.mtime, ctime: s.ctime, nlink };
    };
    const viewNameBeneathMoved = (key) => {
      for (let at = stringLastIndexOf(key, "/"); at > 0; at = stringLastIndexOf(key, "/", at - 1)) {
        const dir = stringSlice(key, 0, at);
        if (!layer.has(dir))
          continue;
        const inode = layer.get(dir);
        if (inode === null || inode.local)
          return void 0;
        if (inode.origin !== dir)
          return inode.origin + stringSlice(key, at);
      }
      return void 0;
    };
    const provisionalEntry = (key, known) => {
      if (layer.size === 0 && touched.size === 0)
        return void 0;
      if (layer.has(key)) {
        const inode = layer.get(key);
        return inode === null ? null : entryOf(inode);
      }
      if (layer.size > 0) {
        const viewed2 = viewNameBeneathMoved(key);
        if (viewed2 !== void 0)
          return host2.row(viewed2);
      }
      if (touched.size > 0) {
        const row = known !== void 0 ? known : host2.row(key);
        const changed = row ? inodeAtNumber(row.dev, row.ino) : void 0;
        if (changed !== void 0 && changed.state !== null && !changed.local && ownValue(changed, "cell") === void 0 && ownValue(changed, "heldAt") === void 0 && changed.records.length === 0 && !placed(changed)) {
          renamed(changed, key, key, true);
          changed.row = row;
          changed.base = changed.state = null;
          touched.delete(changed);
          fit(changed);
          activity();
          return void 0;
        }
        if (changed !== void 0 && changed.state !== null)
          return entryOf(changed);
      }
      if (layer.size === 0)
        return void 0;
      const dir = parentKey3(key);
      const made2 = layer.get(dir);
      if (!made2 || !made2.local)
        return void 0;
      const madeIn = added.get(dir);
      return madeIn === void 0 || !madeIn.has(nameOf2(key)) ? null : void 0;
    };
    const placed = (inode) => {
      let found = false;
      layer.forEach((value) => {
        if (value === inode)
          found = true;
      });
      return found;
    };
    const expecting = (row, key) => {
      if (host2.mounted?.(key) === true || host2.pending?.(key) === true)
        return {};
      if (row === null)
        return { expect: null };
      const inode = inodeAtNumber(row.dev, row.ino);
      if (inode?.local !== true)
        return { expect: row.ino };
      return inode.made === void 0 ? {} : { expect: { made: inode.made } };
    };
    const canonical2 = (inode) => {
      let at = inode;
      while (at.merged !== void 0)
        at = at.merged;
      return at;
    };
    const inodeAt = (key, row) => {
      let inode = inodeAtNumber(row.dev, row.ino);
      if (inode === void 0) {
        inode = { dev: row.dev, ino: row.ino, type: row.type, key, origin: key, row, base: null, state: null, records: NO_RECORDS, recordsCost: 0, unnamed: false, local: false, descs: 0, retained: NO_RETAINED, answers: 0, reserved: 0 };
        addInode(inode);
      }
      return inode;
    };
    const named = (inode) => {
      const row = rowAt(inode.key);
      if (row === void 0)
        return !inode.unnamed;
      const found = row !== null && row.dev === inode.dev && row.ino === inode.ino;
      inode.unnamed = !found;
      if (found && inode.state === null && !inode.local)
        inode.row = row;
      return found;
    };
    const viewed = (inode) => {
      if (ownValue(inode, "lost"))
        return void 0;
      const name = inode.origin;
      const row = host2.row(name);
      if (!row || row.dev !== inode.dev || row.ino !== inode.ino)
        return void 0;
      const held2 = inode.type === "file" ? host2.content(name, row.revision) : void 0;
      return { name, row, bytes: held2 !== void 0 && held2.length === row.size ? held2 : void 0 };
    };
    const pinned = (inode, seen, revision) => {
      const pin = ownValue(inode, "pin");
      if (pin === void 0)
        return void 0;
      if (seen === void 0)
        return inode.local || named(inode) ? void 0 : pin.bytes;
      return pin.revision === revision ? pin.bytes : void 0;
    };
    const unknown = (inode) => !inode.local && inode.state === null && (inode.lost === true || host2.row(inode.origin) === void 0);
    const baseline = (inode) => {
      const seen = inode.local ? void 0 : viewed(inode);
      if (seen !== void 0) {
        inode.row = seen.row;
        const generation = host2.generation(seen.name);
        if (generation !== void 0)
          setOwnValue(inode, "over", { key: seen.name, generation });
      }
      const row = inode.row;
      const held2 = seen?.bytes ?? pinned(inode, seen, row.revision);
      const bytes = held2 === void 0 ? row.size === 0 ? new Uint8ArrayConstructor(0) : null : owned(held2);
      return { bytes, size: row.size, mode: row.mode, uid: row.uid, gid: row.gid, atime: row.atime, mtime: row.mtime, ctime: row.ctime };
    };
    const cost = (inode) => {
      const cell = pendingMoves.size === 0 ? void 0 : ownValue(inode, "cell");
      const pin = ownValue(inode, "pin");
      let total = INODE_COST + stringCost(inode.key) + stringCost(inode.origin) + (pendingMoves.size === 0 || cell !== void 0 && ownValue(cell, "detached") !== void 0 ? 0 : pendingGrowth(inode.key, inode.origin)) + (inode.row.target === null ? 0 : stringCost(inode.row.target)) + retained(inode.base?.bytes) + (inode.state === inode.base ? 0 : retained(inode.state?.bytes)) + retained(pin === void 0 ? void 0 : pin.bytes) + inode.recordsCost;
      return total;
    };
    const recordCost = (record) => {
      const room = ownValue(record, "room");
      return RECORD_COST + (room === void 0 ? payloadOf(record.op) : room.length);
    };
    const dropRecords = (inode, leaving) => {
      if (leaving.size === 0)
        return;
      const kept = new SafeList();
      const records = inode.records;
      for (let i = 0; i < records.length; i++) {
        const record = records[i];
        if (!leaving.has(record)) {
          kept[kept.length] = record;
          continue;
        }
        setOwnValue(record, "gone", true);
        inode.recordsCost -= recordCost(record);
      }
      inode.records = arrayCopy(kept);
    };
    const opsOf = (records) => {
      const ops = new SafeList();
      for (let i = 0; i < records.length; i++)
        ops[i] = records[i].op;
      return ops;
    };
    const projectedCost = (inode, ops) => {
      if (ops.length === 0)
        return cost(inode);
      let baseBytes = inode.base === null ? 0 : retained(inode.base.bytes);
      let capacity = inode.state?.bytes?.byteLength ?? 0;
      let known = inode.state !== null && inode.state.bytes !== null;
      let size = inode.state?.size ?? inode.row.size;
      if (inode.base === null) {
        const seen = inode.local || inode.cell !== void 0 ? void 0 : viewed(inode);
        const held2 = inode.cell !== void 0 ? inode.cell.bytes.subarray(0, inode.cell.length) : seen?.bytes ?? pinned(inode, seen, seen?.row.revision ?? inode.row.revision);
        known = held2 !== void 0 || inode.row.size === 0;
        baseBytes = held2?.byteLength ?? 0;
        capacity = baseBytes;
        size = held2?.byteLength ?? inode.row.size;
      }
      let total = cost(inode) - retained(inode.base?.bytes) - retained(inode.state?.bytes) + baseBytes;
      for (const op of ops) {
        if (op.kind === "truncate" && op.size === 0)
          known = true;
        const end = op.kind === "write" ? op.offset + op.data.byteLength : op.kind === "append" ? size + op.data.byteLength : op.kind === "truncate" ? op.size : size;
        if (known && end > capacity)
          capacity = Math.max(end, capacity * 2, 4096);
        if (op.kind === "truncate")
          size = op.size;
        else if (op.kind === "write" || op.kind === "append")
          size = Math.max(size, end);
        total += RECORD_COST + payloadOf(op);
      }
      return total + (known ? capacity : 0);
    };
    const fit = (inode) => {
      let need = cost(inode) - inode.reserved;
      if (need > 0 && !host2.reserve(need)) {
        reflectDeleteProperty(inode, "pin");
        if (inode.base !== null)
          inode.base = { ...inode.base, bytes: null };
        if (inode.state !== null)
          inode.state = foldOps(inode.base ?? { ...inode.state, bytes: null }, opsOf(inode.records));
        need = cost(inode) - inode.reserved;
        if (need > 0 && !host2.reserve(need))
          need = 0;
      }
      if (need < 0)
        host2.release(-need);
      inode.reserved += need;
    };
    const renamed = (inode, key, origin, current = origin !== inode.origin) => {
      const was = { key: inode.key, origin: inode.origin };
      inode.key = key;
      inode.origin = origin;
      const need = cost(inode) - inode.reserved;
      if (need > 0 && !host2.reserve(need)) {
        inode.key = was.key;
        inode.origin = was.origin;
        setOwnValue(inode, "lost", true);
        return;
      }
      if (need > 0)
        inode.reserved += need;
      if (current)
        reflectDeleteProperty(inode, "lost");
      fit(inode);
    };
    const admitOps = (inode, ops, syscall, path) => {
      const need = projectedCost(inode, ops) - inode.reserved;
      admit(need, syscall, path);
      if (need > 0)
        inode.reserved += need;
    };
    const unshared = (inode) => {
      if (inode.state !== null && inode.state === inode.base)
        inode.state = copyState(inode.base);
    };
    const unheld = (inode) => {
      const cell = inode.cell;
      if (cell === void 0)
        return;
      if (cell.detached === void 0)
        host2.unhold(inode);
      else
        provisional2.unhold(inode, cell.detached);
    };
    const ready = (inode) => {
      unheld(inode);
      if (inode.base === null) {
        inode.base = baseline(inode);
        inode.state = copyState(inode.base);
      }
      unshared(inode);
      touched.add(inode);
      activity();
    };
    const fold = (inode, op, description) => {
      ready(inode);
      return recorded(inode, op, description);
    };
    const recorded = (inode, op, description) => {
      const record = { id: ++ids, op, owner: inode, ...description === void 0 ? {} : { description }, answered: false, answeredAt: 0 };
      if (inode.records === NO_RECORDS)
        inode.records = [record];
      else
        inode.records.push(record);
      inode.recordsCost += recordCost(record);
      inode.state = applyOp(inode.state, op);
      return record;
    };
    const release = (inode) => {
      if (inode.records.length > 0 || inode.descs > 0 || inode.answers > 0 || ownValue(inode, "cell") !== void 0)
        return;
      if (layer.size > 0 && placed(inode))
        return;
      for (let i = 0; i < nameRecords.length; i++)
        if (arrayIncludes(nameRecords[i].places, inode))
          return;
      if (inode.state !== null && named(inode))
        return;
      touched.delete(inode);
      inode.base = null;
      inode.state = null;
      host2.release(inode.reserved);
      inode.reserved = 0;
      removeInode(inode);
      activity();
    };
    const endedOnly = (error) => {
      if (!host2.client.ended)
        throw error;
    };
    const logged = (op, settle, awaited = false) => {
      host2.drain();
      const settled = (refused, answer) => {
        settle(refused, answer);
        host2.sent();
      };
      if (awaited) {
        const answer = host2.client.submit(op);
        void answer.then((answered) => settled(false, answered), () => settled(true, void 0)).catch(endedOnly);
        return answer;
      }
      settles(host2.client.submit(op, { acknowledged: true }), settle);
      return void 0;
    };
    const settles = (answer, settle) => {
      void answer.then((answered) => {
        settle(answered.failed?.refused === true, answered);
        host2.sent();
      }, () => {
        settle(false, void 0);
        host2.sent();
      }).catch(endedOnly);
    };
    const refold = (inode) => {
      if (inode.base === null)
        return;
      inode.state = foldOps(inode.base, opsOf(inode.records));
    };
    const settleRecords = (records, refused, after3) => {
      if (!refused) {
        for (const record of records) {
          if (record.gone)
            continue;
          record.answered = true;
          record.answeredAt = barriers;
          if (after3 !== void 0)
            record.after = after3;
        }
        return;
      }
      const refusedOf = /* @__PURE__ */ new Map();
      for (const record of records) {
        if (record.gone)
          continue;
        let mine = refusedOf.get(record.owner);
        if (mine === void 0)
          refusedOf.set(record.owner, mine = new SafeSet());
        mine.add(record);
      }
      for (const [inode, mine] of refusedOf) {
        dropRecords(inode, mine);
        refold(inode);
        fit(inode);
        release(inode);
      }
    };
    const nameCost = (keys, target = "") => RECORD_COST + keys.reduce((sum, key) => sum + stringCost(key), 0) + stringCost(target);
    const loggedOn = (records, op, awaited = false) => logged(op, (refused, answer) => settleRecords(records, refused, answer?.mutation?.after), awaited);
    const extended2 = (record, data, at) => {
      const op = record.op;
      const before = op.data.byteLength;
      const length = before + data.byteLength;
      const counted = recordCost(record);
      let room = record.room;
      if (room === void 0 || room.byteLength < length) {
        const grown2 = new Uint8Array(Math.max(length, before * 2));
        grown2.set(op.data);
        record.room = room = grown2;
      }
      room.set(data, before);
      op.data = room.subarray(0, length);
      op.at = at;
      record.owner.recordsCost += recordCost(record) - counted;
    };
    const replay = () => {
      const every = everyInode();
      for (let i = 0; i < every.length; i++)
        renamed(every[i], every[i].origin, every[i].origin);
      layer.clear();
      added.clear();
      removed2.clear();
      for (let i = 0; i < nameRecords.length; i++)
        nameRecords[i].replay();
      touched.clear();
      const now = everyInode();
      for (let i = 0; i < now.length; i++) {
        const inode = now[i];
        if (inode.state !== null)
          touched.add(inode);
        fit(inode);
      }
      activity();
    };
    const loggedName = (op, keys, cost2, apply, settled, retired, awaited = false) => {
      const over = keys.map((key) => host2.generation(key));
      apply();
      const places = keys.flatMap((key) => {
        const placed2 = layer.get(key);
        return placed2 ? [placed2] : [];
      });
      const record = { id: ++ids, keys, over, cost: cost2, places, replay: apply, ...retired === void 0 ? {} : { retired }, answered: false, answeredAt: 0 };
      nameRecords.push(record);
      for (const key of keys)
        host2.count(key);
      return logged(op, (refused, answer) => {
        if (refused) {
          const at = nameRecords.indexOf(record);
          if (at >= 0)
            nameRecords.splice(at, 1);
          host2.release(record.cost);
          replay();
          for (const inode of everyInode())
            if (inode.local)
              release(inode);
        } else {
          record.answered = true;
          record.answeredAt = barriers;
        }
        settled?.(refused, answer);
      }, awaited);
    };
    const note = (dir, name, type) => {
      if (type === null) {
        added.get(dir)?.delete(name);
        let gone = removed2.get(dir);
        if (gone === void 0)
          removed2.set(dir, gone = new SafeSet());
        gone.add(name);
      } else {
        removed2.get(dir)?.delete(name);
        let made2 = added.get(dir);
        if (made2 === void 0)
          added.set(dir, made2 = new SafeMap());
        made2.set(name, type);
      }
    };
    const place = (key, placed2) => {
      const inode = placed2 === null ? null : canonical2(placed2);
      layer.set(key, inode);
      note(parentKey3(key), nameOf2(key), inode === null ? null : inode.type);
      if (inode !== null) {
        touched.delete(inode);
        renamed(inode, key, inode.origin);
        inode.unnamed = false;
        if (inode.state !== null)
          touched.add(inode);
      }
      activity();
    };
    const writableParent = (key, path, syscall) => {
      const parent = rowAt(parentKey3(key));
      if (parent === void 0 || parent === null || parent.dev !== host2.device && host2.mounted?.(key) !== true)
        return void 0;
      if (parent.type !== "directory")
        throw fsError2("ENOTDIR", syscall, path);
      if (!modeAllows(parent, 3, host2.cred))
        throw fsError2("EACCES", syscall, path);
      return parent;
    };
    const removable = (key, row, path, syscall) => {
      const parent = writableParent(key, path, syscall);
      if (parent === void 0)
        return false;
      if (stickyRefusal(parent, row, host2.cred) !== null)
        throw fsError2("EPERM", syscall, path);
      return true;
    };
    const ownership = (parent) => {
      const setgid = (parent.mode & 1024) !== 0;
      return { uid: host2.cred.uid, gid: setgid ? parent.gid : host2.cred.gid, setgid };
    };
    const made = (key, type, mode, parent, target = null) => {
      const { uid, gid } = ownership(parent);
      const at = host2.now();
      const row = {
        type,
        dev: host2.device,
        ino: localIno++,
        nlink: type === "directory" ? 2 : 1,
        size: target === null ? 0 : textEncoderEncode(newTextEncoder(), target).length,
        atime: at,
        mtime: at,
        ctime: at,
        mode,
        uid,
        gid,
        revision: 0,
        target
      };
      const inode = { dev: row.dev, ino: row.ino, type, key, origin: key, row, base: null, state: null, records: NO_RECORDS, recordsCost: 0, unnamed: false, local: true, descs: 0, retained: NO_RETAINED, answers: 0, reserved: 0 };
      if (type === "file") {
        inode.base = { bytes: new Uint8ArrayConstructor(0), size: 0, mode, uid, gid, atime: at, mtime: at, ctime: at };
        inode.state = copyState(inode.base);
        touched.add(inode);
        activity();
      }
      addInode(inode);
      inode.reserved = cost(inode);
      return inode;
    };
    const madeCost = (key, target = "") => INODE_COST + 2 * stringCost(key) + stringCost(target) + pendingGrowth(key, key);
    const keepForDescriptors = (inode, more, syscall, path) => {
      const seen = inode === void 0 || inode.descs === 0 || inode.base !== null ? void 0 : viewed(inode);
      if (inode === void 0 || seen?.bytes === void 0) {
        admit(more, syscall, path);
        return;
      }
      const held2 = seen.bytes.byteLength;
      admit(more + 2 * held2, syscall, path);
      inode.reserved += 2 * held2;
      inode.base = baseline(inode);
      inode.state = copyState(inode.base);
      touched.add(inode);
      fit(inode);
    };
    const reconcile = (inode, answer, creating) => {
      const receipt = answer?.receipt;
      const file = receipt !== void 0 && creating && inode.local ? canonicalize(inode, receipt) : inode;
      fit(file);
      return file;
    };
    const canonicalize = (made2, receipt) => {
      removeInode(made2);
      made2.local = false;
      const owner = inodeAtNumber(receipt.dev, receipt.ino) ?? made2;
      if (owner === made2) {
        made2.dev = receipt.dev;
        made2.ino = receipt.ino;
        addInode(made2);
      } else {
        for (const desc of descs.values())
          if (desc.inode === made2)
            desc.inode = owner;
        for (const record of made2.records)
          record.owner = owner;
        owner.records = [...owner.records, ...made2.records].sort((a, b) => a.id - b.id);
        owner.recordsCost += made2.recordsCost;
        owner.descs += made2.descs;
        owner.answers += made2.answers;
        owner.retained = [...owner.retained, ...made2.retained];
        for (const [key, value] of layer)
          if (value === made2)
            layer.set(key, owner);
        for (const record of nameRecords)
          record.places = record.places.map((inode) => inode === made2 ? owner : inode);
        touched.delete(made2);
        host2.release(made2.reserved);
        made2.reserved = 0;
        bury(made2, owner);
      }
      owner.row = { ...owner.row, dev: receipt.dev, ino: receipt.ino, size: receipt.size, mode: receipt.mode, uid: receipt.uid, gid: receipt.gid };
      owner.base = { bytes: receipt.size === 0 ? new Uint8Array(0) : null, size: receipt.size, mode: receipt.mode, uid: receipt.uid, gid: receipt.gid, atime: receipt.mtimeMs, mtime: receipt.mtimeMs, ctime: receipt.ctimeMs };
      refold(owner);
      return owner;
    };
    const bury = (dead, owner) => {
      for (const field of Object.keys(dead)) {
        Object.defineProperty(dead, field, {
          get: () => {
            throw new Error(`a merged Inode's ${field} used after its merge (canonical)`);
          },
          configurable: true
        });
      }
      Object.defineProperty(dead, "merged", { value: owner });
    };
    const openAnswered = (opened, description, records, creating, read) => (refused, answer) => {
      let inode = canonical2(opened);
      inode.answers--;
      if (!refused && answer?.receipt?.handle !== void 0)
        sessions.set(description, { handle: answer.receipt.handle, read });
      if (inode.made === description)
        delete inode.made;
      if (!refused)
        inode = reconcile(inode, answer, creating);
      if (refused && inode.retained.includes(description)) {
        inode.retained = inode.retained.filter((kept) => kept !== description);
        sessions.delete(description);
      }
      closeRetained(inode);
      settleRecords(records, refused, answer?.mutation?.after);
      fit(inode);
      release(inode);
    };
    const closeRetained = (inode) => {
      if (inode.descs > 0 || inode.made !== void 0 || inode.retained.length === 0)
        return;
      const retained2 = inode.retained;
      inode.retained = NO_RETAINED;
      for (const description of retained2) {
        sessions.delete(description);
        logged({ type: "call", call: { call: "close", path: inode.key, description } }, () => {
        });
      }
    };
    const descriptor = (inode, path, flags, description) => {
      const id = host2.nextHandle();
      const write = flags.write === true || flags.append === true;
      descs.set(id, { inode, read: flags.read === true || !write, write, append: flags.append === true, position: 0, path, ...description === void 0 ? {} : { description }, lastRecord: null, lastAnswer: null });
      inode.descs++;
      return { id, path };
    };
    const descOf = (handleId) => {
      const desc = descs.get(handleId);
      if (desc === void 0)
        throw fsError2("EBADF", "fd", String(handleId));
      return desc;
    };
    const bytesOf = (inode, syscall, path) => {
      if (inode.state !== null) {
        if (inode.state.bytes === null) {
          const seen2 = inode.heldAt === void 0 ? viewed(inode) : void 0;
          if (seen2?.bytes === void 0 || seen2.row.revision !== inode.row.revision)
            return void 0;
          inode.base = { ...inode.base, bytes: owned(seen2.bytes) };
          refold(inode);
          fit(inode);
          if (inode.state.bytes === null)
            return void 0;
        }
        return { bytes: inode.state.bytes, size: inode.state.size };
      }
      if (unknown(inode))
        return void 0;
      const seen = viewed(inode);
      if (seen === void 0) {
        if (named(inode) || inode.pin === void 0) {
          if (!named(inode))
            throw fsError2("ESTALE", syscall, path);
          return void 0;
        }
        return { bytes: inode.pin.bytes, size: inode.pin.bytes.byteLength };
      }
      inode.row = seen.row;
      if (seen.bytes === void 0) {
        const pin = pinned(inode, seen, seen.row.revision);
        return pin === void 0 ? void 0 : { bytes: pin, size: pin.byteLength };
      }
      if (inode.descs > 0 && inode.pin?.bytes !== seen.bytes) {
        inode.pin = { revision: seen.row.revision, bytes: seen.bytes };
        fit(inode);
      }
      return { bytes: seen.bytes, size: seen.bytes.byteLength };
    };
    const anchorOf = (inode, read = false) => {
      if (inode.descs === 0)
        return void 0;
      for (const description of inode.retained)
        if (!read || sessions.get(description)?.read === true)
          return description;
      for (const desc of descs.values())
        if (desc.inode === inode && desc.description !== void 0 && (!read || sessions.get(desc.description)?.read === true))
          return desc.description;
      return void 0;
    };
    const by = (desc) => {
      const description = desc.description ?? anchorOf(desc.inode);
      return description !== void 0 ? { description } : { ino: desc.inode.ino };
    };
    const contentOp = (desc, op, call, logs, syscall, awaited = false) => {
      const inode = desc.inode;
      if (desc.description === void 0 && inode.state === null && !named(inode))
        throw fsError2("ESTALE", syscall, desc.path);
      host2.drain();
      host2.client.fitsSync(logs, desc.path);
      admitOps(inode, [op], syscall, desc.path);
      ready(inode);
      host2.drain();
      if (awaited) {
        const record = recorded(desc.inode, op, desc.description);
        desc.lastRecord = record;
        const answer = host2.client.submit(call);
        desc.lastAnswer = answer;
        void answer.then((answered) => settleRecords([record], false, answered.mutation?.after), () => settleRecords([record], true)).then(() => {
          fit(inode);
          host2.sent();
        }).catch(endedOnly);
        fit(inode);
        return answer;
      }
      recordedFor(desc, op, host2.client.submit(call, { acknowledged: true }));
      fit(inode);
      return void 0;
    };
    const recordedFor = (desc, op, answer) => {
      const record = recorded(desc.inode, op, desc.description);
      desc.lastRecord = record;
      desc.lastAnswer = answer;
      settles(answer, (refused, answered) => settleRecords([record], refused, answered?.mutation?.after));
    };
    const continued = (desc, start, bytes, at) => {
      const inode = desc.inode;
      const last = desc.lastRecord;
      if (last === null || last.answered || last.gone === true || last.owner !== inode || inode.cell !== void 0 || inode.state === null)
        return false;
      const was = last.op;
      if (!("data" in was) || (start === void 0 ? was.kind !== "append" : was.kind !== "write" || start !== was.offset + was.data.byteLength))
        return false;
      unshared(inode);
      const state = inode.state;
      const before = was.data.byteLength;
      const length = before + bytes.byteLength;
      const recordRoom = last.room !== void 0 && last.room.byteLength >= length ? last.room.byteLength : Math.max(length, before * 2);
      const capacity = state.bytes?.byteLength ?? 0;
      const end = start === void 0 ? state.size + bytes.byteLength : start + bytes.byteLength;
      const growth = recordRoom - (last.room?.byteLength ?? before) + (state.bytes !== null && end > capacity ? Math.max(end, capacity * 2, 4096) - capacity : 0);
      host2.drain();
      host2.client.fitsSync(bytes.byteLength, desc.path);
      if (growth > 0) {
        const need = cost(inode) + growth - inode.reserved;
        admit(need, "write", desc.path);
        if (need > 0)
          inode.reserved += need;
      }
      const call = { type: "call", call: start === void 0 ? { call: "append", path: inode.key, ...by(desc), data: bytes } : { call: "write", path: inode.key, ...by(desc), offset: start, data: bytes } };
      const answer = host2.client.fold(call, { acknowledged: true });
      if (answer === void 0)
        return false;
      const op = start === void 0 ? { kind: "append", data: bytes, at } : { kind: "write", offset: start, data: bytes, at };
      if (answer === desc.lastAnswer) {
        extended2(last, bytes, at);
        inode.state = applyOp(state, op);
        if (growth > 0)
          fit(inode);
        return true;
      }
      const data = owned(bytes);
      recordedFor(desc, start === void 0 ? { kind: "append", data, at } : { kind: "write", offset: start, data, at }, answer);
      fit(inode);
      return true;
    };
    const judgeAttrs = (row, attrs, syscall, path) => {
      const refused = "mode" in attrs ? chmodRefusal(row, host2.cred) : "uid" in attrs ? chownRefusal(row, attrs.uid, attrs.gid, host2.cred) : utimesRefusal(row, explicitTimes(attrs.atime, attrs.mtime), host2.cred);
      if (refused !== null)
        throw fsError2(refused, syscall, path);
    };
    const attrOp = (attrs, at) => "mode" in attrs ? { kind: "chmod", mode: attrs.mode, at } : "uid" in attrs ? { kind: "chown", uid: attrs.uid, gid: attrs.gid, by: host2.cred.uid, at } : { kind: "utimes", atime: attrs.atime, mtime: attrs.mtime, at };
    const openToWrite = (key, path, flags, row, given, close, chmod, awaited = false) => {
      const bytes = given === null ? null : owned(given);
      const read = flags.read === true;
      const umask = flags.umask ?? host2.umask();
      const asked = (flags.mode ?? 438) & 511;
      let parent;
      if (row === null) {
        if (!flags.create)
          throw fsError2("ENOENT", "open", path);
        if (((flags.mode ?? 438) & 3584) !== 0)
          return void 0;
        parent = writableParent(key, path, "open");
        if (parent === void 0)
          return void 0;
      } else {
        if (row.type === "directory" && refusesDirectory(flags))
          throw fsError2("EISDIR", "open", path);
        if (row.type !== "file")
          return void 0;
        if (flags.create && flags.exclusive)
          throw fsError2("EEXIST", "open", path);
        if (!modeAllows(row, (read ? 4 : 0) | 2, host2.cred))
          throw fsError2("EACCES", "open", path);
      }
      const at = host2.now();
      const ops = [];
      if (flags.truncate)
        ops.push({ kind: "truncate", size: 0, at });
      if (bytes !== null && bytes.byteLength > 0)
        ops.push({ kind: "write", offset: 0, data: bytes, at });
      if (chmod !== void 0)
        ops.push({ kind: "chmod", mode: chmod, at });
      host2.drain();
      host2.client.fitsSync(bytes?.byteLength ?? 0, path);
      const inode = row === null ? null : inodeAt(key, row);
      if (inode !== null) {
        try {
          admitOps(inode, ops, "open", path);
        } catch (error) {
          release(inode);
          throw error;
        }
      } else {
        const written = bytes !== null && bytes.byteLength > 0 ? Math.max(bytes.byteLength, 4096) : 0;
        admit(madeCost(key) + nameCost([key]) + written + ops.reduce((sum, op) => sum + RECORD_COST + payloadOf(op), 0), "open", path);
      }
      const description = descriptionId();
      const open = {
        type: "call",
        call: {
          call: "open",
          path: key,
          mode: flags.create ? asked : row.mode & 4095,
          ...flags.create ? { umask, create: true } : {},
          ...flags.exclusive && row === null ? { exclusive: true } : {},
          ...flags.truncate ? { truncate: true } : {},
          ...flags.followSymlinks === false ? { nofollow: true } : {},
          access: read ? "readwrite" : "write",
          ...chmod === void 0 ? {} : { fchmod: chmod },
          description,
          // The file it decided this on (none, for a file it makes): the session refuses it where the name leads elsewhere.
          // One made exclusively needs none: the session's EEXIST refuses it first.
          ...flags.exclusive && row === null ? {} : expecting(row, key)
        }
      };
      let target;
      if (row === null) {
        target = made(key, "file", 32768 | asked & ~umask, parent);
        target.made = description;
        target.reserved += (bytes !== null && bytes.byteLength > 0 ? Math.max(bytes.byteLength, 4096) : 0) + ops.reduce((sum, op) => sum + RECORD_COST + payloadOf(op), 0);
      } else {
        target = inode;
      }
      if (close && bytes !== null && chmod === void 0 && host2.mounted?.(key) === true) {
        const records = ops.map((op) => fold(target, op));
        const whole = { type: "call", call: { call: "writeFile", path: key, mode: asked, umask, data: bytes } };
        const settled = (refused, answer) => {
          settleRecords(records, refused, answer?.mutation?.after);
          fit(target);
          release(target);
        };
        if (row === null)
          loggedName(whole, [key], nameCost([key]), () => place(key, target), settled);
        else {
          host2.count(key);
          logged(whole, settled);
        }
        fit(target);
        return WHOLE_WRITTEN;
      }
      target.answers++;
      const opened = ops.filter((op) => op.kind !== "write").map((op) => fold(target, op, description));
      const answered = openAnswered(target, description, opened, row === null, read);
      let opening;
      if (row === null) {
        opening = loggedName(open, [key], nameCost([key]), () => place(key, target), answered, void 0, awaited);
      } else {
        host2.count(key);
        opening = logged(open, answered, awaited);
      }
      for (const op of ops) {
        if (op.kind !== "write")
          continue;
        loggedOn([fold(target, op, description)], { type: "call", call: { call: "write", path: key, description, offset: op.offset, data: op.data } });
      }
      fit(target);
      const handle = descriptor(target, path, { ...flags, write: true }, description);
      descOf(handle.id).write = flags.write === true || flags.append === true || bytes !== null;
      if (opening !== void 0)
        descOf(handle.id).opening = opening;
      if (close)
        provisional2.close(handle.id);
      return handle;
    };
    const provisional2 = {
      inode: inodeAtNumber,
      inodeFor: (key, row) => {
        const known = inodeAtNumber(row.dev, row.ino);
        if (known !== void 0)
          return known;
        const inode = inodeAt(key, row);
        const need = cost(inode);
        if (!host2.reserve(need)) {
          removeInode(inode);
          return void 0;
        }
        inode.reserved = need;
        return inode;
      },
      heldDescriptor: (inode, path, read, append) => {
        const id = host2.nextHandle();
        descs.set(id, { inode, read, write: true, append, position: 0, path, lastRecord: null, lastAnswer: null });
        inode.descs++;
        return { id, path };
      },
      descriptor: (handleId) => descs.get(handleId),
      descriptorsOf: (inode) => {
        if (inode.descs === 0)
          return [];
        return [...new Set(descs.values())].filter((desc) => desc.inode === inode);
      },
      cells: () => [...held],
      hold: (inode, cell) => setCell(inode, cell),
      dropCell: (inode) => {
        setCell(inode, void 0);
        fit(inode);
        release(inode);
      },
      planMove: (from, to, path) => {
        const plan = { from, to };
        const beneath = () => everyInode().filter((inode) => inode.cell?.detached === void 0 && within2(inode.key, from));
        pendingMoves.add(plan);
        let need = 0;
        for (const inode of beneath())
          need += Math.max(0, cost(inode) - inode.reserved);
        if (need > 0 && !host2.reserve(need)) {
          pendingMoves.delete(plan);
          throw fsError2("ENOSPC", "rename", path);
        }
        for (const inode of beneath())
          inode.reserved = Math.max(inode.reserved, cost(inode));
        const settle = (made2) => {
          if (!pendingMoves.has(plan))
            return;
          const files = beneath();
          pendingMoves.delete(plan);
          for (const inode of files) {
            if (made2)
              renamed(inode, to + inode.key.slice(from.length), to + inode.key.slice(from.length));
            else
              fit(inode);
          }
        };
        return { commit: () => settle(true), cancel: () => settle(false) };
      },
      unhold: (inode, entry) => {
        const cell = inode.cell;
        if (cell === void 0)
          return;
        setCell(inode, void 0);
        inode.row = { ...entry, size: cell.length };
        const bytes = cell.bytes.byteLength === cell.length && retained(cell.bytes) === cell.length ? cell.bytes : owned(cell.bytes, cell.length);
        inode.base = { bytes, size: cell.length, mode: entry.mode, uid: entry.uid, gid: entry.gid, atime: entry.atime, mtime: entry.mtime, ctime: entry.ctime };
        inode.state = inode.base;
        inode.heldAt = Infinity;
        touched.add(inode);
        fit(inode);
        activity();
      },
      answeredHeld: (root) => {
        for (const inode of loose)
          if (inode.heldAt === Infinity && (within2(inode.key, root) || within2(inode.origin, root)))
            inode.heldAt = barriers;
      },
      pending: (dev, ino) => {
        const inode = inodeAtNumber(dev, ino);
        return inode !== void 0 && (ownValue(inode, "cell") !== void 0 || inode.state !== null || inode.key !== inode.origin);
      },
      sessionOf: (handleId, access) => {
        const desc = descs.get(handleId);
        if (desc === void 0)
          return void 0;
        const own = desc.description;
        const description = own !== void 0 && (access !== "read" || sessions.get(own)?.read === true) ? own : anchorOf(desc.inode, access === "read");
        return description === void 0 ? void 0 : sessions.get(description)?.handle;
      },
      anchored: (description, handle, read) => {
        if (handle !== void 0)
          sessions.set(description, { handle, read });
      },
      kept: () => {
        let total = 0;
        const every = everyInode();
        for (let i = 0; i < every.length; i++)
          total += cost(every[i]);
        for (let i = 0; i < nameRecords.length; i++)
          total += nameRecords[i].cost;
        return total;
      },
      owns: (handleId) => descs.size > 0 && descs.has(handleId),
      touches: (key) => {
        if (layer.size === 0 && touched.size === 0)
          return false;
        if (layer.has(key) || layer.has(parentKey3(key)))
          return true;
        let above = false;
        layer.forEach((_inode, name) => {
          if (!above && within2(name, key))
            above = true;
        });
        if (above)
          return true;
        const row = host2.row(key);
        return row ? inodeAtNumber(row.dev, row.ino)?.state != null : false;
      },
      setStatus: (handleId, status) => {
        const desc = descOf(handleId);
        if (status.append !== void 0)
          desc.append = status.append;
      },
      entry: provisionalEntry,
      children: (key, base) => {
        if (layer.size === 0)
          return base;
        const dir = layer.get(key);
        const origin = dir === void 0 ? viewNameBeneathMoved(key) : dir === null || dir.local || dir.origin === key ? void 0 : dir.origin;
        const viewed2 = origin === void 0 ? base : host2.children(origin);
        const made2 = added.get(key);
        const gone = removed2.get(key);
        if (made2 === void 0 && gone === void 0)
          return viewed2;
        const listed = dir && dir.local ? [] : viewed2;
        if (listed === void 0)
          return void 0;
        const out = new SafeMap();
        for (let i = 0; i < listed.length; i++) {
          const child = listed[i];
          if (gone === void 0 || !gone.has(child.name))
            out.set(child.name, child.type);
        }
        if (made2 !== void 0)
          made2.forEach((type, name) => {
            out.set(name, type);
          });
        const children = new SafeList();
        out.forEach((type, name) => {
          children[children.length] = { name, type };
        });
        return arrayCopy(children);
      },
      open: (key, path, flags, row, awaited = false) => {
        if (row !== null && flags.create && flags.exclusive)
          throw fsError2("EEXIST", "open", path);
        const write = flags.write === true || flags.append === true;
        if (write || flags.truncate || row === null && flags.create) {
          const handle = openToWrite(key, path, flags, row, null, false, void 0, awaited);
          if (handle === WHOLE_WRITTEN)
            throw new Error("internal: an open with nothing to write was written whole");
          if (handle !== void 0)
            descOf(handle.id).write = write;
          return handle;
        }
        if (row === null)
          throw fsError2("ENOENT", "open", path);
        if (awaited)
          return void 0;
        if (row.type === "directory" || row.type !== "file")
          return void 0;
        if (!modeAllows(row, 4, host2.cred))
          throw fsError2("EACCES", "open", path);
        const inode = inodeAt(key, row);
        try {
          admitOps(inode, [], "open", path);
        } catch (error) {
          release(inode);
          throw error;
        }
        return descriptor(inode, path, flags, void 0);
      },
      writeFile: (key, path, bytes, row, umask) => openToWrite(key, path, { write: true, create: true, truncate: true, mode: 438, ...umask === void 0 ? {} : { umask } }, row, bytes, true) !== void 0,
      read: (handleId, offset, length) => {
        const desc = descOf(handleId);
        if (!desc.read)
          throw fsError2("EBADF", "read", desc.path);
        const held2 = bytesOf(desc.inode, "read", desc.path);
        if (held2 === void 0)
          return void 0;
        const start = Math.min(offset ?? desc.position, held2.size);
        const chunk = owned(held2.bytes.subarray(start, Math.min(held2.size, start + length)));
        if (offset === null)
          desc.position = start + chunk.byteLength;
        return chunk;
      },
      write: (handleId, offset, bytes, awaited = false) => {
        const desc = descOf(handleId);
        if (!desc.write)
          throw fsError2("EBADF", "write", desc.path);
        if (bytes.byteLength === 0)
          return 0;
        const at = host2.now();
        const start = desc.append ? void 0 : offset ?? desc.position;
        if (!awaited && continued(desc, start, bytes, at)) {
          desc.position = start === void 0 ? desc.inode.state.size : offset === null ? start + bytes.byteLength : desc.position;
          return bytes.byteLength;
        }
        const data = owned(bytes);
        let answer;
        if (desc.append) {
          answer = contentOp(desc, { kind: "append", data, at }, { type: "call", call: { call: "append", path: desc.inode.key, ...by(desc), data } }, data.byteLength, "write", awaited);
          desc.position = desc.inode.state.size;
        } else {
          const start2 = offset ?? desc.position;
          answer = contentOp(desc, { kind: "write", offset: start2, data, at }, { type: "call", call: { call: "write", path: desc.inode.key, ...by(desc), offset: start2, data } }, data.byteLength, "write", awaited);
          if (offset === null)
            desc.position = start2 + data.byteLength;
        }
        return answer === void 0 ? bytes.byteLength : answer.then(() => bytes.byteLength);
      },
      ftruncate: (handleId, size, awaited = false) => {
        const desc = descOf(handleId);
        if (!desc.write)
          throw fsError2("EINVAL", "ftruncate", desc.path);
        const answer = contentOp(desc, { kind: "truncate", size, at: host2.now() }, { type: "call", call: { call: "ftruncate", path: desc.inode.key, ...by(desc), size } }, 0, "ftruncate", awaited);
        return answer === void 0 ? void 0 : answer.then(() => void 0);
      },
      seek: (handleId, offset, whence) => {
        const desc = descOf(handleId);
        if (whence === "end")
          named(desc.inode);
        const position = (whence === "set" ? 0 : whence === "current" ? desc.position : entryOf(desc.inode).size) + offset;
        if (position < 0)
          throw fsError2("EINVAL", "lseek", desc.path);
        desc.position = position;
        return position;
      },
      fstat: (handleId) => {
        const desc = descOf(handleId);
        if (unknown(desc.inode))
          return void 0;
        named(desc.inode);
        return entryOf(desc.inode);
      },
      admitted: (key, entry) => {
        if (table.size === 0)
          return;
        const inode = inodeAtNumber(entry.dev, entry.ino);
        if (inode === void 0 || inode.local || inode.cell?.detached !== void 0 || inode.origin === key && inode.row === entry)
          return;
        renamed(inode, inode.key === inode.origin ? key : inode.key, key, true);
        if (inode.lost)
          return;
        inode.unnamed = false;
        if (inode.state === null)
          inode.row = entry;
      },
      fsetattr: (handleId, change) => {
        const desc = descOf(handleId);
        const inode = desc.inode;
        const attrs = change;
        const syscall = "mode" in attrs ? "fchmod" : "uid" in attrs ? "fchown" : "futimes";
        const described = desc.description ?? anchorOf(inode);
        if (described === void 0 && !named(inode))
          throw fsError2("ESTALE", syscall, desc.path);
        judgeAttrs(entryOf(inode), attrs, syscall, desc.path);
        const op = attrOp(attrs, host2.now());
        host2.drain();
        admitOps(inode, [op], syscall, desc.path);
        host2.count(inode.key);
        loggedOn([fold(inode, op, described)], { type: "setattr", path: inode.key, attrs, ...described === void 0 ? expecting(entryOf(inode), inode.key) : { description: described } });
        fit(inode);
      },
      abandon: (handleId) => {
        delete descOf(handleId).description;
        provisional2.close(handleId);
      },
      close: (handleId) => {
        const desc = descOf(handleId);
        descs.delete(handleId);
        for (const other of descs.values())
          if (other === desc)
            return;
        const inode = desc.inode;
        inode.descs--;
        if (desc.description !== void 0) {
          if (inode.descs > 0 && inode.retained.length === 0 && anchorOf(inode) === void 0 || desc.description === inode.made)
            inode.retained = [...inode.retained, desc.description];
          else
            logged({ type: "call", call: { call: "close", path: inode.key, description: desc.description } }, () => {
            });
        }
        closeRetained(inode);
        if (desc.description !== void 0 && !inode.retained.includes(desc.description))
          sessions.delete(desc.description);
        if (inode.descs === 0 && inode.cell?.detached !== void 0)
          setCell(inode, void 0);
        release(inode);
      },
      dup: (handleId) => {
        const desc = descOf(handleId);
        const id = host2.nextHandle();
        descs.set(id, desc);
        return { id, path: desc.path };
      },
      reopen: (handleId, flags) => {
        const desc = descOf(handleId);
        const inode = desc.inode;
        if (flags.append)
          return void 0;
        if (flags.create && flags.exclusive)
          throw fsError2("EEXIST", "open", desc.path);
        if (inode.state === null && !named(inode))
          throw fsError2("ESTALE", "open", desc.path);
        const read = flags.read === true;
        const write = flags.write === true;
        if (!modeAllows(entryOf(inode), (read ? 4 : 0) | (write || flags.truncate ? 2 : 0), host2.cred))
          throw fsError2("EACCES", "open", desc.path);
        let description;
        if (write || flags.truncate) {
          if (!named(inode))
            throw fsError2("ESTALE", "open", desc.path);
          description = descriptionId();
          const open = { type: "call", call: { call: "open", path: inode.key, mode: entryOf(inode).mode & 4095, ...flags.truncate ? { truncate: true } : {}, access: read ? "readwrite" : "write", description, ...expecting(entryOf(inode), inode.key) } };
          const records = flags.truncate ? [{ kind: "truncate", size: 0, at: host2.now() }] : [];
          host2.drain();
          admitOps(inode, records, "open", desc.path);
          inode.answers++;
          const made2 = records.map((op) => fold(inode, op, description));
          logged(open, openAnswered(inode, description, made2, false, read));
          fit(inode);
        }
        const handle = descriptor(inode, desc.path, { ...flags, read }, description);
        descOf(handle.id).write = write;
        return { ...handle, position: 0, closed: false, flags: { read, write, append: false, create: !!flags.create, exclusive: !!flags.exclusive, directory: false, truncate: !!flags.truncate, followSymlinks: true } };
      },
      inodeOf: (handleId) => {
        const desc = descs.get(handleId);
        if (desc === void 0 || !named(desc.inode))
          return void 0;
        return { key: desc.inode.origin, entry: desc.inode.row };
      },
      keyOf: (handleId) => descOf(handleId).inode.key,
      mkdir: (key, path, mode, row, mask, awaited) => {
        if (row === void 0 || (mode & 3584) !== 0)
          return false;
        if (row !== null)
          throw fsError2("EEXIST", "mkdir", path);
        const parent = writableParent(key, path, "mkdir");
        if (parent === void 0)
          return false;
        const umask = mask ?? host2.umask();
        const perm = mode & 511 & ~umask | (ownership(parent).setgid ? 1024 : 0);
        host2.drain();
        admit(madeCost(key) + nameCost([key]), "mkdir", path);
        const inode = made(key, "directory", 16384 | perm, parent);
        return loggedName({ type: "call", call: { call: "mkdir", path: key, mode: mode & 511, umask } }, [key], nameCost([key]), () => {
          place(key, inode);
          added.set(key, added.get(key) ?? new SafeMap());
        }, void 0, void 0, awaited) ?? true;
      },
      unlink: (key, path, row, awaited) => {
        if (row === void 0)
          return false;
        if (row === null)
          throw fsError2("ENOENT", "unlink", path);
        if (row.type === "directory")
          return false;
        if (!removable(key, row, path, "unlink"))
          return false;
        host2.drain();
        keepForDescriptors(inodeAtNumber(row.dev, row.ino), nameCost([key]), "unlink", path);
        return loggedName({ type: "call", call: { call: "unlink", path: key, ...expecting(row, key) } }, [key], nameCost([key]), () => place(key, null), void 0, void 0, awaited) ?? true;
      },
      rmdir: (key, path, row, awaited) => {
        if (row === void 0)
          return false;
        if (row === null)
          throw fsError2("ENOENT", "rmdir", path);
        if (row.type !== "directory")
          throw fsError2("ENOTDIR", "rmdir", path);
        const listed = provisional2.children(key, host2.children(key));
        if (listed === void 0)
          return false;
        if (listed.length > 0)
          throw fsError2("ENOTEMPTY", "rmdir", path);
        if (!removable(key, row, path, "rmdir"))
          return false;
        host2.drain();
        admit(nameCost([key]), "rmdir", path);
        return loggedName({ type: "call", call: { call: "rmdir", path: key, ...expecting(row, key) } }, [key], nameCost([key]), () => {
          place(key, null);
          added.delete(key);
          removed2.delete(key);
        }, void 0, void 0, awaited) ?? true;
      },
      symlink: (key, path, target, row, awaited) => {
        if (row === void 0)
          return false;
        if (row !== null)
          throw fsError2("EEXIST", "symlink", path);
        const parent = writableParent(key, path, "symlink");
        if (parent === void 0)
          return false;
        host2.drain();
        admit(madeCost(key, target) + nameCost([key]), "symlink", path);
        const inode = made(key, "symlink", 41471, parent, target);
        return loggedName({ type: "call", call: { call: "symlink", path: key, target } }, [key], nameCost([key]), () => place(key, inode), void 0, void 0, awaited) ?? true;
      },
      rename: (from, to, path, source, target, awaited) => {
        if (source === void 0 || target === void 0)
          return false;
        if (source === null)
          throw fsError2("ENOENT", "rename", path);
        if (from === to)
          return true;
        if (source.type === "directory" && within2(to, from))
          throw fsError2("EINVAL", "rename", path);
        if (source.type === "directory" && target !== null && target.type === "directory") {
          const listed = provisional2.children(to, host2.children(to));
          if (listed !== void 0 && listed.length > 0)
            throw fsError2("ENOTEMPTY", "rename", path);
        }
        if (source.type === "directory" && target !== null)
          return false;
        if (target !== null && target.type === "directory")
          return false;
        if (!removable(from, source, path, "rename") || (target === null ? writableParent(to, path, "rename") === void 0 : !removable(to, target, path, "rename")))
          return false;
        host2.drain();
        const known = layer.get(from) ?? inodeAtNumber(source.dev, source.ino);
        const moves = known === void 0 ? INODE_COST + 2 * stringCost(from) + 2 * stringCost(to) : 2 * stringCost(to);
        const beneath = /* @__PURE__ */ new Map();
        for (const [key, value] of layer)
          if (value !== null && key !== from && within2(key, from))
            beneath.set(value, Math.max(0, stringCost(to + key.slice(from.length)) - stringCost(key)));
        let viewGrowth = 0;
        for (const inode of everyInode())
          if (within2(inode.origin, from))
            viewGrowth += Math.max(0, stringCost(to + inode.origin.slice(from.length)) - stringCost(inode.origin));
        const names = nameCost([from, to]) + viewGrowth;
        keepForDescriptors(target === null ? void 0 : inodeAtNumber(target.dev, target.ino), names + moves + [...beneath.values()].reduce((sum, grows) => sum + grows, 0), "rename", path);
        const moving = known ?? inodeAt(from, source);
        moving.reserved += moves;
        for (const [inode, grows] of beneath)
          inode.reserved += grows;
        const { expect: expectTo } = expecting(target, to);
        const answer = loggedName({ type: "rename", from, to, ...expecting(source, from), ...expectTo === void 0 ? {} : { expectTo } }, [from, to], names, () => {
          for (const [key, value] of [...layer]) {
            if (key === from || !within2(key, from))
              continue;
            layer.delete(key);
            const moved2 = to + key.slice(from.length);
            layer.set(moved2, value);
            if (value !== null)
              renamed(value, moved2, value.origin);
          }
          for (const map of [added, removed2]) {
            for (const [key, value] of [...map])
              if (within2(key, from)) {
                map.delete(key);
                map.set(to + key.slice(from.length), value);
              }
          }
          place(from, null);
          place(to, moving);
        }, void 0, () => {
          for (const inode of everyInode()) {
            if (within2(inode.origin, from))
              renamed(inode, inode.key, to + inode.origin.slice(from.length));
          }
        }, awaited);
        fit(moving);
        for (const inode of beneath.keys())
          fit(inode);
        return answer ?? true;
      },
      setattr: (key, path, attrs, row, awaited, link = false) => {
        if (row === void 0)
          return false;
        const own = link && row !== null && row.type === "symlink";
        if (own && ("mode" in attrs || "atime" in attrs && (typeof attrs.atime !== "number" || typeof attrs.mtime !== "number")))
          return false;
        const syscall = "mode" in attrs ? "chmod" : "uid" in attrs ? link ? "lchown" : "chown" : link ? "lutime" : "utime";
        if (row === null)
          throw fsError2("ENOENT", syscall, path);
        judgeAttrs(row, attrs, syscall, path);
        host2.drain();
        const inode = layer.get(key) ?? inodeAt(key, row);
        const op = attrOp(attrs, host2.now());
        try {
          admitOps(inode, [op], syscall, path);
        } catch (error) {
          release(inode);
          throw error;
        }
        host2.count(key);
        const logged2 = !own ? { type: "setattr", path: key, attrs, ...expecting(row, key) } : "uid" in attrs ? { type: "call", call: { call: "lchown", path: key, uid: attrs.uid, gid: attrs.gid } } : { type: "call", call: { call: "lutimes", path: key, atime: attrs.atime, mtime: attrs.mtime } };
        const answer = loggedOn([fold(inode, op)], logged2, awaited);
        fit(inode);
        return answer ?? true;
      },
      copyFile: (from, to, path, source, target, keepMode) => {
        if (source.type !== "file" || (source.mode & 3584) !== 0 || !modeAllows(source, 4, host2.cred))
          return false;
        if (target !== null && target.type !== "file")
          return false;
        const own = inodeAtNumber(source.dev, source.ino);
        const held2 = own === void 0 ? void 0 : bytesOf(own, "copyfile", path);
        const stored = own === void 0 ? host2.content(from, source.revision) : void 0;
        const data = held2 !== void 0 ? held2.bytes.subarray(0, held2.size) : stored !== void 0 && stored.byteLength === source.size ? stored : void 0;
        if (data === void 0)
          return false;
        const umask = host2.umask();
        const asked = copiedPermissions(source.mode, false);
        const opened = target === null ? asked & ~umask : target.mode & 4095;
        const mode = keepMode ? copyfileMode(source.mode, data.byteLength, host2.cred.uid) : opened;
        return openToWrite(to, path, { write: true, create: true, truncate: true, mode: asked, umask }, target, data, true, keepMode ? mode : void 0) !== void 0;
      },
      content: (entry) => {
        if (table.size === 0)
          return void 0;
        const inode = inodeAtNumber(entry.dev, entry.ino);
        if (inode === void 0)
          return void 0;
        if (inode.state !== null)
          return inode.state.bytes === null ? void 0 : owned(inode.state.bytes, inode.state.size);
        if (inode.key === inode.origin)
          return void 0;
        const seen = viewed(inode);
        return seen?.bytes === void 0 ? void 0 : owned(seen.bytes, seen.row.size);
      },
      barrierBegun: () => ++barriers,
      retire: (begun) => {
        const unreported = ownValue(host2, "unreported");
        const kept = new SafeList();
        for (let i = 0, count = nameRecords.length; i < count; i++) {
          const record = nameRecords[i];
          let stays = !record.answered || record.answeredAt >= begun;
          for (let j = 0; !stays && j < record.keys.length; j++)
            stays = unreported?.(record.keys[j]) === true;
          if (stays) {
            kept[kept.length] = record;
            continue;
          }
          for (let j = 0; j < record.keys.length; j++)
            host2.settled(record.keys[j], record.over[j]);
          host2.release(record.cost);
          const retired = ownValue(record, "retired");
          if (retired !== void 0)
            reflectApply(retired, record, []);
        }
        if (kept.length < nameRecords.length) {
          for (let i = 0; i < kept.length; i++)
            nameRecords[i] = kept[i];
          nameRecords.length = kept.length;
          replay();
        }
        const keeping = new SafeList();
        const visiting = setList(loose);
        for (let v = 0; v < visiting.length; v++) {
          const inode = visiting[v];
          if (unreported?.(inode.key) === true)
            continue;
          const heldAt = ownValue(inode, "heldAt");
          if (heldAt !== void 0) {
            if (heldAt >= begun)
              continue;
            reflectDeleteProperty(inode, "heldAt");
          }
          let retired = NO_RECORDS;
          if (inode.records.length > 0) {
            const answered = new SafeList();
            for (let i = 0; i < inode.records.length; i++)
              if (inode.records[i].answered && inode.records[i].answeredAt < begun)
                answered[answered.length] = inode.records[i];
            retired = answered;
          }
          if (retired.length === 0 && inode.records.length > 0)
            continue;
          if (inode.records.length === 0 && inode.descs === 0 && inode.answers === 0) {
            inode.base = null;
            inode.state = null;
            touched.delete(inode);
            fit(inode);
            release(inode);
            if (inodeAtNumber(inode.dev, inode.ino) !== inode)
              continue;
          }
          let rewritten = false;
          for (let i = 0; !rewritten && i < retired.length; i++)
            rewritten = retired[i].op.kind === "write" || retired[i].op.kind === "append" || retired[i].op.kind === "truncate";
          let seen = viewed(inode);
          const over = ownValue(inode, "over");
          if (retired.length > 0 && over !== void 0) {
            if (host2.settled(over.key, over.generation))
              seen = viewed(inode);
            reflectDeleteProperty(inode, "over");
          }
          if (seen === void 0) {
            let carries = false;
            for (let i = 0; !carries && i < retired.length; i++)
              carries = payloadOf(retired[i].op) > 0;
            if (inode.descs > 0 && inode.base !== null && inode.base.bytes === null && carries)
              continue;
            dropRecords(inode, setOfList(retired));
            unshared(inode);
            if (inode.base !== null)
              for (let i = 0; i < retired.length; i++)
                inode.base = applyOp(inode.base, retired[i].op);
            if (inode.records.length === 0 && inode.descs === 0) {
              inode.base = null;
              inode.state = null;
            }
          } else if (inode.records.length === retired.length) {
            const last = retired[retired.length - 1];
            if (rewritten && inode.state?.bytes && ownValue(last, "after") !== void 0 && seen.row.type === "file" && seen.row.revision === ownValue(last, "after") && seen.row.size === inode.state.size && inode.state.bytes.length >= inode.state.size) {
              keeping[keeping.length] = { key: seen.name, row: seen.row, bytes: bytesView(inode.state.bytes, 0, inode.state.size) };
            }
            dropRecords(inode, setOfList(retired));
            inode.row = (retired.length > 0 ? host2.absorb(seen.name, entryOf(inode)) : void 0) ?? seen.row;
            if (inode.descs > 0 && inode.state?.bytes)
              setOwnValue(inode, "pin", { revision: null, bytes: bytesView(inode.state.bytes, 0, inode.state.size) });
            else if (rewritten)
              reflectDeleteProperty(inode, "pin");
            inode.base = null;
            inode.state = null;
          } else {
            if (rewritten)
              reflectDeleteProperty(inode, "pin");
            dropRecords(inode, setOfList(retired));
            let folded2 = inode.base;
            for (let i = 0; folded2 !== null && i < retired.length; i++)
              folded2 = applyOp(folded2, retired[i].op);
            const decision = folded2 === null ? void 0 : host2.absorb(seen.name, { ...seen.row, size: folded2.size, mode: folded2.mode, uid: folded2.uid, gid: folded2.gid, atime: folded2.atime, mtime: folded2.mtime, ctime: folded2.ctime });
            if (decision === void 0) {
              inode.base = baseline(inode);
            } else {
              inode.row = decision;
              inode.base = folded2;
            }
          }
          if (inode.state === null) {
            touched.delete(inode);
          } else {
            refold(inode);
          }
          fit(inode);
          release(inode);
        }
        const keep = ownValue(host2, "keep");
        for (let i = 0; i < keeping.length; i++)
          keep?.(keeping[i].key, keeping[i].row, keeping[i].bytes);
        activity();
      }
    };
    return provisional2;
  }

  // ../platform/dist/realm-builtin.js
  function realmBuiltin(id) {
    try {
      const global = globalThis;
      const current = global.process;
      const own = current && global[/* @__PURE__ */ Symbol.for("nimbus.fronts")]?.get(current)?.own;
      return (own ?? current)?.getBuiltinModule?.(id);
    } catch {
      return void 0;
    }
  }

  // ../platform/dist/crc32.js
  var CRC_NATIVE_MIN_BYTES = 128;
  var nativeCrc32 = (() => {
    const crc322 = realmBuiltin("node:zlib")?.crc32;
    return typeof crc322 === "function" ? crc322 : null;
  })();
  var crcTables = null;
  function createCrcTables() {
    const table = new Uint32Array(256 * 8);
    for (let index = 0; index < 256; index++) {
      let value = index;
      for (let bit = 0; bit < 8; bit++)
        value = (value & 1) !== 0 ? 3988292384 ^ value >>> 1 : value >>> 1;
      table[index] = value;
    }
    for (let index = 0; index < 256; index++) {
      let value = table[index];
      for (let k = 1; k < 8; k++) {
        value = table[value & 255] ^ value >>> 8;
        table[k * 256 + index] = value;
      }
    }
    return table;
  }
  function crc32(bytes, previous = 0) {
    if (nativeCrc32 !== null && bytes.length >= CRC_NATIVE_MIN_BYTES)
      return nativeCrc32(bytes, previous) >>> 0;
    const t = crcTables ??= createCrcTables();
    let value = ~previous;
    const length = bytes.length;
    const whole = length - (length & 7);
    let i = 0;
    for (; i < whole; i += 8) {
      const low = value ^ (bytes[i] | bytes[i + 1] << 8 | bytes[i + 2] << 16 | bytes[i + 3] << 24);
      const high = bytes[i + 4] | bytes[i + 5] << 8 | bytes[i + 6] << 16 | bytes[i + 7] << 24;
      value = t[1792 + (low & 255)] ^ t[1536 + (low >>> 8 & 255)] ^ t[1280 + (low >>> 16 & 255)] ^ t[1024 + (low >>> 24)] ^ t[768 + (high & 255)] ^ t[512 + (high >>> 8 & 255)] ^ t[256 + (high >>> 16 & 255)] ^ t[high >>> 24];
    }
    for (; i < length; i++)
      value = t[(value ^ bytes[i]) & 255] ^ value >>> 8;
    return ~value >>> 0;
  }

  // ../platform/dist/w7-frame.js
  function isOpenAccess(value) {
    return value === "read" || value === "write" || value === "readwrite";
  }
  var W7_MAGIC = new Uint8Array([78, 87, 55, 4]);
  var W7_MAGIC_V3 = new Uint8Array([78, 87, 55, 3]);
  var ENCODER_PULL_BYTES = 256 * 1024;
  var READ_AHEAD_BYTES = 64 * 1024;
  var MAX_METADATA_BYTES = 64 * 1024;
  var MAX_PATH_BYTES = 64 * 1024;
  var MAX_CONTENT_ID_BYTES = 256;
  var W7_MAX_PATHS_PER_BATCH = 1024;
  var W7_MAX_OWNED_PATH_BYTES = 256 * 1024;
  var W7_MAX_RECORD_BYTES = 5 + 4 + MAX_CONTENT_ID_BYTES + 8 + CHUNK_SIZE;
  function w7ChunkCount(size) {
    return size === 0 ? 0 : Math.ceil(size / CHUNK_SIZE);
  }
  function w7Chunks(path, data) {
    const chunks = [];
    for (let chunkId = 0, count = w7ChunkCount(data.byteLength); chunkId < count; chunkId++) {
      chunks.push({ path, chunkId, data: data.subarray(chunkId * CHUNK_SIZE, (chunkId + 1) * CHUNK_SIZE) });
    }
    return chunks;
  }
  var RecordTag;
  (function(RecordTag2) {
    RecordTag2[RecordTag2["BatchBegin"] = 1] = "BatchBegin";
    RecordTag2[RecordTag2["Delete"] = 2] = "Delete";
    RecordTag2[RecordTag2["Directory"] = 3] = "Directory";
    RecordTag2[RecordTag2["FileBegin"] = 4] = "FileBegin";
    RecordTag2[RecordTag2["FileChunk"] = 5] = "FileChunk";
    RecordTag2[RecordTag2["FileEnd"] = 6] = "FileEnd";
    RecordTag2[RecordTag2["BatchEnd"] = 7] = "BatchEnd";
    RecordTag2[RecordTag2["Rename"] = 8] = "Rename";
    RecordTag2[RecordTag2["Truncate"] = 9] = "Truncate";
    RecordTag2[RecordTag2["SetAttr"] = 10] = "SetAttr";
    RecordTag2[RecordTag2["Call"] = 11] = "Call";
  })(RecordTag || (RecordTag = {}));
  var MODE = "program-order-committed-prefix";
  async function encodeWriteBatch(payload) {
    if ((payload.streams?.length ?? 0) > 0)
      throw new Error("w7-frame: a payload with streamed sources is never encoded whole");
    const batchId = crypto.randomUUID();
    const parts = [W7_MAGIC];
    let length = W7_MAGIC.byteLength;
    for await (const record of encodeRecords(batchId, preparePayload(payload, batchId))) {
      for (const part of record) {
        parts.push(part);
        length += part.byteLength;
      }
    }
    const out = new Uint8Array(length);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.byteLength;
    }
    return out;
  }
  async function* encodeRecords(batchId, ops) {
    const state = {
      batchCheck: 0,
      summary: {
        recordCount: 0,
        pathCount: 0,
        deleteCount: 0,
        directoryCount: 0,
        fileCount: 0,
        chunkCount: 0,
        byteCount: 0,
        opCount: 0
      }
    };
    yield encodeMetadataRecord(RecordTag.BatchBegin, { id: batchId, mode: MODE }, state);
    for (const op of ops) {
      switch (op.kind) {
        case "delete":
          state.summary.pathCount++;
          state.summary.deleteCount++;
          yield encodeMetadataRecord(RecordTag.Delete, { path: op.path }, state);
          break;
        case "directory":
          state.summary.pathCount++;
          state.summary.directoryCount++;
          yield encodeMetadataRecord(RecordTag.Directory, { ...inodeMetadata(op.inode), kind: op.inode.kind }, state);
          break;
        case "file":
          yield* encodeFile(op.file, state);
          break;
        case "rename":
          state.summary.pathCount++;
          state.summary.opCount++;
          yield encodeMetadataRecord(RecordTag.Rename, { from: op.from, to: op.to, ...expectations(op, "rename") }, state);
          break;
        case "truncate":
          state.summary.pathCount++;
          state.summary.opCount++;
          yield encodeMetadataRecord(RecordTag.Truncate, { path: op.path, size: op.size }, state);
          break;
        case "setattr":
          state.summary.pathCount++;
          state.summary.opCount++;
          yield encodeMetadataRecord(RecordTag.SetAttr, { path: op.path, ...op.attrs, ...op.description === void 0 ? {} : { description: op.description }, ...expectations(op, "setattr") }, state);
          break;
        case "call":
          state.summary.pathCount++;
          state.summary.opCount++;
          yield encodeMetadataRecord(RecordTag.Call, { ...op.call }, state);
          break;
      }
    }
    const end = {
      ...state.summary,
      check: state.batchCheck
    };
    yield encodeMetadataRecord(RecordTag.BatchEnd, end);
  }
  async function* encodeFile(file, state) {
    state.summary.pathCount++;
    state.summary.fileCount++;
    yield encodeMetadataRecord(RecordTag.FileBegin, {
      ...inodeMetadata(file.inode),
      kind: file.inode.kind,
      contentId: file.contentId,
      size: file.inode.size,
      chunkCount: file.inode.chunkCount,
      ...file.inode.call === void 0 ? {} : { call: file.inode.call },
      ...file.inode.offset === void 0 ? {} : { offset: file.inode.offset },
      ...file.inode.umask === void 0 ? {} : { umask: file.inode.umask },
      ...file.inode.description === void 0 ? {} : { description: file.inode.description }
    }, state);
    let fileCheck = 0;
    let chunkId = 0;
    const pieces2 = file.source === null ? givenChunks(file.chunks) : fixedChunks(file.inode, file.source);
    const contentBytes = TEXT_ENCODER.encode(file.contentId);
    for await (const data of pieces2) {
      const prefix = new Uint8Array(4 + contentBytes.length + 8);
      writeU32LE(prefix, 0, contentBytes.length);
      prefix.set(contentBytes, 4);
      writeU32LE(prefix, 4 + contentBytes.length, chunkId++);
      writeU32LE(prefix, 8 + contentBytes.length, data.byteLength);
      const header = recordHeader(RecordTag.FileChunk, prefix.byteLength + data.byteLength);
      state.batchCheck = updateRecordCheck(state.batchCheck, header, prefix, data);
      state.summary.recordCount++;
      state.summary.chunkCount++;
      state.summary.byteCount += data.byteLength;
      fileCheck = crc32(data, fileCheck);
      yield [concatBytes(header, prefix), data];
    }
    yield encodeMetadataRecord(RecordTag.FileEnd, {
      contentId: file.contentId,
      size: file.inode.size,
      chunkCount: file.inode.chunkCount,
      check: fileCheck
    }, state);
  }
  function* givenChunks(chunks) {
    for (const chunk of chunks)
      yield chunk.data;
  }
  async function* fixedChunks(inode, source) {
    let pending2 = new Uint8Array(Math.min(CHUNK_SIZE, inode.size));
    let filled = 0;
    let total = 0;
    for await (const part of source) {
      if (!(part instanceof Uint8Array))
        throw new Error(`w7-frame: ${inode.path}: streamed piece is not bytes`);
      if (total + part.byteLength > inode.size) {
        throw new Error(`w7-frame: ${inode.path}: streamed source exceeds its ${inode.size} bytes`);
      }
      total += part.byteLength;
      for (let offset = 0; offset < part.byteLength; ) {
        const take = Math.min(pending2.byteLength - filled, part.byteLength - offset);
        pending2.set(part.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === pending2.byteLength) {
          yield pending2;
          pending2 = new Uint8Array(Math.min(CHUNK_SIZE, inode.size - total + (part.byteLength - offset)));
          filled = 0;
        }
      }
    }
    if (total !== inode.size) {
      throw new Error(`w7-frame: ${inode.path}: streamed source ended at ${total} of ${inode.size} bytes`);
    }
  }
  function encodeMetadataRecord(tag, value, state) {
    const payload = TEXT_ENCODER.encode(JSON.stringify(value));
    if (payload.byteLength > MAX_METADATA_BYTES) {
      throw new Error(`w7-frame: metadata record exceeds ${MAX_METADATA_BYTES} bytes`);
    }
    const record = new Uint8Array(5 + payload.byteLength);
    record[0] = tag;
    writeU32LE(record, 1, payload.byteLength);
    record.set(payload, 5);
    if (state && tag !== RecordTag.BatchEnd) {
      state.batchCheck = updateRecordCheck(state.batchCheck, record);
      state.summary.recordCount++;
    }
    return [record];
  }
  function preparePayload(payload, batchId) {
    if (!payload || !Array.isArray(payload.inodes) || !Array.isArray(payload.chunks)) {
      throw new Error("w7-frame: payload must contain inode and chunk arrays");
    }
    if (payload.ops !== void 0)
      return prepareOps(payload, batchId);
    const ownedPaths = new PathOwnership(false);
    const deletes = [...payload.deletePaths ?? []];
    for (const path of deletes)
      ownedPaths.claim(canonicalPath(path, "delete path"));
    const streamsByPath = /* @__PURE__ */ new Map();
    for (const stream of payload.streams ?? []) {
      const path = canonicalPath(stream.path, "stream path");
      if (streamsByPath.has(path))
        throw new Error(`w7-frame: duplicate stream for ${path}`);
      streamsByPath.set(path, stream.source);
    }
    const chunksByPath = /* @__PURE__ */ new Map();
    for (const chunk of payload.chunks) {
      const path = canonicalPath(chunk.path, "chunk path");
      const list = chunksByPath.get(path);
      if (list)
        list.push(chunk);
      else
        chunksByPath.set(path, [chunk]);
    }
    const directories = [];
    const files = [];
    let fileIndex = 0;
    for (const inode of payload.inodes) {
      const path = canonicalPath(inode.path, "inode path");
      if (path !== inode.path)
        throw new Error(`w7-frame: noncanonical inode path ${inode.path}`);
      ownedPaths.claim(path);
      const normalizedInode = normalizeInode(inode);
      const fileChunks = chunksByPath.get(path) ?? [];
      const streamed = streamsByPath.get(path) ?? null;
      if (normalizedInode.kind === "directory") {
        if (fileChunks.length > 0 || streamed !== null)
          throw new Error(`w7-frame: directory ${path} has chunks`);
        directories.push({ kind: "directory", inode: normalizedInode });
      } else {
        if (streamed === null)
          validateChunks(normalizedInode, fileChunks);
        else if (fileChunks.length > 0)
          throw new Error(`w7-frame: streamed file ${path} also has chunks`);
        files.push({
          kind: "file",
          file: { inode: normalizedInode, contentId: `${batchId}:${fileIndex++}`, chunks: fileChunks, source: streamed }
        });
      }
      chunksByPath.delete(path);
      streamsByPath.delete(path);
    }
    if (chunksByPath.size > 0) {
      throw new Error(`w7-frame: chunk has no inode: ${chunksByPath.keys().next().value}`);
    }
    if (streamsByPath.size > 0) {
      throw new Error(`w7-frame: stream has no inode: ${streamsByPath.keys().next().value}`);
    }
    return [...deletes.map((path) => ({ kind: "delete", path })), ...directories, ...files];
  }
  function prepareOps(payload, batchId) {
    if (payload.inodes.length > 0 || payload.chunks.length > 0 || (payload.deletePaths?.length ?? 0) > 0 || (payload.streams?.length ?? 0) > 0) {
      throw new Error("w7-frame: a payload of ops carries nothing else");
    }
    const ownedPaths = new PathOwnership(true);
    let fileIndex = 0;
    return payload.ops.map((op) => {
      switch (op.type) {
        case "delete":
          return { kind: "delete", path: ownedPaths.claim(canonicalPath(op.path, "delete path")) };
        case "directory": {
          const inode = normalizeInode({ ...op.inode, path: ownedPaths.claim(canonicalPath(op.inode.path, "inode path")) });
          if (inode.kind !== "directory")
            throw new Error(`w7-frame: directory op ${inode.path} is a ${inode.kind}`);
          return { kind: "directory", inode };
        }
        case "file": {
          const inode = normalizeInode({ ...op.inode, path: ownedPaths.claim(canonicalPath(op.inode.path, "inode path")) });
          if (inode.kind === "directory")
            throw new Error(`w7-frame: file op ${inode.path} is a directory`);
          const contentId = `${batchId}:${fileIndex++}`;
          if ("source" in op)
            return { kind: "file", file: { inode, contentId, chunks: [], source: op.source } };
          const chunks = w7Chunks(inode.path, op.data);
          validateChunks(inode, chunks);
          return { kind: "file", file: { inode, contentId, chunks, source: null } };
        }
        case "rename":
          return {
            kind: "rename",
            from: ownedPaths.claim(canonicalPath(op.from, "rename source")),
            to: ownedPaths.claim(canonicalPath(op.to, "rename target")),
            ...expectations(op, "rename")
          };
        case "truncate":
          return { kind: "truncate", path: ownedPaths.claim(canonicalPath(op.path, "truncate path")), size: safeInteger(op.size, "truncate size") };
        case "setattr":
          return {
            kind: "setattr",
            path: ownedPaths.claim(canonicalPath(op.path, "setattr path")),
            attrs: parseAttrs(op.attrs, "setattr"),
            ...op.description === void 0 ? {} : { description: descriptionId2(op.description, "setattr description") },
            ...expectations(op, "setattr")
          };
        case "call": {
          const call = op.call;
          if ("data" in call) {
            const path = ownedPaths.claim(canonicalPath(call.path, `${call.call} path`));
            const inode = normalizeInode({
              path,
              parentPath: parentPath(path),
              kind: "file",
              isDir: false,
              size: call.data.byteLength,
              mtime: 0,
              mode: "mode" in call ? u32(call.mode, `${call.call} mode`) : 0,
              chunkCount: w7ChunkCount(call.data.byteLength),
              ..."ino" in call && call.ino !== void 0 ? { ino: inodeNumber(call.ino, `${call.call} ino`) } : {}
            });
            inode.call = call.call;
            if (call.call === "write")
              inode.offset = safeInteger(call.offset, "write offset");
            if ("umask" in call && call.umask !== void 0)
              inode.umask = umaskOf(call.umask, `${call.call} umask`);
            if ("description" in call && call.description !== void 0)
              inode.description = descriptionId2(call.description, `${call.call} description`);
            const chunks = w7Chunks(path, call.data);
            return { kind: "file", file: { inode, contentId: `${batchId}:${fileIndex++}`, chunks, source: null } };
          }
          return { kind: "call", call: parsePathCall({ ...call }, (path, label) => ownedPaths.claim(canonicalPath(path, label))) };
        }
      }
    });
  }
  function parseAttrs(value, label) {
    const keys = Object.keys(value).sort().join(",");
    if (keys === "mode")
      return { mode: u32(value.mode, `${label} mode`) };
    if (keys === "gid,uid")
      return { uid: ownerId(value.uid, `${label} uid`), gid: ownerId(value.gid, `${label} gid`) };
    if (keys === "atime,mtime")
      return { atime: parseFsTime(value.atime, `w7-frame: ${label} atime`), mtime: parseFsTime(value.mtime, `w7-frame: ${label} mtime`) };
    throw new Error(`w7-frame: ${label} changes the mode, the owner or the times, one of them: got ${keys || "nothing"}`);
  }
  function parseFsTime(value, label) {
    if (value === "now" || value === "omit")
      return value;
    if (typeof value === "number" && Number.isFinite(value))
      return value;
    throw new Error(`${label} must be a time: milliseconds, 'now' or 'omit'`);
  }
  function parsePathCall(value, path) {
    const keys = Object.keys(value).sort().join(",");
    switch (value.call) {
      case "mkdir": {
        const optional = keys.replace(",existing", "").replace(",ino", "").replace(",umask", "");
        if (optional !== "call,mode,path")
          break;
        if (value.existing !== void 0 && value.existing !== "ok")
          throw new Error(`w7-frame: mkdir existing is 'ok' or absent, not ${String(value.existing)}`);
        return {
          call: "mkdir",
          path: path(value.path, "mkdir path"),
          mode: u32(value.mode, "mkdir mode"),
          ...value.ino === void 0 ? {} : { ino: inodeNumber(value.ino, "mkdir ino") },
          ...value.umask === void 0 ? {} : { umask: umaskOf(value.umask, "mkdir umask") },
          ...value.existing === void 0 ? {} : { existing: "ok" }
        };
      }
      case "unlink":
      case "rmdir":
        if (keys !== "call,path" && keys !== "call,expect,path")
          break;
        return { call: value.call, path: path(value.path, `${value.call} path`), ...expectations(value, value.call) };
      case "symlink":
        if (keys !== "call,path,target" && keys !== "call,ino,path,target")
          break;
        return {
          call: "symlink",
          path: path(value.path, "symlink path"),
          target: boundedString(value.target, "symlink target", MAX_PATH_BYTES),
          ...value.ino === void 0 ? {} : { ino: inodeNumber(value.ino, "symlink ino") }
        };
      case "copyFile":
        if (keys !== "call,from,path")
          break;
        return { call: "copyFile", path: path(value.path, "copyFile path"), from: path(value.from, "copyFile from") };
      case "ftruncate":
        if (keys.replace(",description", "").replace(",ino", "") !== "call,path,size")
          break;
        return {
          call: "ftruncate",
          path: path(value.path, "ftruncate path"),
          size: safeInteger(value.size, "ftruncate size"),
          ...value.ino === void 0 ? {} : { ino: inodeNumber(value.ino, "ftruncate ino") },
          ...value.description === void 0 ? {} : { description: descriptionId2(value.description, "ftruncate description") }
        };
      case "close":
        if (keys !== "call,description,path")
          break;
        return { call: "close", path: path(value.path, "close path"), description: descriptionId2(value.description, "close description") };
      case "rm": {
        if (keys.replace(",force", "").replace(",recursive", "") !== "call,path")
          break;
        for (const flag of ["recursive", "force"]) {
          if (value[flag] !== void 0 && value[flag] !== true)
            throw new Error(`w7-frame: rm ${flag} is true or absent`);
        }
        return {
          call: "rm",
          path: path(value.path, "rm path"),
          ...value.recursive === true ? { recursive: true } : {},
          ...value.force === true ? { force: true } : {}
        };
      }
      case "lchown":
        if (keys !== "call,gid,path,uid")
          break;
        return { call: "lchown", path: path(value.path, "lchown path"), uid: ownerId(value.uid, "lchown uid"), gid: ownerId(value.gid, "lchown gid") };
      case "open": {
        const flags = ["create", "exclusive", "nofollow", "truncate"];
        let required = keys;
        for (const flag of ["create", "description", "exclusive", "expect", "fchmod", "ino", "nofollow", "truncate", "umask"])
          required = required.replace(`,${flag}`, "");
        if (required !== "access,call,mode,path")
          break;
        for (const flag of flags) {
          if (value[flag] !== void 0 && value[flag] !== true)
            throw new Error(`w7-frame: open ${flag} is true or absent`);
        }
        const access = value.access;
        if (!isOpenAccess(access))
          throw new Error(`w7-frame: open access is 'read', 'write' or 'readwrite': got ${String(access)}`);
        return {
          call: "open",
          path: path(value.path, "open path"),
          mode: u32(value.mode, "open mode"),
          access,
          ...value.ino === void 0 ? {} : { ino: inodeNumber(value.ino, "open ino") },
          ...value.umask === void 0 ? {} : { umask: umaskOf(value.umask, "open umask") },
          ...value.create === true ? { create: true } : {},
          ...value.truncate === true ? { truncate: true } : {},
          ...value.exclusive === true ? { exclusive: true } : {},
          ...value.nofollow === true ? { nofollow: true } : {},
          ...value.description === void 0 ? {} : { description: descriptionId2(value.description, "open description") },
          ...value.fchmod === void 0 ? {} : { fchmod: u32(value.fchmod, "open fchmod") },
          ...expectations(value, "open")
        };
      }
      case "lutimes":
        if (keys !== "atime,call,mtime,path")
          break;
        return {
          call: "lutimes",
          path: path(value.path, "lutimes path"),
          atime: safeInteger(value.atime, "lutimes atime"),
          mtime: safeInteger(value.mtime, "lutimes mtime")
        };
      default:
        throw new Error(`w7-frame: unknown call ${String(value.call)}`);
    }
    throw new Error(`w7-frame: ${String(value.call)} takes other fields: got ${keys}`);
  }
  function descriptionId2(value, label) {
    const id = boundedString(value, label, 64);
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw new Error(`w7-frame: ${label} is not a description id`);
    return id;
  }
  function umaskOf(value, label) {
    const mask = u32(value, label);
    if (mask > 511)
      throw new Error(`w7-frame: ${label} must be at most 0o777`);
    return mask;
  }
  function inodeNumber(value, label) {
    const ino = safeInteger(value, label);
    if (ino < 2)
      throw new Error(`w7-frame: ${label} must be at least 2`);
    return ino;
  }
  function expectations(value, label) {
    const expected = (field, name) => {
      if (field === null)
        return null;
      if (isObject(field) && !Array.isArray(field)) {
        if (Object.keys(field).join(",") !== "made")
          throw new Error(`w7-frame: ${label} ${name} is a number, null or { made }`);
        return { made: descriptionId2(field.made, `${label} ${name} made`) };
      }
      return inodeNumber(field, `${label} ${name}`);
    };
    return {
      ...value.expect === void 0 ? {} : { expect: expected(value.expect, "expect") },
      ...value.expectTo === void 0 ? {} : { expectTo: expected(value.expectTo, "expectTo") }
    };
  }
  function normalizeInode(inode) {
    canonicalPath(inode.path, "inode path");
    if (inode.parentPath !== parentPath(inode.path)) {
      throw new Error(`w7-frame: ${inode.path}: noncanonical parent path ${inode.parentPath}`);
    }
    safeInteger(inode.size, `${inode.path} size`);
    u32(inode.chunkCount, `${inode.path} chunk count`);
    safeInteger(inode.mtime, `${inode.path} mtime`);
    if (inode.atime !== void 0)
      safeInteger(inode.atime, `${inode.path} atime`);
    if (inode.ino !== void 0)
      inodeNumber(inode.ino, `${inode.path} ino`);
    u32(inode.mode, `${inode.path} mode`);
    const rawKind = inode.kind ?? (inode.isDir ? "directory" : "file");
    if (rawKind !== "file" && rawKind !== "directory" && rawKind !== "symlink") {
      throw new Error(`w7-frame: unsupported inode kind ${String(rawKind)}`);
    }
    const kind = rawKind;
    if (kind === "directory" && !inode.isDir) {
      throw new Error(`w7-frame: directory inode ${inode.path} must be a directory`);
    }
    if (kind !== "directory" && inode.isDir) {
      throw new Error(`w7-frame: ${kind} inode ${inode.path} cannot be a directory`);
    }
    if (kind === "directory" && (inode.size !== 0 || inode.chunkCount !== 0)) {
      throw new Error(`w7-frame: directory ${inode.path} must have zero size and chunks`);
    }
    if (kind !== "directory") {
      const expected = w7ChunkCount(inode.size);
      if (inode.chunkCount !== expected) {
        throw new Error(`w7-frame: ${inode.path}: expected ${expected} chunks, got ${inode.chunkCount}`);
      }
      return { ...inode, kind, isDir: false };
    }
    return { ...inode, kind, isDir: true };
  }
  function validateChunks(inode, chunks) {
    if (chunks.length !== inode.chunkCount) {
      throw new Error(`w7-frame: ${inode.path}: expected ${inode.chunkCount} chunks, got ${chunks.length}`);
    }
    chunks.sort((left, right) => left.chunkId - right.chunkId);
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      if (chunk.chunkId !== index) {
        throw new Error(`w7-frame: ${inode.path}: expected chunk ${index}, got ${chunk.chunkId}`);
      }
      const expected = Math.min(CHUNK_SIZE, inode.size - index * CHUNK_SIZE);
      if (!(chunk.data instanceof Uint8Array) || chunk.data.byteLength !== expected) {
        throw new Error(`w7-frame: ${inode.path}: chunk ${index} must contain ${expected} bytes`);
      }
    }
  }
  function inodeMetadata(inode) {
    return {
      path: inode.path,
      ...inode.atime === void 0 ? {} : { atime: inode.atime },
      mtime: inode.mtime,
      mode: inode.mode,
      ...inode.ino === void 0 ? {} : { ino: inode.ino }
    };
  }
  function canonicalPath(value, label) {
    const path = boundedString(value, label, MAX_PATH_BYTES);
    if (path.includes("\0"))
      throw new Error(`w7-frame: ${label} contains NUL`);
    const normalized = normalizePath(path);
    if (!path || normalized !== path)
      throw new Error(`w7-frame: noncanonical ${label}: ${path}`);
    return path;
  }
  var PathOwnership = class {
    repeats;
    paths = /* @__PURE__ */ new Set();
    pathBytes = 0;
    constructor(repeats) {
      this.repeats = repeats;
    }
    claim(path) {
      if (this.paths.has(path)) {
        if (this.repeats)
          return path;
        throw new Error(`w7-frame: duplicate path ownership: ${path}`);
      }
      if (this.paths.size >= W7_MAX_PATHS_PER_BATCH) {
        throw new Error(`w7-frame: batch exceeds ${W7_MAX_PATHS_PER_BATCH} owned paths`);
      }
      const nextPathBytes = this.pathBytes + utf8Length(path);
      if (nextPathBytes > W7_MAX_OWNED_PATH_BYTES) {
        throw new Error(`w7-frame: owned path bytes exceed ${W7_MAX_OWNED_PATH_BYTES}`);
      }
      this.paths.add(path);
      this.pathBytes = nextPathBytes;
      return path;
    }
  };
  function normalizePath(path) {
    return rootClampedSegments(path).join("/");
  }
  function parentPath(path) {
    const index = path.lastIndexOf("/");
    return index < 0 ? "" : path.slice(0, index);
  }
  function boundedString(value, label, maxBytes) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`w7-frame: ${label} must be a non-empty string`);
    }
    if (utf8Length(value) > maxBytes)
      throw new Error(`w7-frame: ${label} exceeds ${maxBytes} bytes`);
    return value;
  }
  function safeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`w7-frame: ${label} must be a non-negative safe integer`);
    }
    return value;
  }
  function ownerId(value, label) {
    return value === null ? null : u32(value, label);
  }
  function u32(value, label) {
    const integer = safeInteger(value, label);
    if (integer > 4294967295)
      throw new Error(`w7-frame: ${label} exceeds uint32`);
    return integer;
  }
  function recordHeader(tag, length) {
    const header = new Uint8Array(5);
    header[0] = tag;
    writeU32LE(header, 1, length);
    return header;
  }
  function writeU32LE(out, offset, value) {
    out[offset] = value & 255;
    out[offset + 1] = value >>> 8 & 255;
    out[offset + 2] = value >>> 16 & 255;
    out[offset + 3] = value >>> 24 & 255;
  }
  function updateRecordCheck(seed, ...parts) {
    let check = seed;
    for (const part of parts)
      check = crc32(part, check);
    return check;
  }
  var UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  var TEXT_ENCODER = new TextEncoder();
  function concatBytes(...parts) {
    const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.byteLength;
    }
    return output;
  }
  function isObject(value) {
    return typeof value === "object" && value !== null;
  }

  // ../platform/dist/oom-classify.js
  function classifyMessage(msg) {
    const m = msg.toLowerCase();
    if (m.includes("sqlite_full"))
      return "sqlite_full";
    if (m.includes("database or disk is full"))
      return "sqlite_full";
    if (m.includes("sqlite_nomem"))
      return "sqlite_nomem";
    if (m.includes("out of memory"))
      return "sqlite_nomem";
    if (m.includes("deserialize cloned data"))
      return "clone_refused";
    if (m.includes("could not be cloned"))
      return "clone_refused";
    if (m.includes("timeouterror"))
      return "rpc_timeout";
    if (/\btimed?\s*out\b/.test(m))
      return "rpc_timeout";
    if (m.includes("too many subrequests"))
      return "subrequest_cap";
    if (m.includes("dynamic worker concurrency limit exceeded"))
      return "dynamic_worker_cap";
    if (m.includes("exceededmemory"))
      return "oom";
    if (/exceeded (?:its )?memory limit/.test(m))
      return "oom";
    if (m.includes("memory limit exceeded"))
      return "oom";
    if (m.includes("memory limit") && m.includes("reset"))
      return "oom";
    if (m.includes("cpu time limit"))
      return "cpu_exceeded";
    if (m.includes("exceeded cpu limit"))
      return "cpu_exceeded";
    if (m.includes("condemned"))
      return "condemnation";
    if (m.includes("hard evict"))
      return "hard_evict";
    return "unknown";
  }
  function isUnexplainedPlatformError(input) {
    return /^internal error; reference = \S+$/i.test(readMessage(input).trim());
  }
  function isDoOverloaded(input) {
    return readMessage(input).toLowerCase().includes("durable object is overloaded");
  }
  function isRetryableDoCall(input) {
    return input === "superseded_isolate" || input === "connection_lost" || input === "storage_reset" || input === "retryable_flag";
  }
  var DO_CALL_TRANSIENT = [
    ["superseded_isolate", /reset because its code was updated|this script has been upgraded/i],
    ["connection_lost", /network connection lost/i],
    ["storage_reset", /durable object storage caused object to be reset|storage operation exceeded timeout which caused the object to be reset/i]
  ];
  function classifyDoCall(input) {
    if (!(input instanceof Error))
      return "permanent";
    const seen = /* @__PURE__ */ new Set();
    const messages = [];
    let flagged = false;
    let unexplained = false;
    let link = input;
    while (link !== null && !seen.has(link)) {
      seen.add(link);
      const overloaded = "overloaded" in link && link.overloaded === true || isDoOverloaded(link.message);
      if (overloaded)
        return "overloaded";
      if ("retryable" in link && link.retryable === true)
        flagged = true;
      if (isUnexplainedPlatformError(link))
        unexplained = true;
      messages.push(link.message ?? "");
      const cause = link.cause;
      link = cause instanceof Error ? cause : null;
    }
    const chain = messages.join("; ");
    for (const [transient, pattern] of DO_CALL_TRANSIENT) {
      if (pattern.test(chain))
        return transient;
    }
    if (flagged)
      return "retryable_flag";
    if (unexplained)
      return "platform_internal";
    return "permanent";
  }
  function readMessage(input) {
    if (input == null)
      return "";
    if (typeof input === "string")
      return input;
    if (input instanceof Error)
      return input.message ?? "";
    if (typeof input === "object") {
      const m = input.message;
      if (typeof m === "string")
        return m;
    }
    try {
      return String(input);
    } catch {
      return "";
    }
  }

  // ../platform/dist/lost-call.js
  var LOST_STREAM_STALL_MS = 1e4;
  var LOST_STREAM_ANSWER_MS = 2e4;
  var WAVE_EPOCH_TTL_MS = 10 * 6e4;
  var LOST_CALL_RESEND_BACKOFF_MS = [250, 1e3, 3e3, 6e3, 12e3, 2e4];
  function isLostFencedCall(error) {
    const kind = classifyDoCall(error);
    return isRetryableDoCall(kind) || kind === "overloaded";
  }
  function lostCallAttributes(lost) {
    return {
      "do_call.operation": lost.operation,
      "do_call.attempts": lost.attempt,
      "do_call.max_attempts": lost.of,
      "do_call.lost_reason": lost.reason
    };
  }

  // ../platform/dist/retry.js
  function retryDelayMs(schedule, attempt) {
    const base = schedule[Math.min(attempt, schedule.length - 1)] ?? 0;
    return Math.max(0, Math.round(base + (Math.random() * 2 - 1) * base * 0.25));
  }

  // ../platform/dist/wave-writer.js
  var WAVE_PATHS = W7_MAX_PATHS_PER_BATCH - 8;
  var WAVE_PATH_BYTES = W7_MAX_OWNED_PATH_BYTES - 4 * 1024;
  var WAVE_BYTES = 4 * 1024 * 1024;
  var SEND_SLICE_BYTES = 1024 * 1024;
  var encoder5 = new TextEncoder();
  var GLOBAL_TIMERS = {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer)
  };
  async function sendWaveAttempts(options) {
    const { backoffMs, stallMs, answerDeadlineMs } = options.retry ?? { backoffMs: LOST_CALL_RESEND_BACKOFF_MS, stallMs: LOST_STREAM_STALL_MS, answerDeadlineMs: LOST_STREAM_ANSWER_MS };
    const timers = options.timers ?? GLOBAL_TIMERS;
    for (let attempt = 0; ; attempt++) {
      const writer = await options.writer();
      const attemptStream = abortable(options.open(), stallMs, answerDeadlineMs, timers);
      const fence = writer === null ? void 0 : { writer, wave: options.wave, attempt: attempt + 1, ...options.sequence };
      const answer = options.owner === void 0 ? options.supervisor.writeBatchStream(attemptStream.stream, fence) : options.supervisor.writeBatchStream(attemptStream.stream, fence, options.owner);
      try {
        return await Promise.race([answer, attemptStream.lost]);
      } catch (error) {
        const lost = error instanceof WaveLost || isLostFencedCall(error);
        if (lost && (options.streamed || attempt >= backoffMs.length))
          attemptStream.abort(error);
        if (!lost || options.streamed || attempt >= backoffMs.length)
          throw error;
        attemptStream.abort(error);
        answer.then(disposeRpcResource, () => {
        });
        options.resent?.(lostCallAttributes({
          operation: "writeBatchStream",
          attempt: attempt + 1,
          of: backoffMs.length,
          reason: error instanceof Error ? error.message : String(error)
        }));
        await new Promise((resolve) => {
          timers.setTimeout(resolve, retryDelayMs(backoffMs, attempt));
        });
      } finally {
        attemptStream.settle();
      }
    }
  }
  async function openWaveEpoch(open, options = {}) {
    const backoffMs = options.retry?.backoffMs ?? LOST_CALL_RESEND_BACKOFF_MS;
    const timers = options.timers ?? GLOBAL_TIMERS;
    for (let attempt = 0; ; attempt++) {
      try {
        return await open();
      } catch (error) {
        if (!isLostFencedCall(error) || attempt >= backoffMs.length)
          throw error;
        options.resent?.(lostCallAttributes({
          operation: "openWaveWriter",
          attempt: attempt + 1,
          of: backoffMs.length,
          reason: error instanceof Error ? error.message : String(error)
        }));
        await new Promise((resolve) => {
          timers.setTimeout(resolve, retryDelayMs(backoffMs, attempt));
        });
      }
    }
  }
  function waveAttemptsOf(bytes) {
    return piecesOf(bytes, SEND_SLICE_BYTES);
  }
  var WaveLost = class extends Error {
    constructor(message) {
      super(message);
      this.name = "WaveLost";
    }
  };
  function piecesOf(bytes, size) {
    return () => slices(bytes, size);
  }
  function slices(bytes, size) {
    let at = 0;
    return new ReadableStream({
      pull(controller) {
        if (at >= bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(bytes.byteLength, at + size);
        controller.enqueue(bytes.slice(at, end));
        at = end;
      }
    }, { highWaterMark: 0 });
  }
  function abortable(stream, stallMs, answerDeadlineMs, timers) {
    const reader = stream.getReader();
    let target = null;
    let timer = null;
    let declareLost = () => {
    };
    const lost = new Promise((_, reject) => {
      declareLost = reject;
    });
    lost.catch(() => {
    });
    const watch = (ms, message) => {
      if (timer !== null)
        timers.clearTimeout(timer);
      timer = timers.setTimeout(() => declareLost(new WaveLost(message)), ms);
    };
    const queued = () => Math.max(0, -(target?.desiredSize ?? 0));
    const watchReads = () => {
      if (timer !== null)
        timers.clearTimeout(timer);
      const unread = queued();
      timer = timers.setTimeout(() => {
        if (queued() < unread)
          watchReads();
        else
          declareLost(new WaveLost(`writeBatchStream stalled: nothing read it for ${stallMs} ms`));
      }, stallMs);
    };
    watchReads();
    let sourceDone = false;
    const source = {
      type: "bytes",
      start(controller) {
        target = controller;
      },
      async pull(controller) {
        const next = sourceDone ? null : await reader.read();
        if (next === null || next.done) {
          sourceDone = true;
          if (queued() > 0)
            return;
          watch(answerDeadlineMs, `writeBatchStream unanswered ${answerDeadlineMs} ms after its stream ended`);
          controller.close();
          controller.byobRequest?.respond(0);
          return;
        }
        controller.enqueue(next.value);
        watchReads();
      },
      cancel(reason) {
        return reader.cancel(reason);
      }
    };
    return {
      stream: new ReadableStream(source, { highWaterMark: 0 }),
      lost,
      abort(reason) {
        try {
          target?.error(reason);
        } catch {
        }
        reader.cancel(reason).catch(() => {
        });
      },
      settle() {
        if (timer !== null)
          timers.clearTimeout(timer);
        timer = null;
      }
    };
  }

  // ../core/dist/runtime/delegations.js
  var DELEGATION_RECALL_TIMEOUT_MS = 5e3;
  var sessionTimers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };

  // ../core/dist/_shared/process-fs-client.js
  var ORPHANED_ERRNOS = /* @__PURE__ */ new Set(["ENOENT", "EEXIST", "ELOOP", "ENOTDIR"]);
  var PROCESS_FS_SYNC_CAP_BYTES = 256 * 1024 * 1024;
  var PROCESS_FS_HEAP_SYNC_CAP_BYTES = 64 * 1024 * 1024;
  var PROCESS_FS_HEAP_WINDOW_BYTES = 2 * WAVE_BYTES;
  var DECIDED_BACKLOG_OPS = 2 * WAVE_PATHS;
  var DECIDED_BACKLOG_BYTES = 2 * WAVE_BYTES;
  var DATA_PIECE_BYTES = WAVE_BYTES;
  var FOLD_BUFFER = /* @__PURE__ */ Symbol("process-fs-fold-buffer");
  var MAX_DELEGATIONS_PER_PROCESS = 8;
  var GRANT_AFTER = 8;
  var LINGER_MS = 10;
  function withUmaskOf(op, umask) {
    if (umask === void 0 || op.type !== "call")
      return op;
    const call = op.call;
    if (call.call !== "writeFile" && call.call !== "appendFile" && call.call !== "mkdir" || call.umask !== void 0)
      return op;
    const mask = umask();
    return mask === void 0 ? op : { type: "call", call: { ...call, umask: mask & 511 } };
  }
  var SYMLINK_TARGET_MAX = 4096;
  var GRANT_IDLE_MS = 2e3;
  var GRANT_INOS = 4096;
  var GRANT_BYTES = 64 * 1024 * 1024;
  var RECALL_POLL_MS = 2e4;
  var recallWaitMs = (n) => Math.min(10 * 2 ** n, 1e3);
  var WAVE_RECALL_BOUND_MS = DELEGATION_RECALL_TIMEOUT_MS + 1e3;
  function standingOf(grant, key) {
    if (grant.ended || grant.closing || grant.shared)
      return void 0;
    return within3(key, grant.root) ? "held" : within3(grant.root, key) ? "above" : void 0;
  }
  function within3(key, root) {
    if (root === "" || key === root)
      return true;
    if (key.length <= root.length || key[root.length] !== "/")
      return false;
    for (let i = 0; i < root.length; i++)
      if (key[i] !== root[i])
        return false;
    return true;
  }
  function commonAncestor(left, right) {
    const a = left.split("/");
    const b = right.split("/");
    const out = [];
    for (let index = 0; index < Math.min(a.length, b.length) && a[index] === b[index]; index++)
      out.push(a[index]);
    return out.join("/");
  }
  var GLOBAL_TIMERS2 = {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer)
  };
  function pathsOf(op) {
    switch (op.type) {
      case "call":
        return op.call.call === "copyFile" ? [op.call.path, op.call.from] : [op.call.path];
      case "rename":
        return [op.from, op.to];
      case "truncate":
      case "setattr":
        return [op.path];
    }
  }
  function canonical(path) {
    return path !== "" && path.split("/").every((part) => part !== "" && part !== "." && part !== "..") && !path.includes("\0");
  }
  function nameOf3(op) {
    return op.type === "call" ? op.call.call : op.type;
  }
  function fsError3(errno2, message, path) {
    return Object.assign(new Error(message), { code: errno2, path });
  }
  function isProcessGone(error) {
    return "code" in error && error.code === "ESRCH";
  }
  function descriptionOf(call) {
    return "description" in call ? call.description : void 0;
  }
  function extended(call, data, buffer) {
    const size = call.data.byteLength + data.byteLength;
    if (buffer === null || buffer.byteLength < size) {
      buffer = new Uint8Array(Math.min(DATA_PIECE_BYTES, Math.max(size, (buffer?.byteLength ?? call.data.byteLength) * 2)));
      buffer.set(call.data);
    }
    buffer.set(data, call.data.byteLength);
    const joined = buffer.subarray(0, size);
    return { op: { type: "call", call: { ...call, data: joined } }, buffer, append: joined.subarray(call.data.byteLength) };
  }
  function foldOf(last, next) {
    if (last.type !== "call" || next.type !== "call" || !("data" in last.call) || !("data" in next.call))
      return null;
    const a = last.call;
    const b = next.call;
    if (a.path !== b.path || descriptionOf(a) !== descriptionOf(b) || a.data.byteLength + b.data.byteLength > DATA_PIECE_BYTES)
      return null;
    const inoOf = (call) => "ino" in call ? call.ino : void 0;
    if (b.call === "writeFile" && inoOf(b) === void 0 && (a.call === "writeFile" || a.call === "appendFile"))
      return "replaces";
    if (b.call === "appendFile" && inoOf(b) === void 0 && (a.call === "writeFile" || a.call === "appendFile"))
      return "extends";
    if (b.call === "append" && a.call === "append" && inoOf(a) === inoOf(b))
      return "extends";
    if (b.call === "write" && a.call === "write" && inoOf(a) === inoOf(b) && a.offset + a.data.byteLength === b.offset)
      return "extends";
    return null;
  }
  function folded(last, next, buffer) {
    const fold = foldOf(last, next);
    if (fold === null)
      return null;
    const a = last.call;
    const b = next.call;
    if (fold === "replaces")
      return { op: { type: "call", call: { ...a, call: "writeFile", data: b.data } }, buffer: null };
    return extended(a, b.data, buffer);
  }
  function pieces(op) {
    if (op.type !== "call" || !("data" in op.call) || op.call.data.byteLength <= DATA_PIECE_BYTES)
      return [op];
    const call = op.call;
    const data = call.data;
    const out = [{ type: "call", call: { ...call, data: data.subarray(0, DATA_PIECE_BYTES) } }];
    for (let at = DATA_PIECE_BYTES; at < data.byteLength; at += DATA_PIECE_BYTES) {
      const piece = data.subarray(at, Math.min(data.byteLength, at + DATA_PIECE_BYTES));
      const ino = "ino" in call ? call.ino : void 0;
      const description = descriptionOf(call);
      const by = description === void 0 ? {} : { description };
      out.push(call.call === "append" || call.call === "appendFile" ? { type: "call", call: { call: "append", path: call.path, ...ino === void 0 ? {} : { ino }, ...by, data: piece } } : { type: "call", call: { call: "write", path: call.path, ...ino === void 0 ? {} : { ino }, ...by, offset: (call.call === "write" ? call.offset : 0) + at, data: piece } });
    }
    return out;
  }
  function processFsClient(options) {
    const { session } = options;
    const timers = options.timers ?? GLOBAL_TIMERS2;
    const now = options.now ?? Date.now;
    const journal = options.journal ?? memoryJournal();
    const syncCap = options.syncCapBytes ?? (journal.durable ? PROCESS_FS_SYNC_CAP_BYTES : PROCESS_FS_HEAP_SYNC_CAP_BYTES);
    let heapBytes = 0;
    const queue = [];
    let inFlight = null;
    let scheduled = false;
    let pendingBytes = 0;
    let pendingSyncBytes = 0;
    let pendingSyncOps = 0;
    let epoch = null;
    let ack = 0;
    let wave = 0;
    let recalled = null;
    const retiring = [];
    const failures = [];
    let processGone = null;
    let logged = 0;
    let answered = 0;
    let heldWaves = 0;
    let publishedThrough = 0;
    let ownThrough = 0;
    let ownHeld = false;
    let escaped = null;
    let escapeLanded = false;
    const marks = [];
    const counters = {
      ops: 0,
      waves: 0,
      resends: 0,
      epochs: 0,
      refused: 0,
      lost: 0,
      maxWaveOps: 0,
      grants: 0,
      grantsRefused: 0,
      recalls: 0,
      released: 0,
      widened: 0,
      renewed: 0,
      folded: 0,
      readLeases: 0,
      readConfirms: 0,
      readRecalls: 0,
      readReleased: 0
    };
    const grantAfter = options.grantAfter ?? GRANT_AFTER;
    const grantIdleMs = options.grantIdleMs ?? GRANT_IDLE_MS;
    const recallPollMs = options.recallPollMs ?? RECALL_POLL_MS;
    const lingerMs = options.lingerMs ?? LINGER_MS;
    const grants = [];
    const mutations = /* @__PURE__ */ new Map();
    const refusedRoots = /* @__PURE__ */ new Set();
    const rangeOf = /* @__PURE__ */ new Map();
    let claiming = null;
    let paused = false;
    let sealed = false;
    let sending = null;
    let idleTimer = null;
    let lingerTimer = null;
    let settling = false;
    const settled = (entry) => {
      pendingBytes -= entry.bytes;
      if (entry.acknowledged) {
        pendingSyncBytes -= entry.bytes;
        pendingSyncOps--;
      }
      answered = Math.max(answered, entry.order);
      for (let at = marks.length - 1; at >= 0; at--) {
        if (marks[at].mark <= answered)
          marks.splice(at, 1)[0].resolve();
      }
    };
    const orphanedDescriptions = /* @__PURE__ */ new Set();
    const orphanedRefusal = (op, errno2) => {
      if (op === null || op.type !== "call" && op.type !== "rename" && op.type !== "setattr")
        return false;
      if (op.type === "call" && "description" in op.call && op.call.description !== void 0 && orphanedDescriptions.has(op.call.description))
        return true;
      const decided = op.type === "rename" ? op.expect !== void 0 || op.expectTo !== void 0 : op.type === "setattr" ? op.expect !== void 0 : "expect" in op.call && op.call.expect !== void 0 || op.call.call === "open" && op.call.nofollow === true;
      if (!decided || !ORPHANED_ERRNOS.has(errno2))
        return false;
      if (op.type === "call" && op.call.call === "open" && op.call.description !== void 0)
        orphanedDescriptions.add(op.call.description);
      return true;
    };
    const fail2 = (entry, errno2, message, refused = false, op = null) => {
      settled(entry);
      const path = entry.paths[0] ?? "";
      if (entry.acknowledged) {
        if (!(refused && orphanedRefusal(op, errno2)))
          failures.push({ op: entry.name, path, errno: errno2, message });
        entry.resolve({ failed: { errno: errno2, message, ...refused ? { refused: true } : {} } });
      } else {
        entry.reject(fsError3(errno2, message, path));
      }
    };
    const forget = (through, applied) => {
      if (applied || !(sealed || processGone !== null && journal.durable))
        journal.dropThrough(through);
    };
    const opOf2 = (entry) => entry.op ?? journal.read(entry.jid);
    const retirePending = async () => {
      while (retiring.length > 0) {
        try {
          await session.retireWriter?.(retiring[0]);
        } catch (error) {
          if (processGone === null || !(error instanceof Error) || !isProcessGone(error))
            throw error;
        }
        retiring.shift();
      }
    };
    const writerFor = async (entries) => {
      const numberedPending = entries.some((entry) => entry.seq !== 0) || queue.some((entry) => entry.seq !== 0);
      if (epoch !== null && (epoch.writer === null || numberedPending || now() - epoch.openedAt < WAVE_EPOCH_TTL_MS / 2))
        return epoch.writer;
      await retirePending();
      const openedAt = now();
      const first = counters.epochs === 0;
      const writer = await openWaveEpoch(() => session.openWriter(first), { ...options.retry === void 0 ? {} : { retry: options.retry }, timers });
      epoch = { writer, openedAt, numbering: null };
      counters.epochs++;
      ack = 0;
      wave = 0;
      return writer;
    };
    const numberEntries = (entries) => {
      const current = epoch;
      for (const entry of entries) {
        if (entry.seq !== 0)
          continue;
        if (current.numbering === null) {
          const numbering = { writer: current.writer, seq: 1, jid: entry.jid };
          journal.number(numbering);
          current.numbering = numbering;
        }
        entry.seq = current.numbering.seq + (entry.jid - current.numbering.jid);
      }
    };
    const cut = () => {
      const limit = marks.reduce((least, waiting) => Math.min(least, waiting.mark), Infinity);
      const taken = [];
      const owned2 = /* @__PURE__ */ new Set();
      let pathBytes = 0;
      let bytes = 0;
      while (queue.length > 0) {
        const next = queue[0];
        const fresh = next.paths.filter((path) => !owned2.has(path));
        const freshBytes = fresh.reduce((sum, path) => sum + utf8Length(path), 0);
        if (taken.length > 0 && (next.order > limit || owned2.size + fresh.length > WAVE_PATHS || pathBytes + freshBytes > WAVE_PATH_BYTES || bytes + next.bytes > WAVE_BYTES))
          break;
        for (const path of fresh)
          owned2.add(path);
        pathBytes += freshBytes;
        bytes += next.bytes;
        taken.push(queue.shift());
      }
      return taken;
    };
    const send = async (entries) => {
      let writer;
      try {
        if (escaped !== null)
          await escaped;
        writer = await writerFor(entries);
      } catch (error2) {
        if (error2 instanceof Error && classifyMessage(error2.message) === "subrequest_cap") {
          exhaustedInvocation(entries, error2);
          return;
        }
        if (error2 instanceof Error && isProcessGone(error2)) {
          endedProcess(entries, error2, epoch?.writer ?? null);
          return;
        }
        for (const entry of entries)
          fail2(entry, "EIO", `the session gave this process no writer: ${error2 instanceof Error ? error2.message : String(error2)}`, true);
        forget(entries[entries.length - 1].jid, false);
        return;
      }
      let ops;
      let bytes;
      try {
        ops = entries.map(opOf2);
        for (const entry of entries)
          if (entry.op !== null) {
            heapBytes -= entry.bytes;
            entry.op = null;
            if (entry[FOLD_BUFFER] !== void 0)
              entry[FOLD_BUFFER] = void 0;
          }
        bytes = await encodeWriteBatch({ inodes: [], chunks: [], ops });
        numberEntries(entries);
      } catch (error2) {
        const code = error2?.code;
        const errno2 = typeof code === "string" && /^E[A-Z0-9]+$/.test(code) ? code : "EIO";
        for (const entry of entries)
          fail2(entry, errno2, `this write could not be sent: ${error2 instanceof Error ? error2.message : String(error2)}`, true);
        forget(entries[entries.length - 1].jid, false);
        epoch = null;
        for (const entry of queue)
          entry.seq = 0;
        return;
      }
      const firstSeq = entries[0].seq;
      counters.waves++;
      counters.maxWaveOps = Math.max(counters.maxWaveOps, entries.length);
      wave++;
      let result;
      try {
        result = await sendWaveAttempts({
          supervisor: session,
          writer: async () => writer,
          open: waveAttemptsOf(bytes),
          streamed: false,
          wave,
          ...writer === null ? {} : { sequence: { seq: firstSeq, ack } },
          ...options.retry === void 0 ? {} : { retry: options.retry },
          resent: () => {
            counters.resends++;
          },
          timers
        });
      } catch (error2) {
        if (error2 instanceof Error && classifyMessage(error2.message) === "subrequest_cap") {
          exhaustedInvocation(entries, error2);
          return;
        }
        if (error2 instanceof Error && isProcessGone(error2)) {
          endedProcess(entries, error2, writer);
          return;
        }
        lostEpoch(entries, `the session did not answer this write: ${error2 instanceof Error ? error2.message : String(error2)}`, writer);
        return;
      }
      const answer = result;
      const error = answer.ok ? null : answer.error;
      const cursor = writer === null ? firstSeq - 1 + (answer.ok ? entries.length : answer.committedOps) : answer.sequence?.cursor;
      if (cursor === void 0) {
        lostEpoch(entries, `the session answered this write without its cursor: ${error?.message ?? "no error"}`, writer);
        return;
      }
      ack = Math.max(ack, cursor);
      ownHeld = answer.held === true;
      if (!ownHeld)
        ownThrough = Math.max(ownThrough, answer.revision ?? Infinity);
      const recalling = error?.recall === true;
      const refused = recalling ? null : writer === null ? error?.errno !== void 0 && SYSCALL_VERDICTS.has(error.errno) ? { seq: cursor + 1, errno: error.errno, message: error.message } : null : answer.sequence?.refused ?? null;
      let receipt = 0;
      const back = [];
      const mutations2 = new Map((answer.mutations ?? []).map((mutation) => [mutation.index, mutation]));
      if (answer.held === true)
        heldWaves++;
      for (const [index, entry] of entries.entries()) {
        if (refused !== null && entry.seq === refused.seq) {
          counters.refused++;
          fail2(entry, refused.errno, refused.message, true, ops[index] ?? null);
          if (writer === null)
            ack = Math.max(ack, entry.seq);
          continue;
        }
        if (entry.seq <= cursor) {
          settled(entry);
          let answered2 = {};
          const op = ops[index];
          const path = op.type === "call" && ("data" in op.call || op.call.call === "open" || op.call.call === "copyFile") ? op.call.path : null;
          const published = answer.receipts[receipt];
          if (path !== null && published?.path === path) {
            receipt++;
            const { path: _path, ...stat } = published;
            answered2 = { receipt: stat };
          }
          const mutation = mutations2.get(index);
          if (mutation !== void 0)
            answered2.mutation = { before: mutation.before, after: mutation.after };
          entry.resolve(answered2);
          continue;
        }
        back.push(entry);
      }
      const answeredThrough = back.length === 0 ? entries[entries.length - 1].jid : back[0].jid - 1;
      if (answeredThrough >= entries[0].jid)
        forget(answeredThrough, true);
      if (back.length === 0) {
        recalled = null;
        return;
      }
      if (recalling && recalled?.jid !== back[0].jid)
        recalled = { jid: back[0].jid, since: now(), waits: 0 };
      if (!recalling)
        recalled = null;
      if (answer.ok || refused !== null || recalled !== null && now() - recalled.since < WAVE_RECALL_BOUND_MS) {
        for (const entry of back)
          entry.lingers = false;
        queue.unshift(...back);
        if (recalled !== null)
          await new Promise((resolve) => {
            timers.setTimeout(resolve, recallWaitMs(recalled.waits++));
          });
        return;
      }
      recalled = null;
      lostEpoch(back, `the session could not apply this write: ${error?.message ?? "no error"}`, writer);
    };
    const lostEpoch = (entries, message, writer) => {
      for (const entry of entries) {
        counters.lost++;
        if (!entry.acknowledged)
          failures.push({ op: entry.name, path: entry.paths[0] ?? "", errno: "EIO", message });
        fail2(entry, "EIO", message);
      }
      forget(entries[entries.length - 1].jid, false);
      if (writer !== null)
        retiring.push(writer);
      epoch = null;
      ownThrough = Infinity;
      for (const entry of queue)
        entry.seq = 0;
    };
    const endedProcess = (entries, refusal, writer) => {
      processGone ??= refusal;
      const ended = [...entries, ...queue.splice(0)];
      for (const entry of ended) {
        if (entry.op !== null) {
          heapBytes -= entry.bytes;
          entry.op = null;
          if (entry[FOLD_BUFFER] !== void 0)
            entry[FOLD_BUFFER] = void 0;
        }
        fail2(entry, "ESRCH", processGone.message);
      }
      forget(ended[ended.length - 1].jid, false);
      if (writer !== null)
        retiring.push(writer);
      epoch = null;
      ownThrough = Infinity;
    };
    const exhaustedInvocation = (entries, refusal) => {
      processGone ??= fsError3("EIO", refusal.message, "");
      const stopped = [...entries, ...queue.splice(0)];
      for (const entry of stopped) {
        if (entry.op !== null) {
          heapBytes -= entry.bytes;
          entry.op = null;
          if (entry[FOLD_BUFFER] !== void 0)
            entry[FOLD_BUFFER] = void 0;
        }
        fail2(entry, "EIO", refusal.message);
      }
      forget(stopped[stopped.length - 1].jid, false);
      epoch = null;
      ownThrough = Infinity;
    };
    const pump = () => {
      scheduled = false;
      if (inFlight !== null || paused || sealed)
        return;
      if (queue.length === 0)
        return;
      if (marks.length === 0 && queue.every((entry) => entry.lingers)) {
        lingerTimer ??= timers.setTimeout(() => {
          lingerTimer = null;
          client.hurry();
        }, lingerMs);
        return;
      }
      const entries = cut();
      if (queue.length === 0 && lingerTimer !== null) {
        timers.clearTimeout(lingerTimer);
        lingerTimer = null;
      }
      inFlight = entries;
      sending = send(entries).finally(() => {
        inFlight = null;
        sending = null;
        pump();
      });
    };
    const entered = (given, submitOptions, foldOnly) => {
      const acknowledged = submitOptions?.acknowledged === true;
      if (processGone !== null && !(sealed && (acknowledged || submitOptions?.decided === true)))
        throw processGone;
      const op = withUmaskOf(given, options.umask);
      const named = pathsOf(op);
      const lingers = (acknowledged || submitOptions?.decided === true) && named.every((path) => heldGrant(path) !== void 0);
      for (const path of named)
        if (!canonical(path))
          throw fsError3("EINVAL", `EINVAL: not a filesystem path the session takes: '${path}'`, path);
      if (op.type === "call" && op.call.call === "symlink" && utf8Length(op.call.target) > SYMLINK_TARGET_MAX) {
        throw fsError3("ENAMETOOLONG", `ENAMETOOLONG: a link's target is at most ${SYMLINK_TARGET_MAX} bytes`, op.call.path);
      }
      const parts = pieces(op);
      const bytes = parts.reduce((sum, part) => sum + (part.type === "call" && "data" in part.call ? part.call.data.byteLength : 0), 0);
      if (acknowledged && !sealed && pendingSyncBytes + bytes > syncCap)
        throw syncCapRefusal(bytes, pathsOf(op)[0] ?? "");
      const tail = foldTail(parts, named, acknowledged);
      const merged = tail !== void 0 ? folded(tail.op, parts[0], tail[FOLD_BUFFER] ?? null) : null;
      if (merged !== null && tail !== void 0) {
        const mergedBytes = merged.op.type === "call" && "data" in merged.op.call ? merged.op.call.data.byteLength : 0;
        journal.replace(tail.jid, merged.op, merged.append);
        const grown2 = mergedBytes - tail.bytes;
        tail.op = merged.op;
        if (merged.buffer !== null || tail[FOLD_BUFFER] !== void 0)
          tail[FOLD_BUFFER] = merged.buffer ?? void 0;
        tail.bytes = mergedBytes;
        if (tail.lingers && !lingers) {
          tail.lingers = false;
          schedule();
        }
        heapBytes += grown2;
        pendingBytes += grown2;
        if (acknowledged)
          pendingSyncBytes += grown2;
        counters.ops++;
        counters.folded++;
        options.logged?.(op);
        return tail.answer;
      }
      if (foldOnly)
        return void 0;
      options.logged?.(op);
      const answers = parts.map((part) => {
        let entry;
        const answer2 = new Promise((resolve, reject) => {
          const partBytes = part.type === "call" && "data" in part.call ? part.call.data.byteLength : 0;
          const jid = journal.append(part);
          const kept = !journal.durable || heapBytes + partBytes <= PROCESS_FS_HEAP_WINDOW_BYTES;
          if (kept)
            heapBytes += partBytes;
          entry = { op: kept ? part : null, jid, name: nameOf3(part), seq: 0, order: ++logged, bytes: partBytes, paths: pathsOf(part), acknowledged, lingers, resolve, reject, answer: null };
          queue.push(entry);
          pendingBytes += partBytes;
          if (acknowledged) {
            pendingSyncBytes += partBytes;
            pendingSyncOps++;
          }
          counters.ops++;
        });
        if (entry !== void 0)
          entry.answer = answer2;
        return { entry, answer: answer2 };
      });
      schedule();
      const answer = Promise.all(answers.map((piece) => piece.answer)).then((all) => {
        const first = all[0]?.mutation;
        const last = all[all.length - 1];
        if (last === void 0)
          return {};
        const failures2 = all.filter((piece) => piece.failed !== void 0);
        if (failures2.length > 0) {
          const { errno: errno2, message } = failures2[0].failed;
          return { failed: failures2.length === all.length && failures2.every((piece) => piece.failed.refused === true) ? { errno: errno2, message, refused: true } : { errno: errno2, message } };
        }
        const { mutation: _mutation, ...rest } = last;
        return first !== void 0 && last.mutation !== void 0 ? { ...rest, mutation: { before: first.before, after: last.mutation.after } } : rest;
      });
      if (acknowledged)
        answer.catch(() => {
        });
      const only = answers.length === 1 ? answers[0].entry : void 0;
      if (only !== void 0)
        only.answer = answer;
      return answer;
    };
    const foldTail = (parts, named, acknowledged) => {
      const tail = queue[queue.length - 1];
      return parts.length === 1 && tail !== void 0 && tail.paths[0] === named[0] && tail.seq === 0 && tail.op !== null && tail.acknowledged === acknowledged ? tail : void 0;
    };
    const schedule = () => {
      if (scheduled || inFlight !== null || paused || sealed)
        return;
      scheduled = true;
      queueMicrotask(pump);
    };
    const quiet = async () => {
      while (sending !== null)
        await sending;
    };
    const live = () => grants.filter((grant) => !grant.ended);
    const allowedRoot = (root) => root !== "" && !(options.isHomeRoot?.(root) ?? false);
    const close = (grant) => {
      if (grant.closed !== void 0)
        return grant.closed;
      const wasClosing = grant.closing;
      grant.closing = true;
      try {
        options.freezing?.(grant.root);
      } catch {
        grant.closing = wasClosing;
        return Promise.resolve(false);
      }
      grant.closed = (async () => {
        await client.flush();
        await end(grant);
        return true;
      })();
      return grant.closed;
    };
    const end = async (grant) => {
      if (grant.ended)
        return;
      grant.ended = true;
      const at = grants.indexOf(grant);
      if (at >= 0)
        grants.splice(at, 1);
      counters.released++;
      options.released?.(grant.root);
      try {
        await session.grants?.release(grant.owner);
      } catch {
      }
    };
    const answerRecalls = async (grant) => {
      const port = session.grants;
      while (!grant.ended) {
        let kind;
        try {
          kind = await port.awaitRecall(grant.owner, recallPollMs);
        } catch {
          if (!grant.ended) {
            grant.ended = true;
            const at = grants.indexOf(grant);
            if (at >= 0)
              grants.splice(at, 1);
            options.released?.(grant.root);
          }
          return;
        }
        if (kind === null || grant.ended)
          continue;
        counters.recalls++;
        const wasClosing = grant.closing;
        grant.closing = true;
        options.freezing?.(grant.root);
        await client.flush();
        if (kind === "share") {
          grant.shared = true;
          grant.closing = wasClosing;
          options.released?.(grant.root);
        }
        try {
          await port.recalled(grant.owner, kind);
        } catch {
        }
        if (kind === "revoke") {
          grant.ended = true;
          const at = grants.indexOf(grant);
          if (at >= 0)
            grants.splice(at, 1);
          options.released?.(grant.root);
          return;
        }
      }
    };
    let readLease = null;
    const endedReadLeases = new SafeSet();
    const endReadLease = (owner) => {
      endedReadLeases.add(owner);
      if (endedReadLeases.size > 64)
        endedReadLeases.delete(setFind(endedReadLeases, () => true));
      if (readLease?.owner === owner)
        readLease = null;
    };
    const giveBackReadLease = async (owner) => {
      endReadLease(owner);
      counters.readReleased++;
      const port = reflectGet(session, "grants");
      await (port === void 0 ? void 0 : promiseThen(promiseResolve(port.release(owner)), void 0, () => {
      }));
    };
    let runEnded = false;
    const answerReadRecalls = async (owner) => {
      const port = reflectGet(session, "grants");
      for (; ; ) {
        const polled = now();
        let kind;
        try {
          kind = await port.awaitRecall(owner, recallPollMs);
        } catch {
          endReadLease(owner);
          return;
        }
        if (readLease?.owner !== owner)
          return;
        if (kind === null) {
          if (readLease.confirmedAt < polled) {
            await giveBackReadLease(owner);
            return;
          }
          continue;
        }
        endReadLease(owner);
        counters.readRecalls++;
        try {
          await port.recalled(owner, kind);
        } catch {
        }
        return;
      }
    };
    const armIdle = () => {
      if (idleTimer !== null || live().length === 0)
        return;
      idleTimer = timers.setTimeout(() => {
        idleTimer = null;
        const idle = live().filter((grant) => !grant.closing && now() - grant.lastUsed >= grantIdleMs);
        if (idle.length === 0 || settling) {
          armIdle();
          return;
        }
        void Promise.all(idle.map(close)).then(armIdle);
      }, grantIdleMs);
    };
    const claim = (root) => {
      const port = session.grants;
      if (port === void 0 || claiming !== null || settling)
        return;
      claiming = (async () => {
        let target = root;
        const held = live();
        if (held.length >= MAX_DELEGATIONS_PER_PROCESS) {
          let best = "";
          for (const grant2 of held) {
            const shared = commonAncestor(grant2.root, root);
            if (shared.length > best.length)
              best = shared;
          }
          if (!allowedRoot(best))
            return;
          target = best;
        }
        const covered = live().filter((grant2) => within3(grant2.root, target));
        if (covered.length > 0) {
          if (!(await Promise.all(covered.map(close))).every(Boolean))
            return;
          if (covered.some((grant2) => grant2.root !== target))
            counters.widened++;
          else
            counters.renewed++;
        }
        await client.flush();
        paused = true;
        await quiet();
        const inos = rangeOf.has(target) ? rangeOf.get(target) * 2 : options.grantInos ?? GRANT_INOS;
        let granted;
        try {
          granted = await port.acquire("/" + target, { reads: true, inos, bytes: GRANT_BYTES });
        } catch (error) {
          if (error?.code !== "ENOENT")
            refusedRoots.add(target);
          counters.grantsRefused++;
          return;
        }
        rangeOf.set(target, inos);
        const grant = {
          root: granted.root,
          owner: granted.owner,
          umask: granted.umask ?? 18,
          confined: granted.confined === true,
          ...granted.certificate === void 0 ? {} : { certificate: granted.certificate },
          nextIno: granted.inos?.first ?? 0,
          endIno: granted.inos?.end ?? 0,
          inos,
          bytesLeft: granted.bytes ?? 0,
          shared: false,
          closing: false,
          ended: false,
          lastUsed: now()
        };
        grants.push(grant);
        counters.grants++;
        void answerRecalls(grant);
        armIdle();
      })().finally(() => {
        claiming = null;
        paused = false;
        for (const key of [...mutations.keys()])
          if (within3(key, root) || within3(root, key))
            mutations.delete(key);
        schedule();
      });
    };
    const heldGrant = (key) => {
      if (escaped !== null)
        return void 0;
      for (let i = 0; i < grants.length; i++) {
        const grant = grants[i];
        if (!grant.ended && !grant.closing && !grant.shared && within3(key, grant.root))
          return grant;
      }
      return void 0;
    };
    const syncCapRefusal = (bytes, path) => fsError3("ENOMEM", `ENOMEM: ${pendingSyncBytes} bytes of synchronous writes are waiting for the session, and this one (${bytes}) would pass the ${syncCap}-byte cap; let the program yield (an await) for them to be sent`, path);
    const client = {
      holder(key) {
        const held = heldGrant(key);
        if (held !== void 0) {
          if (pendingSyncOps >= DECIDED_BACKLOG_OPS || pendingSyncBytes >= DECIDED_BACKLOG_BYTES)
            return void 0;
          held.lastUsed = now();
          return held;
        }
        if (session.grants === void 0 || settling || escaped !== null)
          return void 0;
        if (grants.some((grant) => !grant.ended && within3(key, grant.root)))
          return void 0;
        let deepest;
        for (let root = parentKey(key); allowedRoot(root); root = parentKey(root)) {
          if ([...refusedRoots].some((refused) => within3(root, refused)))
            break;
          const seen = (mutations.get(root) ?? 0) + 1;
          mutations.set(root, seen);
          if (seen >= grantAfter && deepest === void 0)
            deepest = root;
        }
        if (deepest !== void 0)
          claim(deepest);
        return void 0;
      },
      number(grant) {
        const held = grant;
        if (held.ended || held.closing || held.nextIno >= held.endIno)
          return void 0;
        if (held.endIno - held.nextIno <= held.inos / 4)
          queueMicrotask(() => claim(held.root));
        return held.nextIno++;
      },
      draw(grant, bytes) {
        const held = grant;
        if (held.ended || held.bytesLeft < bytes)
          return false;
        held.bytesLeft -= bytes;
        return true;
      },
      held(key) {
        return heldGrant(key);
      },
      holds(key) {
        return grants.some((grant) => !grant.ended && within3(key, grant.root));
      },
      vouch(key, root) {
        if (client.pending() || ownHeld || root.cursor < ownThrough)
          return void 0;
        return client.certifies(key, root);
      },
      certifies(key, root) {
        if (escaped !== null)
          return void 0;
        let found;
        for (let i = 0; i < grants.length; i++) {
          const grant = grants[i];
          const certificate = ownValue(grant, "certificate");
          if (certificate === void 0 || certificate.epoch !== root.epoch || root.cursor < certificate.revision)
            continue;
          const standing2 = standingOf(grant, key);
          if (standing2 === "held")
            return standing2;
          found ??= standing2;
        }
        return found;
      },
      guards(key) {
        if (escaped !== null)
          return false;
        for (let i = 0; i < grants.length; i++) {
          const grant = grants[i];
          if (grant !== void 0 && standingOf(grant, key) !== void 0)
            return true;
        }
        return false;
      },
      pending() {
        return queue.length > 0 || inFlight !== null;
      },
      fitsSync(bytes, path) {
        if (!sealed && pendingSyncBytes + bytes > syncCap)
          throw syncCapRefusal(bytes, path);
      },
      submit(given, submitOptions) {
        return entered(given, submitOptions, false);
      },
      fold(given, submitOptions) {
        return entered(given, submitOptions, true);
      },
      hurry() {
        for (const entry of queue)
          entry.lingers = false;
        schedule();
      },
      seal() {
        sealed = true;
        if (lingerTimer !== null) {
          timers.clearTimeout(lingerTimer);
          lingerTimer = null;
        }
      },
      flush() {
        options.drain?.();
        const mark = logged;
        const flushed = answered >= mark ? Promise.resolve() : new Promise((resolve) => {
          marks.push({ mark, resolve });
        });
        schedule();
        return flushed.then(async () => {
          if (processGone === null)
            return;
          await retirePending().catch(() => {
          });
          throw processGone;
        });
      },
      effect() {
        if (processGone !== null)
          return null;
        options.drain?.();
        return answered >= logged ? null : client.flush();
      },
      published() {
        const ask = options.session.published;
        if (processGone !== null || ask === void 0 || publishedThrough === heldWaves)
          return null;
        const through = heldWaves;
        return ask.call(options.session, false).then(() => {
          if (publishedThrough < through)
            publishedThrough = through;
        });
      },
      rawSocket() {
        const ask = options.session.published;
        if (processGone !== null)
          return Promise.reject(processGone);
        if (ask === void 0)
          return null;
        if (escaped === null) {
          const through = heldWaves;
          escaped = ask.call(options.session, true).then(() => {
            escapeLanded = true;
            publishedThrough = Math.max(publishedThrough, through);
          });
          escaped.catch(() => {
          });
        }
        const logged2 = client.effect();
        if (escapeLanded && logged2 === null)
          return client.published();
        return Promise.all([escaped, logged2]).then(() => client.published() ?? void 0);
      },
      async settle() {
        settling = true;
        runEnded = true;
        if (readLease !== null)
          void giveBackReadLease(readLease.owner);
        if (claiming !== null)
          await claiming;
        try {
          while (answered < logged)
            await client.flush();
        } finally {
          if (idleTimer !== null) {
            timers.clearTimeout(idleTimer);
            idleTimer = null;
          }
          for (const grant of live()) {
            grant.closing = true;
            options.freezing?.(grant.root);
          }
          await client.flush();
          for (const grant of live())
            void end(grant);
          settling = false;
        }
        if (processGone !== null)
          await retirePending().catch(() => {
          });
        const failure2 = client.takeFailuresError();
        if (failure2 !== null)
          throw failure2;
      },
      takeFailures() {
        return failures.splice(0, failures.length);
      },
      readTrusted() {
        return readLease !== null && readLease.logged === logged && now() < readLease.until;
      },
      readUnchanged(owner) {
        return !runEnded && readLease?.owner === owner && readLease.logged === logged;
      },
      readLeaseAsk() {
        if (reflectGet(session, "grants") === void 0 || runEnded)
          return null;
        return { at: now(), logged: answered === logged ? logged : -1 };
      },
      readLeaseAnswered(lease) {
        if (reflectGet(session, "grants") === void 0 || endedReadLeases.has(lease.owner))
          return;
        if (readLease?.owner === lease.owner) {
          readLease.confirmedAt = now();
          return;
        }
        if (runEnded) {
          void giveBackReadLease(lease.owner);
          return;
        }
        readLease = { owner: lease.owner, until: 0, confirmedAt: now(), logged: -1 };
        counters.readLeases++;
        void answerReadRecalls(lease.owner);
      },
      readLeased(lease, ask) {
        if (readLease?.owner !== lease.owner)
          return;
        readLease.until = ask.at + lease.trustMs;
        readLease.logged = ask.logged;
        counters.readConfirms++;
      },
      takeFailuresError() {
        const taken = failures.splice(0, failures.length);
        if (processGone !== null)
          return processGone;
        return taken.length === 0 ? null : failuresError(taken);
      },
      noteFailure(failure2) {
        failures.push(failure2);
      },
      get pendingBytes() {
        return pendingBytes;
      },
      get ended() {
        return processGone !== null;
      },
      stats() {
        return { ...counters };
      }
    };
    return client;
  }
  var DRAIN_WAVE_BASE = 2 ** 40;
  function failuresError(failures) {
    const gone = failures.find((failure2) => failure2.errno === "ESRCH");
    if (gone !== void 0)
      return Object.assign(new Error(gone.message), { code: "ESRCH", failures });
    return Object.assign(new Error(`${failures.length} filesystem change${failures.length === 1 ? "" : "s"} this process made did not reach the session:
` + failures.map((failure2) => `  ${failure2.op} ${failure2.path}: ${failure2.errno}: ${failure2.message}`).join("\n")), { code: "EIO", failures });
  }

  // ../core/dist/runtime/wasi/delegation-holder.js
  var FIRST_LOCAL_HANDLE = -1;
  var descriptionId3 = () => crypto.randomUUID().replaceAll("-", "");
  function parentKey4(key) {
    const at = key.lastIndexOf("/");
    return at < 0 ? "" : key.slice(0, at);
  }
  function nameOf4(key) {
    return key.slice(key.lastIndexOf("/") + 1);
  }
  function within4(key, root) {
    return key === root || key.startsWith(`${root}/`);
  }
  function delegationHolder(options) {
    const { store } = options;
    const now = options.now ?? dateNow;
    const names = ownNames({
      entry: (key) => store.entry(key),
      // A cell goes with its name, but for bytes still unlogged or open.
      forgot: (key, entry) => {
        const inode = entry ? prov.inode(entry.dev, entry.ino) : void 0;
        if (inode?.cell === void 0 || inode.key !== key || dirty.has(inode) || inode.descs > 0)
          return;
        prov.dropCell(inode);
      }
    });
    const { decided } = names;
    let nextHandle = FIRST_LOCAL_HANDLE;
    const dirty = new SafeSet();
    let changes = 0;
    let sentAt = 0;
    const acknowledged = (op) => client.submit(op, { acknowledged: true });
    const deciding = (key) => {
      if (options.cannotWait?.() === true && client.held(key) === void 0)
        return void 0;
      const grant = client.holder(key);
      return grant === void 0 || provisionalActive && prov.touches(key) ? void 0 : grant;
    };
    let provisionalActive = false;
    const unhold = (inode, made) => {
      const cell = inode.cell;
      if (cell === void 0 || cell.detached !== void 0)
        return;
      dirty.delete(inode);
      delete cell.logged;
      const mode = cell.umask === void 0 ? cell.mode : cell.mode & ~cell.umask;
      const entry = decided.get(inode.key) ?? store.entry(inode.key) ?? {
        type: "file",
        dev: store.device,
        ino: inode.ino,
        nlink: 1,
        size: cell.length,
        atime: now(),
        mtime: now(),
        ctime: now(),
        mode: 32768 | mode,
        uid: store.cred.uid,
        gid: store.cred.gid,
        revision: 0,
        target: null
      };
      const opened = prov.descriptorsOf(inode).filter((desc) => desc.description === void 0 && desc.write);
      opened.forEach((desc, at) => {
        const description = desc.description = descriptionId3();
        const creating = made !== void 0 && at === 0;
        const making = creating ? { create: true, exclusive: true, ino: made, ...cell.umask === void 0 ? {} : { umask: cell.umask } } : {};
        const read = desc.read;
        void acknowledged({ type: "call", call: { call: "open", path: inode.key, mode: cell.mode, ...making, access: read ? "readwrite" : "write", description } }).then((answered) => prov.anchored(description, answered.receipt?.handle, read), () => {
        });
        if (creating && cell.length > 0) {
          acknowledged({ type: "call", call: { call: "write", path: inode.key, ino: made, description, offset: 0, data: owned(cell.bytes, cell.length) } });
        }
      });
      prov.unhold(inode, { ...entry, dev: inode.dev, ino: inode.ino, mode: entry.mode & ~4095 | mode });
    };
    const atName = (inode) => {
      const entry = decided.get(inode.key) ?? store.entry(inode.key);
      return entry && entry.ino === inode.ino ? entry : void 0;
    };
    const resized = (inode, size) => {
      const entry = decided.get(inode.key);
      if (!entry || entry.ino !== inode.ino)
        return;
      const at = now();
      entry.size = size;
      entry.mtime = at;
      entry.ctime = at;
      names.rewritten(inode.key);
    };
    const refusedByMode = (inode) => {
      const entry = decided.get(inode.key);
      if (entry === void 0 || entry === null || entry.ino !== inode.ino)
        return false;
      for (const desc of prov.descriptorsOf(inode)) {
        if (!modeAllows(entry, (desc.read ? 4 : 0) | (desc.write ? 2 : 0), store.cred))
          return true;
      }
      return false;
    };
    const throughAt = (keys) => {
      const open = prov.cells().filter((inode) => inode.cell.detached === void 0 && inode.descs > 0 && (keys === void 0 || keys.some((key) => within4(inode.key, key))));
      if (open.length === 0)
        return;
      drain();
      for (const inode of open)
        unhold(inode);
    };
    const drain = (except) => {
      if (dirty.size === 0)
        return;
      changes++;
      for (const inode of [...dirty]) {
        if (inode === except)
          continue;
        const file = inode.cell;
        const from = Math.min(file.changedFrom ?? 0, file.logged ?? 0);
        const ino = file.made;
        if (ino !== void 0 && refusedByMode(inode)) {
          dirty.delete(inode);
          delete file.changedFrom;
          delete file.made;
          unhold(inode, ino);
          continue;
        }
        if (ino === void 0 && from > 0) {
          if (file.length < file.logged)
            acknowledged({ type: "call", call: { call: "ftruncate", path: inode.key, size: file.length } });
          if (file.length > from)
            acknowledged({ type: "call", call: { call: "write", path: inode.key, offset: from, data: file.bytes.slice(from, file.length) } });
        } else {
          acknowledged({ type: "call", call: { call: "writeFile", path: inode.key, mode: file.mode, ...ino === void 0 ? {} : { ino }, ...file.umask === void 0 ? {} : { umask: file.umask }, data: file.bytes.slice(0, file.length) } });
        }
        dirty.delete(inode);
        delete file.changedFrom;
        delete file.made;
        file.logged = file.length;
      }
    };
    let lingerTimer = null;
    const dropDecisions = (root) => {
      drain();
      for (const inode of prov.cells())
        if (within4(inode.key, root))
          unhold(inode);
      names.released(root);
      prov.answeredHeld(root);
      options.sent?.();
    };
    const client = processFsClient({
      session: options.session,
      now,
      ...options.timers === void 0 ? {} : { timers: options.timers },
      ...options.umask === void 0 ? {} : { umask: options.umask },
      ...options.isHomeRoot === void 0 ? {} : { isHomeRoot: options.isHomeRoot },
      ...options.grantAfter === void 0 ? {} : { grantAfter: options.grantAfter },
      ...options.grantInos === void 0 ? {} : { grantInos: options.grantInos },
      ...options.journal === void 0 ? {} : { journal: options.journal },
      ...options.logged === void 0 ? {} : { logged: options.logged },
      released: dropDecisions,
      // Closing starts (a recall, an idle or renewing give-back): nothing more
      // is decided under it, and its files' descriptions write through from now
      // on, so the flush that follows covers everything accepted before.
      freezing: (root) => {
        drain();
        for (const inode of prov.cells())
          if (within4(inode.key, root))
            unhold(inode);
      },
      drain
    });
    const heldContent = (entry) => {
      const inode = prov.inode(entry.dev, entry.ino);
      const cell = inode === void 0 ? void 0 : ownValue(inode, "cell");
      return cell === void 0 ? void 0 : bytesCopy(cell.bytes, 0, cell.length);
    };
    const copies = new SafeMap();
    const prov = provisional({
      // The store's, as it knows it when asked (it learns it at its first barrier).
      get device() {
        return store.device;
      },
      get cred() {
        return store.cred;
      },
      row: (key) => entryOf(key),
      children: (key) => names.children(key, store.children(key)),
      content: (key, revision) => {
        const entry = decided.get(key);
        return (entry ? heldContent(entry) : void 0) ?? ownValue(store, "content")?.(key, revision);
      },
      reserve: (bytes) => ownValue(store, "reserve")?.(bytes) ?? true,
      release: (bytes) => ownValue(store, "release")?.(bytes),
      client,
      drain,
      sent: () => options.sent?.(),
      // Reads by name and by number consult them only while the process sees any.
      active: (on) => {
        provisionalActive = on;
      },
      held: (key) => client.held(key) !== void 0,
      pending: (key) => copies.has(key),
      count: (key) => {
        client.holder(key);
      },
      umask: () => options.umask?.() ?? 18,
      now,
      nextHandle: () => nextHandle--,
      unhold: (inode) => {
        drain();
        unhold(inode);
      },
      generation: (key) => names.generation(key),
      settled: (key, generation) => names.settled(key, generation),
      ...store.mounted === void 0 ? {} : { mounted: (key) => store.mounted(key) },
      ...store.unreported === void 0 ? {} : { unreported: (key) => ownValue(store, "unreported")(key) },
      ...store.keep === void 0 ? {} : { keep: (key, row, bytes) => ownValue(store, "keep")(key, row.revision, bytes) },
      absorb: (key, file) => {
        const decision = decided.get(key);
        if (!decision || decision.dev !== file.dev || decision.ino !== file.ino)
          return void 0;
        decision.size = file.size;
        decision.mode = file.mode;
        decision.uid = file.uid;
        decision.gid = file.gid;
        decision.atime = file.atime;
        decision.mtime = file.mtime;
        decision.ctime = file.ctime;
        return decision;
      }
    });
    const composedEntry = (key) => {
      const mine = prov.entry(key);
      return mine !== void 0 ? mine : names.entry(key);
    };
    const composedRow = (key) => {
      const row = entryOf(key);
      const mine = prov.entry(key, row);
      return mine !== void 0 ? mine : row;
    };
    const composedChildren = (key, base) => prov.children(key, names.children(key, base));
    const composedContent = (entry) => prov.content(entry) ?? heldContent(entry);
    const log = (op) => {
      drain();
      changes++;
      acknowledged(op);
    };
    const sentSome = (covered) => {
      if (covered <= sentAt)
        return;
      sentAt = covered;
      options.sent?.();
    };
    const entryOf = (key) => {
      const mine = names.entry(key);
      return mine !== void 0 ? mine : store.entry(key);
    };
    const ownership = (parent) => {
      const setgid = (parent.mode & 1024) !== 0;
      return { uid: store.cred.uid, gid: setgid ? parent.gid : store.cred.gid, setgid };
    };
    const writableParent = (key, path, syscall) => {
      const parent = entryOf(parentKey4(key));
      if (parent === void 0 || parent === null || parent.dev !== store.device)
        return void 0;
      if (parent.type !== "directory")
        throw fsError2("ENOTDIR", syscall, path);
      if (!modeAllows(parent, 3, store.cred))
        throw fsError2("EACCES", syscall, path);
      return parent;
    };
    const removable = (key, row, path, syscall) => {
      const parent = writableParent(key, path, syscall);
      if (parent === void 0)
        return false;
      if (stickyRefusal(parent, row, store.cred) !== null)
        throw fsError2("EPERM", syscall, path);
      return true;
    };
    const written = (inode, from = 0) => {
      const file = inode.cell;
      if (file.detached)
        return;
      file.changedFrom = Math.min(file.changedFrom ?? from, from);
      dirty.delete(inode);
      dirty.add(inode);
      lingerTimer ??= setTimeout(() => {
        lingerTimer = null;
        try {
          drain();
        } catch {
        }
      }, LINGER_MS);
    };
    const detach = (inode, entry) => {
      const file = inode.cell;
      file.detached = { ...entry, nlink: 0, size: file.length };
      delete file.logged;
      dirty.delete(inode);
    };
    const heldEntry = (handle) => {
      const file = handle.inode.cell;
      if (file.detached !== void 0)
        return { ...file.detached, size: file.length };
      const entry = atName(handle.inode);
      if (!entry)
        throw fsError2("EBADF", "fstat", handle.path);
      return { ...entry, size: file.length };
    };
    const heldDesc = (handleId) => {
      const desc = prov.descriptor(handleId);
      if (desc === void 0)
        throw fsError2("EBADF", "fd", String(handleId));
      return desc.inode.cell === void 0 ? void 0 : desc;
    };
    const room = (file, key, length) => {
      if (length <= file.bytes.byteLength)
        return true;
      const grant = client.held(key);
      const size = Math.max(length, file.bytes.byteLength * 2, 4096);
      if (grant !== void 0 && !client.draw(grant, size - file.bytes.byteLength))
        return false;
      const next = new Uint8Array(size);
      next.set(file.bytes.subarray(0, file.length));
      file.bytes = next;
      return true;
    };
    const failed = () => {
      const failures = client.takeFailures();
      if (failures.length > 0) {
        throw fsError2(failures[0].errno, "fsync", failures[0].path, void 0, {
          detail: `the session refused what this process decided: ${failures.map((failure2) => `${failure2.op} ${failure2.path}: ${failure2.message}`).join("; ")}`
        });
      }
    };
    const changedBy = (entry, attrs) => "mode" in attrs ? { ...entry, mode: entry.mode & ~4095 | attrs.mode & 4095, ctime: now() } : "uid" in attrs ? { ...entry, uid: attrs.uid ?? entry.uid, gid: attrs.gid ?? entry.gid, mode: chownedMode(entry.mode, store.cred), ctime: now() } : { ...entry, atime: timeAt(attrs.atime, entry.atime, now()), mtime: timeAt(attrs.mtime, entry.mtime, now()), ctime: now() };
    const holder = {
      client,
      provisional: prov,
      // Composed with the provisional decisions while the process sees any (ProvisionalHost.active).
      entry: (key) => provisionalActive ? composedEntry(key) : names.entry(key),
      row: (key) => provisionalActive ? composedRow(key) : entryOf(key),
      children: (key, base) => provisionalActive ? composedChildren(key, base) : names.children(key, base),
      copyFile: (from, to, path, stored, keepMode) => {
        const source = composedRow(from);
        if (source === void 0 || source === null || source.type !== "file" || (source.mode & 3584) !== 0)
          return false;
        if (!modeAllows(source, 4, store.cred))
          return false;
        const target = composedRow(to);
        if (target === void 0 || target !== null && target.type !== "file")
          return false;
        const grant = deciding(to);
        if (grant === void 0 || client.held(from) === void 0)
          return false;
        const bytes = holder.content(source) ?? stored;
        if (bytes === void 0)
          return false;
        const known = target === null ? void 0 : prov.inode(target.dev, target.ino);
        if (target !== null && (store.cred.uid !== 0 && target.uid !== store.cred.uid || known !== void 0 && (known.descs > 0 || known.cell === void 0)))
          return false;
        const umask = grant.umask;
        const asked = copiedPermissions(source.mode, false);
        const opened = target === null ? asked & ~umask : target.mode & 4095;
        const mode = keepMode ? copyfileMode(source.mode, bytes.byteLength, store.cred.uid) : opened;
        if (keepMode && confinedModeRefusal(opened, mode) !== null)
          return false;
        let entry;
        let made;
        if (target === null) {
          const parent = writableParent(to, path, "copyfile");
          if (parent === void 0)
            return false;
          made = client.number(grant);
          if (made === void 0)
            return false;
          const { uid, gid } = ownership(parent);
          const stamp = now();
          entry = { type: "file", dev: store.device, ino: made, nlink: 1, size: bytes.byteLength, atime: stamp, mtime: stamp, ctime: stamp, mode: 32768 | mode, uid, gid, revision: 0, target: null };
        } else {
          if (!modeAllows(target, 2, store.cred))
            throw fsError2("EACCES", "copyfile", path);
          entry = { ...target, size: bytes.byteLength, mode: target.mode & ~4095 | mode, mtime: now(), ctime: now() };
        }
        const inode = known ?? prov.inodeFor(to, { ...entry });
        if (inode === void 0)
          return false;
        drain();
        const file = inode.cell ?? { bytes: new Uint8Array(0), length: 0, mode };
        if (!room(file, to, bytes.byteLength)) {
          if (inode.cell === void 0)
            prov.dropCell(inode);
          return false;
        }
        file.bytes.set(bytes);
        file.length = bytes.byteLength;
        file.logged = bytes.byteLength;
        file.mode = mode;
        if (target === null)
          names.note(parentKey4(to), nameOf4(to), "file");
        names.decide(to, entry);
        prov.hold(inode, file);
        const description = descriptionId3();
        changes++;
        acknowledged({ type: "call", call: { call: "open", path: to, mode: asked, access: "write", ...made === void 0 ? {} : { ino: made, umask }, create: true, truncate: true, ...keepMode ? { fchmod: mode } : {}, description } });
        acknowledged({ type: "call", call: { call: "write", path: to, ...made === void 0 ? {} : { ino: made }, description, offset: 0, data: bytes.slice() } });
        acknowledged({ type: "call", call: { call: "close", path: to, description } });
        return true;
      },
      logHeld: () => {
        client.seal();
        drain();
      },
      content: (entry) => provisionalActive ? composedContent(entry) : heldContent(entry),
      owns: (handleId) => prov.owns(handleId),
      open: (key, path, flags, initial = 0) => {
        if (!flags.write || flags.append)
          return void 0;
        if (!flags.create && !flags.truncate)
          return void 0;
        if (((flags.mode ?? 438) & 3584) !== 0)
          return void 0;
        const current = entryOf(key);
        if (current === void 0 || current !== null && current.type !== "file")
          return void 0;
        const grant = deciding(key);
        if (grant === void 0)
          return void 0;
        if (current !== null && flags.exclusive && flags.create)
          throw fsError2("EEXIST", "open", path);
        if (current === null && !flags.create)
          throw fsError2("ENOENT", "open", path);
        let inode;
        if (current === null) {
          const parent = writableParent(key, path, "open");
          if (parent === void 0)
            return void 0;
          const ino = client.number(grant);
          if (ino === void 0)
            return void 0;
          const asked = (flags.mode ?? 438) & 511;
          const umask = flags.umask ?? grant.umask;
          const { uid, gid } = ownership(parent);
          const stamp = now();
          const entry = {
            type: "file",
            dev: store.device,
            ino,
            nlink: 1,
            size: 0,
            atime: stamp,
            mtime: stamp,
            ctime: stamp,
            mode: 32768 | asked & ~umask,
            uid,
            gid,
            revision: 0,
            target: null
          };
          drain();
          const file = { bytes: new Uint8Array(0), length: 0, mode: asked, made: ino, umask };
          if (initial > 0 && !room(file, key, initial))
            return void 0;
          inode = prov.inodeFor(key, { ...entry });
          if (inode === void 0)
            return void 0;
          prov.hold(inode, file);
          names.decide(key, entry);
          names.note(parentKey4(key), nameOf4(key), "file");
          written(inode);
        } else if (!flags.truncate) {
          if (!modeAllows(current, flags.read ? 6 : 2, store.cred))
            throw fsError2("EACCES", "open", path);
          inode = prov.inode(current.dev, current.ino);
          if (inode?.cell === void 0 || inode.key !== key)
            return void 0;
        } else {
          if (!modeAllows(current, flags.read ? 6 : 2, store.cred))
            throw fsError2("EACCES", "open", path);
          inode = prov.inode(current.dev, current.ino);
          if (inode !== void 0 && inode.cell === void 0 && (inode.state !== null || inode.records.length > 0))
            return void 0;
          inode ??= prov.inodeFor(key, current);
          if (inode === void 0)
            return void 0;
          const file = inode.cell ?? { bytes: new Uint8Array(0), length: 0, mode: current.mode & 4095 };
          if (initial > 0 && !room(file, key, initial)) {
            if (inode.cell === void 0)
              prov.dropCell(inode);
            return void 0;
          }
          file.length = 0;
          prov.hold(inode, file);
          names.decide(key, { ...current, size: 0, mtime: now(), ctime: now() });
          written(inode);
        }
        return prov.heldDescriptor(inode, path, !!flags.read, false);
      },
      writeFile: (key, path, bytes, flags) => {
        const handle = holder.open(key, path, flags, bytes.byteLength);
        if (handle === void 0)
          return void 0;
        holder.write(handle.id, 0, bytes);
        const held = heldDesc(handle.id);
        const revision = held === void 0 ? void 0 : heldEntry(held).revision;
        holder.close(handle.id);
        return revision;
      },
      setStatus: (handleId, status) => prov.setStatus(handleId, status),
      read: (handleId, offset, length) => {
        const handle = heldDesc(handleId);
        if (handle === void 0)
          return prov.read(handleId, offset, length);
        if (!handle.read)
          throw fsError2("EBADF", "read", handle.path);
        const file = handle.inode.cell;
        const start = Math.min(offset ?? handle.position, file.length);
        const chunk = file.bytes.slice(start, Math.min(file.length, start + length));
        if (offset === null)
          handle.position = start + chunk.byteLength;
        return chunk;
      },
      write: (handleId, offset, bytes, awaited) => {
        const handle = heldDesc(handleId);
        if (handle === void 0)
          return prov.write(handleId, offset, bytes, awaited);
        if (!handle.write)
          throw fsError2("EBADF", "write", handle.path);
        const inode = handle.inode;
        const file = inode.cell;
        const start = handle.append ? file.length : offset ?? handle.position;
        const end = start + bytes.byteLength;
        if (!room(file, inode.key, end))
          throw fsError2("ENOSPC", "write", handle.path);
        const from = Math.min(start, file.length);
        if (start > file.length)
          file.bytes.fill(0, file.length, start);
        file.bytes.set(bytes, start);
        file.length = Math.max(file.length, end);
        if (offset === null || handle.append)
          handle.position = end;
        resized(inode, file.length);
        written(inode, from);
        return bytes.byteLength;
      },
      seek: (handleId, offset, whence) => {
        const handle = heldDesc(handleId);
        if (handle === void 0)
          return prov.seek(handleId, offset, whence);
        const position = (whence === "set" ? 0 : whence === "current" ? handle.position : handle.inode.cell.length) + offset;
        if (position < 0)
          throw fsError2("EINVAL", "lseek", handle.path);
        handle.position = position;
        return position;
      },
      ftruncate: (handleId, size, awaited) => {
        const handle = heldDesc(handleId);
        if (handle === void 0)
          return prov.ftruncate(handleId, size, awaited);
        if (!handle.write)
          throw fsError2("EINVAL", "ftruncate", handle.path);
        const inode = handle.inode;
        const file = inode.cell;
        if (!room(file, inode.key, size))
          throw fsError2("ENOSPC", "ftruncate", handle.path);
        const from = Math.min(size, file.length);
        if (size > file.length)
          file.bytes.fill(0, file.length, size);
        file.length = size;
        resized(inode, size);
        written(inode, from);
      },
      fstat: (handleId) => {
        const handle = heldDesc(handleId);
        return handle === void 0 ? prov.fstat(handleId) : heldEntry(handle);
      },
      close: (handleId) => prov.close(handleId),
      keyOf: (handleId) => prov.keyOf(handleId),
      dup: (handleId) => prov.dup(handleId),
      reopen: (handleId, flags) => {
        const handle = heldDesc(handleId);
        if (handle === void 0)
          return prov.reopen(handleId, flags);
        const inode = handle.inode;
        const file = inode.cell;
        if (flags.append)
          return void 0;
        const entry = file.detached ?? atName(inode);
        if (!entry)
          throw fsError2("EBADF", "open", handle.path);
        if (flags.create && flags.exclusive)
          throw fsError2("EEXIST", "open", handle.path);
        if (!modeAllows(entry, (flags.read ? 4 : 0) | (flags.write || flags.truncate ? 2 : 0), store.cred))
          throw fsError2("EACCES", "open", handle.path);
        if (flags.truncate && !room(file, inode.key, 0))
          return void 0;
        const opened = prov.heldDescriptor(inode, handle.path, !!flags.read, false);
        prov.descriptor(opened.id).write = !!flags.write;
        if (flags.truncate) {
          file.length = 0;
          resized(inode, 0);
          written(inode, 0);
        }
        return {
          id: opened.id,
          path: handle.path,
          position: 0,
          closed: false,
          flags: { read: !!flags.read, write: !!flags.write, append: false, create: !!flags.create, exclusive: !!flags.exclusive, directory: false, truncate: !!flags.truncate, followSymlinks: true }
        };
      },
      mkdir: (key, path, mode, mask) => {
        if ((mode & 3584) !== 0)
          return false;
        const current = entryOf(key);
        if (current === void 0)
          return false;
        const grant = deciding(key);
        if (grant === void 0)
          return false;
        if (current !== null)
          throw fsError2("EEXIST", "mkdir", path);
        const parent = writableParent(key, path, "mkdir");
        if (parent === void 0)
          return false;
        const ino = client.number(grant);
        if (ino === void 0)
          return false;
        const { uid, gid, setgid } = ownership(parent);
        const stamp = now();
        const umask = mask ?? grant.umask;
        const perm = mode & 511 & ~umask | (setgid ? 1024 : 0);
        drain();
        names.decide(key, {
          type: "directory",
          dev: store.device,
          ino,
          nlink: 2,
          size: 0,
          atime: stamp,
          mtime: stamp,
          ctime: stamp,
          mode: 16384 | perm,
          uid,
          gid,
          revision: 0,
          target: null
        });
        names.note(parentKey4(key), nameOf4(key), "directory");
        names.madeDirectory(key);
        log({ type: "call", call: { call: "mkdir", path: key, mode: mode & 511, ino, umask } });
        return true;
      },
      unlink: (key, path) => {
        const current = entryOf(key);
        if (current === void 0 || current === null || current.type === "directory")
          return false;
        if (deciding(key) === void 0)
          return false;
        if (!removable(key, current, path, "unlink"))
          return false;
        const local = prov.inode(current.dev, current.ino);
        drain(local?.cell !== void 0 && local.key === key ? local : void 0);
        names.decide(key, null);
        names.note(parentKey4(key), nameOf4(key), null);
        if (local?.cell !== void 0 && local.key === key) {
          const made = local.cell.made;
          detach(local, current);
          if (local.descs === 0)
            prov.dropCell(local);
          if (made !== void 0)
            return true;
        }
        log({ type: "call", call: { call: "unlink", path: key } });
        return true;
      },
      rename: (from, to, path) => {
        const source = entryOf(from);
        const target = entryOf(to);
        if (source === void 0 || source === null || target === void 0)
          return false;
        if (source.type === "directory" && (target !== null || within4(to, from)))
          return false;
        if (target !== null && (target.type === "directory" || source.type === "directory"))
          return false;
        const grant = deciding(from);
        if (grant === void 0 || deciding(to) !== grant)
          return false;
        if (from === to)
          return true;
        if (!removable(from, source, path, "rename") || (target === null ? writableParent(to, path, "rename") === void 0 : !removable(to, target, path, "rename")))
          return false;
        const files = prov.planMove(from, to, path);
        try {
          drain();
          names.move(from, to);
          names.decide(from, null);
          names.decide(to, { ...source, ctime: now() });
          names.note(parentKey4(from), nameOf4(from), null);
          names.note(parentKey4(to), nameOf4(to), source.type);
          if (target !== null) {
            const replaced = prov.inode(target.dev, target.ino);
            if (replaced?.cell !== void 0 && replaced.key === to) {
              detach(replaced, target);
              if (replaced.descs === 0)
                prov.dropCell(replaced);
            }
          }
          files.commit();
        } finally {
          files.cancel();
        }
        log({ type: "rename", from, to });
        return true;
      },
      setattr: (key, attrs) => {
        const current = entryOf(key);
        if (current === void 0 || current === null)
          return false;
        if (deciding(key) === void 0)
          return false;
        if (store.cred.uid !== 0 && store.cred.uid !== current.uid)
          return false;
        if ("uid" in attrs && chownRefusal(current, attrs.uid, attrs.gid, store.cred) !== null)
          return false;
        if ("mode" in attrs && confinedModeRefusal(current.mode, attrs.mode) !== null)
          return false;
        if ("mode" in attrs) {
          throughAt([key]);
          if (provisionalActive && prov.touches(key))
            return false;
        }
        drain();
        const next = changedBy(current, attrs);
        names.decide(key, next);
        const local = prov.inode(current.dev, current.ino)?.cell;
        if (local !== void 0) {
          local.mode = next.mode & 4095;
          delete local.umask;
        }
        log({ type: "setattr", path: key, attrs: "uid" in attrs ? { uid: next.uid, gid: next.gid } : attrs });
        return true;
      },
      fsetattr: (handleId, change) => {
        const handle = heldDesc(handleId);
        if (handle === void 0) {
          prov.fsetattr(handleId, change);
          return false;
        }
        const inode = handle.inode;
        const file = inode.cell;
        const entry = file.detached ?? atName(inode);
        const at = now();
        const attrs = entry && "atime" in change ? { atime: timeAt(change.atime, entry.atime, at), mtime: timeAt(change.mtime, entry.mtime, at) } : change;
        if (file.detached === void 0) {
          if (entry && holder.setattr(inode.key, attrs))
            return true;
          drain();
          unhold(inode);
          prov.fsetattr(handleId, change);
          return false;
        }
        const detached = file.detached;
        const confined = client.held(inode.key)?.confined ?? true;
        const refused = "mode" in attrs ? chmodRefusal(detached, store.cred) ?? (confined ? confinedModeRefusal(detached.mode, attrs.mode) : null) : "uid" in attrs ? chownRefusal(detached, attrs.uid, attrs.gid, store.cred) : utimesRefusal(detached, "atime" in change && explicitTimes(change.atime, change.mtime), store.cred);
        if (refused !== null)
          throw fsError2(refused, "mode" in attrs ? "fchmod" : "uid" in attrs ? "fchown" : "futimes", "/" + inode.key);
        file.detached = changedBy(detached, attrs);
        file.mode = file.detached.mode & 4095;
        return true;
      },
      undecided: (key) => {
        names.undecide(key);
      },
      superseded: (key) => {
        names.superseded(key);
      },
      copying: (key, answered) => {
        copies.set(key, (copies.get(key) ?? 0) + 1);
        const done = () => {
          const left = (copies.get(key) ?? 1) - 1;
          if (left > 0)
            copies.set(key, left);
          else
            copies.delete(key);
        };
        answered.then(done, done);
      },
      holds: (key) => client.held(key) !== void 0,
      barrierBegun: () => {
        prov.barrierBegun();
        return names.barrierBegun();
      },
      retire: (begun) => {
        names.retire(begun);
        prov.retire(begun);
      },
      pending: () => dirty.size > 0 || client.pending(),
      flush: async () => {
        drain();
        const covered = changes;
        await client.flush();
        sentSome(covered);
        failed();
      },
      send: async () => {
        drain();
        const covered = changes;
        await client.flush();
        sentSome(covered);
      },
      reportRecorded: () => failed(),
      changing: (keys) => throughAt(keys),
      settle: async () => {
        drain();
        const covered = changes;
        await client.settle();
        sentSome(covered);
      },
      stats: () => {
        const stats = client.stats();
        return { waves: stats.waves, ops: stats.ops, recalls: stats.recalls, grants: stats.grants, widened: stats.widened };
      }
    };
    return holder;
  }

  // ../core/dist/runtime/wasi/read-directory-pool.js
  function failure(code, message) {
    return objectAssign(new Error2(`${code}: ${message}`), { code });
  }
  function asOpened(entry, current) {
    const seen = entry.opened;
    return seen !== null && current.mode === seen.mode && current.uid === seen.uid && current.gid === seen.gid && current.ctime === seen.ctime;
  }
  function keyOfPath(path) {
    const named = typeof path === "string" ? path : objectHasOwn(path, "root") ? `${path.root}/${path.path}` : "";
    const segments = stringSplit(named, "/");
    const kept = new SafeList();
    for (let i = 0; i < segments.length; i++)
      if (segments[i] !== "" && segments[i] !== ".")
        kept[kept.length] = segments[i];
    return arrayJoin(kept, "/");
  }
  function readDirectoryPool(options) {
    const { call, store, client, before } = options;
    const waitMs = ownValue(options, "endWaitMs");
    const endWaitMs = waitMs === void 0 ? DIRECTORY_END_WAIT_MS : waitMs;
    const channel = crypto.randomUUID();
    let sequence = 0, generation = 0, cancelled = 0;
    let owner = null, incarnation = null;
    let trustedAtIo = false, ended = false, uncertain = 0, reserved = 0;
    let unavailable = false;
    let tail = promiseResolve();
    const unused = new SafeMap();
    const owned2 = new SafeMap();
    const retiring = new SafeSet();
    const claiming = new SafeSet();
    const serial = (body) => {
      const result = promiseThen(tail, body);
      tail = promiseThen(result, () => {
      }, () => {
      });
      return result;
    };
    const outstanding = () => unused.size + owned2.size + retiring.size + uncertain + reserved;
    const discardUnused = () => {
      unused.forEach((entry) => {
        claiming.delete(entry.handle.id);
        retiring.add(entry.handle.id);
      });
      unused.clear();
    };
    const distrust = () => {
      generation++;
      trustedAtIo = false;
    };
    const invalidate = () => {
      distrust();
      discardUnused();
    };
    const sameIncarnation = () => {
      const now = store.cursor();
      return now !== null && incarnation !== null && sameEpochs(now, incarnation);
    };
    const valid = () => {
      const yes = trustedAtIo && owner !== null && client.readUnchanged(owner) && store.ready() && sameIncarnation();
      if (!yes) {
        trustedAtIo = false;
        if (incarnation !== null && !sameIncarnation())
          discardUnused();
      }
      return yes;
    };
    const local = (entry) => {
      if (!valid() || entry.key === null)
        return null;
      const current = store.entry(entry.key);
      return current?.type === "directory" && current.dev === entry.dev && current.ino === entry.ino ? { key: entry.key, entry: current } : null;
    };
    const claim = (entry) => {
      if (entry.key !== null && unused.get(entry.key)?.handle.id === entry.handle.id)
        unused.delete(entry.key);
      retiring.delete(entry.handle.id);
      owned2.set(entry.handle.id, entry);
      claiming.add(entry.handle.id);
      return entry.handle;
    };
    const exchange = async (open, wantLease, end = false) => {
      await before();
      const cursor = store.cursor();
      const ask = wantLease && cursor !== null ? client.readLeaseAsk() : null;
      const stamp = generation;
      const cancelAt = cancelled;
      const sentRetire = arrayCopy(setList(retiring));
      const sentClaim = arrayCopy(setList(claiming));
      const sentSequence = ++sequence;
      reserved += open.length;
      let result;
      try {
        result = await call({
          channel,
          sequence: sentSequence,
          position: cursor,
          open: arrayCopy(open),
          retire: sentRetire,
          claim: sentClaim,
          lease: ask !== null,
          ...end ? { end } : {}
        });
      } catch (error) {
        uncertain += open.length;
        invalidate();
        throw error;
      } finally {
        reserved -= open.length;
      }
      if (result.channel !== channel || result.sequence !== sentSequence) {
        uncertain += open.length;
        invalidate();
        throw failure("ESTALE", "directory batch reply belongs to another request");
      }
      for (let i = 0; i < result.retired.length; i++) {
        const id = result.retired[i];
        retiring.delete(id);
      }
      for (let i = 0; i < result.claimed.length; i++) {
        const id = result.claimed[i];
        claiming.delete(id);
      }
      uncertain = 0;
      for (let i = 0; i < result.opened.length; i++) {
        const entry = result.opened[i];
        retiring.add(entry.handle.id);
      }
      const lease = result.acquire.readLease;
      if (lease)
        client.readLeaseAnswered(lease);
      const current = store.cursor();
      const applies = current !== null && (sameEpochs(current, result.acquire.position) ? notAfter(current, result.acquire.position) : cursor !== null && sameEpochs(current, cursor) && generation === stamp);
      let admitted;
      try {
        admitted = applies && ownValue(await store.barrier({ answer: result.acquire }), "applied") === true;
      } catch (error) {
        invalidate();
        throw error;
      }
      trustedAtIo = false;
      if (lease && ask && admitted && !result.acquire.poison && generation === stamp && cancelled === cancelAt) {
        client.readLeased(lease, ask);
        owner = lease.owner;
        incarnation = result.acquire.position;
        trustedAtIo = client.readTrusted();
      }
      if (open.length > 0 && (cancelled !== cancelAt || ended)) {
        for (let i = 0; i < result.opened.length; i++) {
          const entry = result.opened[i];
          retiring.add(entry.handle.id);
        }
        throw failure("EAGAIN", "directory batch completed after its park ended");
      }
      return result.opened;
    };
    const drain = async () => {
      invalidate();
      if (retiring.size || claiming.size || uncertain)
        await exchange([], false);
    };
    return {
      open(path, key, prefetch) {
        const began = cancelled;
        return promiseThen(serial(async () => {
          if (ended)
            throw failure("ESTALE", "directory pool ended");
          if (unavailable)
            return null;
          if (began !== cancelled)
            throw failure("EAGAIN", "directory open was cancelled while queued");
          if (!store.ready() || !store.cursor()) {
            await drain();
            return null;
          }
          const hit = unused.get(key);
          const current = hit ? local(hit) : null;
          if (hit && current && asOpened(hit, current.entry))
            return claim(hit);
          if (hit) {
            unused.delete(key);
            claiming.delete(hit.handle.id);
            retiring.add(hit.handle.id);
          }
          unused.forEach((entry) => {
            claiming.add(entry.handle.id);
          });
          const guessed = await prefetch();
          const candidates = new SafeList();
          for (let i = 0; i < guessed.length; i++)
            if (!unused.has(keyOfPath(guessed[i])))
              candidates[candidates.length] = guessed[i];
          if (began !== cancelled)
            throw failure("EAGAIN", "directory open was cancelled while preparing");
          if (uncertain || outstanding() >= DIRECTORY_PREFETCH_LIMIT)
            await drain();
          const credit = mathMin(DIRECTORY_BATCH_LIMIT, DIRECTORY_PREFETCH_LIMIT - outstanding());
          if (credit <= 0)
            return null;
          const open = new SafeList();
          for (let i = -1; i < candidates.length && open.length < credit; i++)
            open[open.length] = i < 0 ? path : candidates[i];
          const opened = await exchange(open, true);
          const required = opened[0];
          if (!required)
            return null;
          for (let i = 1; i < opened.length; i++) {
            const entry = opened[i];
            const current2 = local(entry);
            if (entry.key !== null && entry.key !== required.key && current2 && asOpened(entry, current2.entry) && !unused.has(entry.key)) {
              retiring.delete(entry.handle.id);
              unused.set(entry.key, entry);
            }
          }
          return claim(required);
        }), void 0, (error) => {
          invalidate();
          const code = typeof error === "object" && error !== null ? ownField(error, "code") : void 0;
          if (!ended && (code === "ENOSPC" || code === "ESTALE")) {
            unavailable = true;
            return null;
          }
          throw error;
        });
      },
      owns: (id) => owned2.has(id),
      closed: (id) => retiring.has(id),
      local: (id) => {
        const entry = owned2.get(id);
        return entry ? local(entry) : null;
      },
      close(id, wait = true) {
        if (!owned2.delete(id))
          throw failure("EBADF", "directory description is not open");
        claiming.delete(id);
        retiring.add(id);
        if (wait && retiring.size >= DIRECTORY_PREFETCH_LIMIT)
          return serial(drain);
      },
      io() {
        trustedAtIo = owner !== null && client.readUnchanged(owner) && client.readTrusted();
      },
      invalidate: distrust,
      cancelPending() {
        cancelled++;
        distrust();
      },
      async dispose() {
        ended = true;
        cancelled++;
        owned2.forEach((_entry, id) => {
          retiring.add(id);
        });
        owned2.clear();
        claiming.clear();
        invalidate();
        if (sequence === 0)
          return;
        let timer = null;
        const ends = new SafeList();
        ends[0] = promiseThen(exchange([], false, true), () => {
        }, () => {
        });
        ends[1] = new PromiseConstructor((resolve) => {
          timer = setTimeout(resolve, endWaitMs);
        });
        await promiseRace(ends);
        clearTimeout(timer);
      }
    };
  }

  // ../core/dist/runtime/wasi/resident-filesystem.js
  var MAX_LISTINGS_PER_CALL = 64;
  var MAX_CATCH_UPS_PER_CALL = 3;
  var WALKED_DIRECTORIES = 1024;
  var READ_AHEAD_FIRST = 8;
  var READ_AHEAD_FILE_BYTES = 256 * 1024;
  var READ_AHEAD_PROCESS_BYTES = 32 * 1024 * 1024;
  function extensionOf(name) {
    const base = stringSlice(name, stringLastIndexOf(name, "/") + 1);
    const dot = stringLastIndexOf(base, ".");
    return dot > 0 ? stringSlice(base, dot) : "";
  }
  var DELEGATE = SymbolConstructor("delegate");
  var ROOT_FOR_WALK = { type: "directory", mode: 16877, uid: 0, gid: 0 };
  var PASSED_THROUGH = { type: "directory", mode: 16749, uid: 0, gid: 0 };
  var NAME_OR_ACCESS_CHANGES = new SafeSet([
    "chmod",
    "chown",
    "fchmod",
    "fchown",
    "rename",
    "unlink",
    "rmdir",
    "remove",
    "copyFile",
    "copyTree",
    "writeBatch",
    "writeStream"
  ]);
  var MUTATIONS = new SafeSet([
    "writeFile",
    "writeFileFrom",
    "writeRange",
    "truncate",
    "utimes",
    "chmod",
    "chown",
    "write",
    "close",
    "mkdir",
    "unlink",
    "rmdir",
    "rename",
    "symlink",
    "remove",
    "copyFile",
    "copyTree",
    "ftruncate",
    "fchmod",
    "fchown",
    "futimes",
    "writeBatch",
    "writeStream"
  ]);
  var DESCRIPTOR_CALLS = new SafeSet(["read", "write", "close", "fstat", "dup", "seek", "setStatus", "readdirHandle", "ftruncate", "fchmod", "fchown", "futimes", "fsync"]);
  var NOT_NOW = SymbolConstructor("not now");
  var REFUSED_ON_A_DIRECTORY = new SafeSet(["readFile", "readRange", "writeFile", "writeRange", "truncate", "unlink", "copyFile", "contentKey"]);
  var NAMESPACE_DEV = 0;
  function refusesADirectory(syscall, args) {
    if (syscall !== "open")
      return REFUSED_ON_A_DIRECTORY.has(syscall);
    const flags = args[1];
    return flags !== void 0 && refusesDirectory(flags);
  }
  var notNow = () => {
    throw NOT_NOW;
  };
  var CONTENT_READS = new SafeSet(["readFile", "read", "readRange"]);
  var ANSWERED_REFUSALS = new SafeSet(["ENOENT", "ENOTDIR", "EACCES", "EISDIR", "ELOOP", "EPERM"]);
  var NO_SYNCHRONOUS_FORM = new SafeSet(["synchronous", "subscribe", "writeStream", "writeBatch", "writeFileFrom", "acquire", "copyTree", "gateLaunch", "awaitRecall"]);
  function after2(value, next) {
    return value instanceof PromiseConstructor ? promiseThen(value, next) : next(value);
  }
  function climbs(path) {
    for (let at = 0; at + 1 < path.length; at++) {
      if (path[at] === "." && path[at + 1] === "." && (at === 0 || path[at - 1] === "/") && (at + 2 === path.length || path[at + 2] === "/"))
        return true;
    }
    return false;
  }
  var KEYS = new SafeMap();
  var KEYS_KEPT = 4096;
  function keyOf(path) {
    let key = KEYS.get(path);
    if (key !== void 0)
      return key;
    key = "";
    for (let from = 0, at = 0; at <= path.length; at++) {
      if (at < path.length && path[at] !== "/")
        continue;
      if (at > from && !(at === from + 1 && path[from] === "."))
        key = key === "" ? stringSlice(path, from, at) : key + "/" + stringSlice(path, from, at);
      from = at + 1;
    }
    if (KEYS.size >= KEYS_KEPT)
      KEYS.clear();
    KEYS.set(path, key);
    return key;
  }
  function prefixes(root, name) {
    const parts = new SafeList();
    const keys = new SafeList();
    const rooted = stringSplit(root, "/");
    const named = stringSplit(name, "/");
    for (let i = 0; i < rooted.length + named.length; i++) {
      const segment = i < rooted.length ? rooted[i] : named[i - rooted.length];
      if (segment === "" || segment === ".")
        continue;
      if (segment === "..")
        break;
      parts[parts.length] = segment;
      keys[keys.length] = arrayJoin(parts, "/");
    }
    return keys;
  }
  function parentKey5(key) {
    const at = stringLastIndexOf(key, "/");
    return at < 0 ? "" : stringSlice(key, 0, at);
  }
  function statOf(entry) {
    return {
      dev: entry.dev,
      ino: entry.ino,
      nlink: entry.nlink,
      type: entry.type,
      size: entry.size,
      ctime: entry.ctime,
      atime: entry.atime,
      mtime: entry.mtime,
      mode: entry.mode,
      uid: entry.uid,
      gid: entry.gid,
      revision: entry.revision
    };
  }
  var identity = (dev, ino) => `${dev}:${ino}`;
  function residentFilesystem(session, resident, delegation) {
    let directoryPool = null;
    const counts = { local: 0, delegated: {}, lookups: 0, listings: 0, treeListings: 0, fills: 0, filledBytes: 0, readAhead: 0, faultIns: 0, barriers: 0, barrierFailures: 0, leasedBarriers: 0, waitMs: 0, sessionCalls: 0, notResident: 0, pinnedBytes: 0, pins: 0, provisionalBytes: 0, pagedReads: 0, pagesFetched: 0 };
    let now = false;
    const begin = (io) => {
      if (now)
        throw NOT_NOW;
      counts.sessionCalls++;
      const value = io();
      if (!(value instanceof PromiseConstructor))
        return value;
      const started = dateNow();
      return promiseFinally(value, () => {
        counts.waitMs += dateNow() - started;
        directoryPool?.io();
      });
    };
    let holder = null;
    const residency = delegation === void 0 ? void 0 : ownValue(delegation, "residency");
    const authority = new Proxy2(session, {
      get(target, name, receiver) {
        const value = reflectGet(target, name, receiver);
        if (typeof value !== "function")
          return value;
        return (...args) => {
          if (now)
            throw NOT_NOW;
          if (typeof name === "string" && DESCRIPTOR_CALLS.has(name) && typeof args[0] === "number" && directoryPool?.closed(args[0])) {
            throw fsError2("EBADF", name, stringOf(args[0]));
          }
          for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (!arg || typeof arg !== "object" || !objectHasOwn(arg, "directory") || !objectHasOwn(arg, "path"))
              continue;
            const named = arg;
            if (typeof named.directory === "number" && typeof named.path === "string" && directoryPool?.closed(named.directory)) {
              throw fsError2("EBADF", stringOf(name), stringOf(named.directory));
            }
          }
          if (holder !== null && typeof name === "string" && NAME_OR_ACCESS_CHANGES.has(name))
            holder.changing();
          return holder !== null && holder.pending() ? begin(() => promiseThen(holder.send(), () => reflectApply(value, target, args))) : begin(() => reflectApply(value, target, args));
        };
      }
    });
    const store = {
      get device() {
        return resident.device;
      },
      get cred() {
        return resident.cred;
      },
      ready: () => resident.ready(),
      // What this process decided in a subtree it holds is what it sees there.
      entry: (key) => holder === null ? resident.entry(key) : holder.row(key),
      children: (key) => holder === null ? resident.children(key) : holder.children(key, resident.children(key)),
      list: (key) => begin(() => resident.list(key)),
      lookup: (keys, content) => begin(() => resident.lookup(keys, content)),
      listTree: (key) => begin(() => resident.listTree(key)),
      content: (key, revision) => resident.content(key, revision),
      fill: (key, entry) => begin(() => resident.fill(key, entry)),
      pages: (key, revision, size, first, last) => begin(() => resident.pages(key, revision, size, first, last)),
      fillMany: (files) => begin(() => resident.fillMany(files)),
      // A barrier that lands retires what this process changed and the session answered before it began:
      // a delivered answer's, when its arguments were built (acquireArgs); one this process did not build vouches for nothing.
      barrier: (options) => {
        const begun = holder?.barrierBegun();
        return promiseThen(begin(() => resident.barrier(options)), (result) => {
          const answered2 = options === void 0 ? void 0 : ownValue(options, "answer");
          const carried = options === void 0 ? void 0 : ownValue(options, "delivered");
          const from = answered2 ? void 0 : ownValue(result, "fromDelivery") ? carried === void 0 || carried === null ? void 0 : ownValue(carried.args, "begin") : begun;
          if (result.landed && typeof from === "number")
            holder?.retire(from);
          return result;
        });
      },
      acquireArgs: () => resident.acquireArgs(),
      ...ownValue(resident, "repairOwed") === void 0 ? {} : { repairOwed: () => ownValue(resident, "repairOwed")() },
      cursor: () => resident.cursor(),
      reserve: (bytes) => resident.reserve(bytes),
      release: (bytes) => resident.release(bytes)
    };
    const delegated = (name) => {
      counts.delegated[name] = (counts.delegated[name] ?? 0) + 1;
    };
    const owed = { input: 0, own: 0 };
    const caught = { input: 0, own: 0 };
    const owes = () => owed.input > caught.input || owed.own > caught.own;
    const catchUp = (given) => {
      const at = { input: owed.input, own: owed.own };
      const own = given === void 0 || given === null ? void 0 : ownValue(given.args, "own");
      const delivered = given && (typeof own === "number" ? owed.own <= own : owed.own <= caught.own) ? given : void 0;
      counts.barriers++;
      const client = holder?.client;
      const ask = client !== void 0 && (delegation === void 0 ? void 0 : ownValue(delegation, "readLeases"))?.() === true ? client.readLeaseAsk() : null;
      const lease = ask === null ? void 0 : { answered: (terms) => client.readLeaseAnswered(terms) };
      return promiseThen(store.barrier({ ...delivered ? { delivered } : {}, ...lease ? { lease } : {} }), (result) => {
        if (!result.landed || ownValue(result, "dropped") === true)
          counts.barrierFailures++;
        if (!result.landed || !store.ready())
          return false;
        const readLease = ownValue(result, "readLease");
        if (ask !== null && readLease && !ownValue(result, "fromDelivery"))
          client.readLeased(readLease, ask);
        caught.input = mathMax(caught.input, at.input);
        caught.own = mathMax(caught.own, ownValue(result, "fromDelivery") && typeof own === "number" ? own : at.own);
        return true;
      });
    };
    if (delegation !== void 0) {
      holder = delegationHolder({
        session: delegation.session,
        // The holder reads the store itself, its own decisions aside.
        store: {
          get device() {
            return resident.device;
          },
          get cred() {
            return resident.cred;
          },
          entry: (key) => resident.entry(key),
          children: (key) => resident.children(key),
          content: (key, revision) => resident.content(key, revision),
          reserve: (bytes) => resident.reserve(bytes),
          release: (bytes) => resident.release(bytes),
          ...ownValue(resident, "keep") === void 0 ? {} : { keep: (key, revision, bytes) => ownValue(resident, "keep")(key, revision, bytes) },
          mounted: (key) => walkedMounts && mountedName(key),
          unreported: (key) => walkedMounts && unreportedName(key)
        },
        isHomeRoot: ownValue(delegation, "isHomeRoot"),
        ...ownValue(delegation, "grantAfter") === void 0 ? {} : { grantAfter: ownValue(delegation, "grantAfter") },
        ...ownValue(delegation, "grantInos") === void 0 ? {} : { grantInos: ownValue(delegation, "grantInos") },
        ...ownValue(delegation, "journal") === void 0 ? {} : { journal: ownValue(delegation, "journal") },
        ...ownValue(delegation, "logged") === void 0 ? {} : { logged: ownValue(delegation, "logged") },
        ...ownValue(delegation, "umask") === void 0 ? {} : { umask: ownValue(delegation, "umask") },
        ...ownValue(delegation, "timers") === void 0 ? {} : { timers: ownValue(delegation, "timers") },
        ...ownValue(delegation, "now") === void 0 ? {} : { now: ownValue(delegation, "now") },
        // A call of the synchronous view decides what no held subtree does, provisionally.
        cannotWait: () => now,
        // What it sent changed the session: the store catches up before it answers next.
        sent: () => {
          owed.own++;
          directoryPool?.invalidate();
        }
      });
      const decisions = holder.provisional;
      ownValue(resident, "onAdmitted")?.((key, dev, ino) => {
        if (decisions.inode(dev, ino) === void 0)
          return;
        const entry = resident.entry(key);
        if (entry)
          decisions.admitted(key, entry);
      });
      if (ownValue(delegation, "readDirectories"))
        directoryPool = readDirectoryPool({
          call: (request) => {
            delegated("readDirectories");
            return begin(() => ownValue(delegation, "readDirectories")(request));
          },
          store,
          client: holder.client,
          before: async () => {
            if (holder?.pending())
              await holder.send();
          }
        });
    }
    const readers = new SafeSet();
    const readerKeys = new SafeMap();
    const unwritten = new SafeSet();
    const directories = new SafeMap();
    const paged = new SafeMap();
    const pins = new SafeMap();
    const walkOnce = (root, name, follow, crossed) => {
      const walk = walkBeneath(root, { root, path: name, beneath: true }, follow, store.cred, () => false);
      if (crossed !== void 0)
        crossed.length = 0;
      let passing = false;
      for (let step = walk.next(); ; ) {
        if (step.done)
          return step.value === null ? null : step.value.reached;
        const lookup = step.value;
        if (objectHasOwn(lookup, "readlink")) {
          const entry2 = store.entry(keyOf(lookup.readlink));
          if (!entry2 || entry2.type !== "symlink" || entry2.target === null)
            return DELEGATE;
          step = walk.next(entry2.target);
          continue;
        }
        const key = keyOf(lookup.stat);
        if (crossed !== void 0)
          crossed[crossed.length] = key;
        if (key === "") {
          step = walk.next(ROOT_FOR_WALK);
          continue;
        }
        const entry = store.entry(key);
        if (entry === void 0) {
          if (!walkedMounts || !(passing || mountedName(key)))
            return { missing: key };
          passing = true;
          step = walk.next(PASSED_THROUGH);
          continue;
        }
        if (entry !== null && entry.dev !== store.device && !answerable(key, entry))
          return DELEGATE;
        step = walk.next(entry === null ? null : { type: entry.type, mode: entry.mode, uid: entry.uid, gid: entry.gid });
      }
    };
    const directoryKey = (handleId) => {
      if (directoryPool?.owns(handleId))
        return directoryPool.local(handleId)?.key;
      const open = directories.get(handleId);
      if (open === void 0)
        return void 0;
      const entry = store.entry(open.key);
      return entry && entry.type === "directory" && entry.dev === open.dev && entry.ino === open.ino ? open.key : void 0;
    };
    const walkAfter = (key, within5, limit) => {
      const out = [];
      const subdirectories = (dir) => {
        const children = store.children(dir) ?? [];
        const directories2 = new SafeList();
        for (let i = 0; i < children.length; i++)
          if (children[i].type === "directory")
            directories2[directories2.length] = children[i];
        const ordered = byCodeUnit(directories2);
        const names2 = new SafeList();
        for (let i = 0; i < ordered.length; i++)
          names2[i] = dir === "" ? ordered[i].name : `${dir}/${ordered[i].name}`;
        return names2;
      };
      const descend = (dir) => {
        const children = subdirectories(dir);
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          if (out.length >= limit)
            return;
          out[out.length] = child;
          descend(child);
        }
      };
      descend(key);
      for (let at = key; at !== within5 && out.length < limit; at = parentKey5(at)) {
        const name = stringSlice(at, stringLastIndexOf(at, "/") + 1);
        const siblings = subdirectories(parentKey5(at));
        for (let i = 0; i < siblings.length; i++) {
          const sibling = siblings[i];
          if (out.length >= limit)
            break;
          if (stringSlice(sibling, stringLastIndexOf(sibling, "/") + 1) <= name)
            continue;
          out[out.length] = sibling;
          descend(sibling);
        }
      }
      return out;
    };
    let walkRoot = null;
    const opening = [];
    const previous = (delegation === void 0 ? void 0 : ownValue(delegation, "walked")) ?? [];
    let along = 0;
    const repeated = (key, limit) => {
      const at = arrayIndexOf(previous, key, along);
      if (at < 0)
        return [];
      along = at + 1;
      const next = new SafeList();
      for (let i = at + 1; i < previous.length && i < at + 1 + limit; i++)
        next[next.length] = previous[i];
      return next;
    };
    const missesIn = new SafeMap();
    const miss = (dir) => {
      const misses = (missesIn.get(dir) ?? 0) + 1;
      missesIn.set(dir, misses);
      return misses;
    };
    const unlistable = new SafeSet();
    const foundIn = new SafeMap();
    const fetchingAhead = new SafeMap();
    let readAheadBytes = 0;
    const readAhead = (key, entry) => {
      const dir = parentKey5(key);
      const misses = miss(dir);
      const ext = extensionOf(key);
      const children = store.children(dir);
      if (misses < 2 || ext === "" || children === void 0)
        return void 0;
      const window = READ_AHEAD_FIRST * 2 ** mathMin(misses - 2, 7);
      const name = stringSlice(key, stringLastIndexOf(key, "/") + 1);
      const batch = [[key, entry]];
      let bytes = entry.size;
      const files = new SafeList();
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.type === "file" && child.name !== name && extensionOf(child.name) === ext)
          files[files.length] = child;
      }
      const ordered = byCodeUnit(files);
      let at = 0;
      while (at < ordered.length && !(ordered[at].name > name))
        at++;
      if (at === ordered.length)
        at = 0;
      for (let n = 0; n < ordered.length; n++) {
        const child = ordered[(at + n) % ordered.length];
        if (batch.length > window || batch.length >= FS_READ_BATCH_PATH_LIMIT)
          break;
        const sibling = dir === "" ? child.name : `${dir}/${child.name}`;
        if (fetchingAhead.has(sibling))
          continue;
        const found = entryAt(sibling);
        if (!found || found.type !== "file" || found.size > READ_AHEAD_FILE_BYTES || store.content(sibling, found.revision) !== void 0)
          continue;
        if (holder?.content(found) !== void 0 || holder?.provisional.pending(found.dev, found.ino))
          continue;
        if (bytes + found.size > FS_READ_BATCH_REQUEST_BYTES || readAheadBytes + bytes + found.size > READ_AHEAD_PROCESS_BYTES)
          break;
        batch[batch.length] = [sibling, found];
        bytes += found.size;
      }
      if (batch.length === 1)
        return void 0;
      readAheadBytes += bytes - entry.size;
      counts.fills += batch.length;
      counts.filledBytes += bytes;
      counts.readAhead += batch.length - 1;
      const fetched = promiseThen(store.fillMany(batch), void 0, () => {
      });
      for (let i = 0; i < batch.length; i++)
        fetchingAhead.set(batch[i][0], fetched);
      void promiseThen(fetched, () => {
        for (let i = 0; i < batch.length; i++)
          if (fetchingAhead.get(batch[i][0]) === fetched)
            fetchingAhead.delete(batch[i][0]);
      });
      return fetched;
    };
    let faults = null;
    let faulted = promiseResolve();
    const faulting = new SafeSet();
    const outstanding = (fetch) => {
      faulting.add(fetch);
      void promiseThen(fetch, () => {
        faulting.delete(fetch);
      });
      return fetch;
    };
    const faultsEnded = async () => {
      while (faulting.size > 0)
        await promiseAll(setList(faulting));
    };
    let refusedFetch = null;
    const faultIn = (key, entry) => {
      if (residency === void 0)
        return null;
      const held = () => {
        const bytes = store.content(key, entry.revision);
        return bytes !== void 0 && bytes.length === entry.size;
      };
      const out = fetchingAhead.get(key);
      if (out !== void 0)
        return outstanding(promiseThen(out, held));
      const speculation = residency.speculation();
      if (speculation !== null && !speculation.charge(entry.size))
        return null;
      let files = faults;
      if (files === null) {
        const named = [];
        files = faults = named;
        faulted = outstanding(promiseThen(promiseThen(promiseResolve(), () => {
          faults = null;
          return store.fillMany(named);
        }), void 0, () => {
        }));
      }
      const batch = faulted;
      files[files.length] = [key, entry];
      counts.fills++;
      counts.faultIns++;
      counts.filledBytes += entry.size;
      fetchingAhead.set(key, batch);
      void promiseThen(batch, () => {
        if (fetchingAhead.get(key) === batch)
          fetchingAhead.delete(key);
      });
      return outstanding(promiseThen(batch, held));
    };
    const resolve = (path, follow, content = false, crossed) => {
      let root;
      let name;
      if (typeof path === "string") {
        if (climbs(path))
          return DELEGATE;
        root = "";
        name = keyOf(path);
      } else if (objectHasOwn(path, "root")) {
        root = keyOf(path.root);
        name = path.path;
      } else {
        const key = directoryKey(path.directory);
        if (key === void 0)
          return DELEGATE;
        root = key;
        name = path.path;
      }
      let looked;
      let caughtUps = 0;
      const attempt = (asked) => {
        if (!store.ready())
          return DELEGATE;
        if (owes() && !now)
          return ++caughtUps > MAX_CATCH_UPS_PER_CALL ? DELEGATE : promiseThen(catchUp(), (ok) => ok ? attempt(asked) : DELEGATE);
        const walked = walkOnce(root, name, follow, crossed);
        if (walked === null || walked === DELEGATE || typeof walked === "string")
          return walked;
        if (now)
          notNow();
        if (asked >= MAX_LISTINGS_PER_CALL)
          return DELEGATE;
        const parent = parentKey5(walked.missing);
        if (miss(parent) >= 2 && parent !== "" && store.children(parent) === void 0) {
          const walking = foundIn.get(parent) === true && !unlistable.has(parent);
          const whole = walking ? (counts.treeListings++, store.listTree(parent)) : promiseResolve(false);
          return promiseThen(promiseThen(whole, (listed) => {
            if (listed)
              return true;
            if (walking)
              unlistable.add(parent);
            counts.listings++;
            return store.list(parent);
          }), (listed) => listed ? attempt(asked + 1) : DELEGATE);
        }
        if (looked === void 0 || !looked.has(walked.missing)) {
          looked ??= new SafeSet();
          const named = prefixes(root, name);
          const spelled = new SafeList();
          for (let i = 0; i < named.length; i++)
            if (!looked.has(named[i]) && store.entry(named[i]) === void 0)
              spelled[spelled.length] = named[i];
          const keys = new SafeList();
          const from = arrayIndexOf(spelled, walked.missing);
          if (from < 0)
            keys[0] = walked.missing;
          else
            for (let i = from; i < spelled.length; i++)
              keys[keys.length] = spelled[i];
          for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            looked.add(key);
          }
          counts.lookups++;
          const target = spelled[spelled.length - 1];
          return promiseThen(store.lookup(keys, content && keys[keys.length - 1] === target), (known) => {
            if (known)
              foundIn.set(parent, !!store.entry(walked.missing));
            return known ? attempt(asked + 1) : DELEGATE;
          });
        }
        counts.listings++;
        return promiseThen(store.list(parentKey5(walked.missing)), (listed) => listed ? attempt(asked + 1) : DELEGATE);
      };
      return attempt(0);
    };
    const entryAt = (key) => {
      const entry = store.entry(key);
      if (entry === void 0)
        return void 0;
      if (entry !== null && entry.dev !== store.device && !answerable(key, entry))
        return void 0;
      return entry;
    };
    const answerable = (key, entry) => fedRow(key, entry) === true || walkedMounts && now;
    const walkedMounts = (delegation === void 0 ? void 0 : ownValue(delegation, "walkedMounts")) === true;
    const answeredWrites = (delegation === void 0 ? void 0 : ownValue(delegation, "answeredWrites")) === true;
    const fedRow = (key, entry) => {
      const cursor = store.cursor();
      if (cursor === null)
        return false;
      if (entry.type === "directory" && entry.dev === NAMESPACE_DEV && abovePoint(cursor, key))
        return true;
      const at = feedPointOf(cursor, key);
      if (at === ROOT_FEED)
        return void 0;
      const point = stringSlice(at, 1);
      const root = point === key ? entry : store.entry(point);
      if (root === void 0 || root === null || root.dev !== entry.dev)
        return void 0;
      const feed = feedOf(cursor, at);
      return !((feed === void 0 ? void 0 : ownValue(feed, "fixed")) !== true && holder?.client.readTrusted() === true);
    };
    const nearestRow = (key) => {
      const own = store.entry(key);
      if (own)
        return { key, row: own };
      const parent = parentKey5(key);
      const above = key === "" ? void 0 : store.entry(parent);
      return above ? { key: parent, row: above } : void 0;
    };
    const mountedName = (key) => {
      if (onMount(key))
        return true;
      const near = nearestRow(key);
      return near !== void 0 && near.row.dev !== store.device && near.row.dev !== NAMESPACE_DEV;
    };
    const unreportedName = (key) => {
      const near = nearestRow(key);
      return near !== void 0 && near.row.dev !== store.device && near.row.dev !== NAMESPACE_DEV && fedRow(near.key, near.row) === void 0;
    };
    const onKernelMount = (key) => {
      const cursor = store.cursor();
      if (cursor === null)
        return false;
      const at = feedPointOf(cursor, key);
      const feed = at === ROOT_FEED ? void 0 : feedOf(cursor, at);
      return feed !== void 0 && ownValue(feed, "fixed") === true;
    };
    const onMount = (key) => {
      const cursor = store.cursor();
      return cursor !== null && feedPointOf(cursor, key) !== ROOT_FEED;
    };
    const ownEntryAt = (key) => {
      const entry = entryAt(key);
      if (entry === void 0)
        return void 0;
      if (walkedMounts)
        return onKernelMount(key) ? void 0 : entry;
      return (entry === null ? onMount(key) : entry.dev !== store.device) ? void 0 : entry;
    };
    const volatileProc = (key, entry) => {
      if (entry.type !== "file" || entry.size !== 0)
        return false;
      const cursor = store.cursor();
      return cursor !== null && feedPointOf(cursor, key) === PROC_MOUNT_POINT;
    };
    const generated = (key) => {
      const generate = procFileGenerator(stringSlice("/" + key, PROC_MOUNT_POINT.length + 1));
      if (generate === void 0)
        return void 0;
      const content = generate({ ...store.cred, umask: 0 });
      return typeof content === "string" ? new TextEncoder().encode(content) : bytesCopy(content);
    };
    const contentOf = (key, entry) => {
      const decided = holder?.content(entry);
      if (decided !== void 0)
        return decided;
      if (holder?.provisional.pending(entry.dev, entry.ino))
        return void 0;
      const keep = (bytes) => bytes === null || bytes === void 0 || bytes.length !== entry.size ? void 0 : bytes;
      const held = store.content(key, entry.revision);
      if (held !== void 0 && held.length === entry.size)
        return held;
      if (now) {
        refusedFetch = faultIn(key, entry);
        notNow();
      }
      const fill = () => {
        counts.fills++;
        counts.filledBytes += entry.size;
        return promiseThen(store.fill(key, entry), keep);
      };
      const batch = fetchingAhead.get(key) ?? readAhead(key, entry);
      if (batch === void 0)
        return fill();
      return promiseThen(batch, () => {
        const fetched = store.content(key, entry.revision);
        return fetched !== void 0 && fetched.length === entry.size ? fetched : fill();
      });
    };
    const wholeByPages = (key, entry) => {
      if (entry.size <= FS_READ_BATCH_REQUEST_BYTES)
        return DELEGATE;
      return promiseThen(store.pages(key, entry.revision, entry.size, 0, mathFloor((entry.size - 1) / RESIDENT_PAGE_BYTES)), (found) => {
        if (found === null)
          return DELEGATE;
        counts.pagedReads++;
        counts.pagesFetched += found.fetched;
        const whole = new Uint8ArrayConstructor(entry.size);
        for (let at = 0; at < found.pages.length; at++)
          typedArraySet(whole, found.pages[at], at * RESIDENT_PAGE_BYTES);
        return whole;
      });
    };
    const answer = (name, local, remote, caughtUps = 0) => {
      const settle = (value) => {
        if (value !== DELEGATE) {
          counts.local++;
          return value;
        }
        delegated(name);
        return remote();
      };
      if (!store.ready()) {
        delegated(name);
        return remote();
      }
      if (owes() && !now) {
        if (caughtUps >= MAX_CATCH_UPS_PER_CALL) {
          delegated(name);
          return remote();
        }
        return promiseThen(catchUp(), (ok) => {
          if (ok)
            return answer(name, local, remote, caughtUps + 1);
          delegated(name);
          return remote();
        });
      }
      return after2(local(), settle);
    };
    const caughtUpFor = (then, caughtUps = 0) => {
      if (now || !owes() || caughtUps >= MAX_CATCH_UPS_PER_CALL)
        return then();
      return new PromiseConstructor((resolve2, reject) => {
        promiseThen(catchUp(), (ok) => resolve2(ok ? caughtUpFor(then, caughtUps + 1) : then()), reject);
      });
    };
    const decide = (local) => {
      if (holder === null || !store.ready())
        return DELEGATE;
      return after2(local(), (value) => {
        if (value !== DELEGATE)
          counts.local++;
        return value;
      });
    };
    const walkFor = (path, follow) => {
      const crossed = [];
      return after2(resolve(path, follow, false, crossed), (key) => {
        if (key === null)
          throw fsError2("ELOOP", "open", pathOf(path));
        return typeof key === "string" && key !== "" ? { key, crossed } : DELEGATE;
      });
    };
    const decidable = (key, ...walks) => {
      if (onMount(key))
        return false;
      if (holder.client.held(key) === void 0)
        return true;
      const cursor = store.cursor();
      for (let i = 0; i < walks.length; i++) {
        const crossed = walks[i].crossed;
        for (let j = 0; j < crossed.length; j++) {
          const name = crossed[j];
          if (holder.entry(name) === void 0 && (cursor === null || holder.client.certifies(name, rootOf(cursor)) === void 0))
            return false;
        }
      }
      return true;
    };
    const changing = (name, call) => {
      if (now)
        throw NOT_NOW;
      directoryPool?.invalidate();
      delegated(name);
      try {
        return after2(call(), (value) => {
          owed.own++;
          return value;
        });
      } catch (error) {
        owed.own++;
        throw error;
      }
    };
    const shown = (change) => holder === null ? change : after2(change, (value) => store.ready() ? promiseThen(catchUp(), () => value, () => value) : value);
    const fs = objectCreate(null);
    const names = new SafeSet();
    for (let at = session; at !== null && at !== ObjectPrototype; at = reflectGetPrototypeOf(at)) {
      const keys = reflectOwnKeys(at);
      for (let i = 0; i < keys.length; i++) {
        const name = keys[i];
        if (typeof name === "string" && name !== "constructor")
          names.add(name);
      }
    }
    names.forEach((name) => {
      const value = reflectGet(authority, name);
      if (typeof value !== "function")
        return;
      const call = (args) => reflectApply(value, authority, args);
      const mutates = MUTATIONS.has(name);
      reflectSet(fs, name, mutates ? DESCRIPTOR_CALLS.has(name) ? (...args) => changing(name, () => call(args)) : (...args) => shown(changing(name, () => call(args))) : (...args) => {
        if (now)
          throw NOT_NOW;
        delegated(name);
        return call(args);
      });
    });
    fs.inbound = () => {
      owed.input++;
      directoryPool?.invalidate();
    };
    fs.catchUp = async (options = {}) => {
      fs.inbound();
      const delivered = ownValue(options, "delivered");
      if (ownValue(options, "viaIo") === true && !delivered && owed.own <= caught.own && holder?.client.readTrusted() === true && store.ready() && ownValue(store, "repairOwed")?.() !== true) {
        counts.leasedBarriers++;
        return;
      }
      await catchUp(delivered);
    };
    fs.acquireArgs = () => {
      const args = store.acquireArgs();
      return args === null ? null : { ...args, begin: holder?.barrierBegun() ?? 0, own: owed.own };
    };
    fs.cancelPendingDirectories = () => {
      owed.input++;
      directoryPool?.cancelPending();
    };
    fs.holding = () => holder?.pending() ?? false;
    fs.decidedAt = (path) => holder !== null && holder.provisional.touches(keyOf(path));
    reflectDefineProperty(fs, "client", dataDescriptor(holder?.client ?? null, false, true, false));
    fs.logHeld = () => holder?.logHeld();
    fs.flush = async () => {
      await holder?.flush();
    };
    fs.send = async () => {
      await holder?.send();
    };
    fs.settle = async () => {
      const failures = [];
      await faultsEnded();
      const endings = new SafeList();
      endings[0] = directoryPool?.dispose();
      endings[1] = holder?.settle();
      const ended = new SafeList();
      for (let i = 0; i < endings.length; i++) {
        ended[i] = promiseThen(promiseResolve(endings[i]), void 0, (error) => {
          failures[failures.length] = { path: "/", dev: 0, ino: 0, error };
        });
      }
      await promiseAll(ended);
      return failures;
    };
    fs.syncInode = () => holder?.flush();
    fs.walked = () => opening;
    const pinnedTotal = () => {
      let total = 0;
      pins.forEach((pin) => {
        total += pin.bytes.length;
      });
      return total;
    };
    fs.stats = () => ({
      ...counts,
      delegated: { ...counts.delegated },
      pins: pins.size,
      pinnedBytes: pinnedTotal(),
      provisionalBytes: holder?.provisional.kept() ?? 0,
      ...holder === null ? {} : { client: holder.client.stats() }
    });
    fs.stat = (path, options = {}) => answer("stat", () => {
      const follow = options.followSymlinks !== false;
      const finish = (key) => {
        if (key === DELEGATE)
          return DELEGATE;
        if (key === null)
          throw fsError2("ELOOP", follow ? "stat" : "lstat", path);
        const entry = entryAt(key);
        if (entry === void 0)
          return DELEGATE;
        return entry === null ? null : statOf(entry);
      };
      const absent = (error) => {
        if (typeof error === "object" && error !== null && ownField(error, "code") === "ENOENT")
          return null;
        throw error;
      };
      try {
        const resolved = resolve(path, follow, true);
        return resolved instanceof PromiseConstructor ? promiseThen(resolved, finish, absent) : finish(resolved);
      } catch (error) {
        return absent(error);
      }
    }, () => authority.stat(path, options));
    fs.pinContent = (path, stat) => answer("pinContent", () => after2(resolve(path, true, true), (key) => {
      if (key === DELEGATE || key === "" || key === null)
        return null;
      const entry = entryAt(key);
      if (!entry || entry.type !== "file" || entry.dev !== stat.dev || entry.ino !== stat.ino || entry.size > WASI_RESIDENT_FILE_CAP_BYTES)
        return null;
      if (isCharacterDevice(entry.mode) || volatileProc(key, entry))
        return null;
      if (!modeAllows(entry, 4, store.cred))
        return null;
      if (holder?.provisional.pending(entry.dev, entry.ino) || entry.revision !== stat.revision)
        return null;
      const pinKey = `${identity(entry.dev, entry.ino)}:${entry.revision}`;
      const pinned = (pin) => {
        pin.holders++;
        let released = false;
        return {
          bytes: pin.bytes,
          name: "/" + key,
          release: () => {
            if (released)
              return;
            released = true;
            if (--pin.holders > 0)
              return;
            pins.delete(pinKey);
            store.release(pin.bytes.length);
          }
        };
      };
      const existing = pins.get(pinKey);
      if (existing !== void 0)
        return pinned(existing);
      return after2(contentOf(key, entry), (bytes) => {
        if (bytes === void 0 || !store.reserve(bytes.length))
          return null;
        const pin = { bytes, holders: 0 };
        pins.set(pinKey, pin);
        return pinned(pin);
      });
    }), () => null);
    fs.readFile = (path, options = {}) => answer("readFile", () => after2(resolve(path, options.followSymlinks !== false, true), (key) => {
      if (key === DELEGATE)
        return DELEGATE;
      if (key === null)
        return null;
      const entry = entryAt(key);
      if (entry === void 0)
        return DELEGATE;
      if (entry === null)
        return null;
      if (!modeAllows(entry, 4, store.cred))
        throw fsError2("EACCES", "open", path);
      if (entry.type === "directory")
        throw fsError2("EISDIR", "open", path);
      if (entry.type !== "file" || isCharacterDevice(entry.mode))
        return DELEGATE;
      if (volatileProc(key, entry))
        return generated(key) ?? DELEGATE;
      return after2(contentOf(key, entry), (bytes) => bytes ?? (holder?.provisional.pending(entry.dev, entry.ino) ? DELEGATE : wholeByPages(key, entry)));
    }), () => authority.readFile(path, options));
    fs.readdir = (path, options = {}) => answer("readdir", () => after2(resolve(path, options.followSymlinks !== false), (key) => {
      if (key === DELEGATE || key === null)
        return DELEGATE;
      const entry = entryAt(key);
      if (entry === void 0 || entry === null)
        return DELEGATE;
      if (entry.type !== "directory")
        return DELEGATE;
      if (!modeAllows(entry, 4, store.cred))
        return DELEGATE;
      return after2(listingOf(key), (entries) => entries === DELEGATE ? DELEGATE : arrayCopy(byLocale(entries)));
    }), () => authority.readdir(path, options));
    const listingOf = (key) => {
      const known = store.children(key);
      if (known !== void 0)
        return known;
      if (now)
        notNow();
      counts.treeListings++;
      return promiseThen(promiseThen(store.listTree(key), (whole) => whole ? true : store.list(key)), (listed) => {
        const children = listed && !owes() ? store.children(key) : void 0;
        return children === void 0 ? DELEGATE : children;
      });
    };
    const listCopy = (entries) => {
      const copy = new SafeList();
      for (let i = 0; i < entries.length; i++)
        copy[i] = entries[i];
      return copy;
    };
    const byLocale = (entries) => arraySort(listCopy(entries), (a, b) => stringLocaleCompare(a.name, b.name));
    const byCodeUnit = (entries) => arraySort(listCopy(entries), (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    fs.readlink = (path) => answer("readlink", () => after2(resolve(path, false), (key) => {
      if (key === DELEGATE)
        return DELEGATE;
      if (key === null)
        return null;
      const entry = entryAt(key);
      if (entry === void 0)
        return DELEGATE;
      return entry !== null && entry.type === "symlink" && entry.target !== null ? entry.target : null;
    }), () => authority.readlink(path));
    fs.realpath = (path) => answer("realpath", () => after2(resolve(path, true), (key) => {
      if (key === DELEGATE)
        return DELEGATE;
      if (key === null)
        throw fsError2("ELOOP", "realpath", path);
      const entry = entryAt(key);
      if (entry === void 0)
        return DELEGATE;
      if (entry === null)
        throw fsError2("ENOENT", "realpath", path);
      return "/" + key;
    }), () => authority.realpath(path));
    const identified = (handleId, syscall) => {
      const entry = holder.fstat(handleId);
      if (entry !== void 0)
        return entry;
      if (now)
        notNow();
      throw notResident(syscall, [handleId]);
    };
    const heldOpen = (handle) => ({ ...handle, stat: statOf(identified(handle.id, "open")) });
    fs.access = (path, mode) => answer("access", () => after2(resolve(path, true), (key) => {
      if (key === DELEGATE)
        return DELEGATE;
      if (key === null)
        throw fsError2("ELOOP", "access", path);
      const entry = entryAt(key);
      if (entry === void 0)
        return DELEGATE;
      if (entry === null)
        throw fsError2("ENOENT", "access", path);
      if (!modeAllows(entry, mode, store.cred))
        throw fsError2("EACCES", "access", path);
      return void 0;
    }), () => authority.access(path, mode));
    fs.open = (path, flags) => {
      const readOnly = !flags.write && !flags.create && !flags.truncate && !flags.append && !flags.exclusive;
      if (directoryPool && !now && readOnly && flags.read === true && flags.directory === true && flags.followSymlinks !== false && flags.expectedRevision === void 0) {
        return answer("open", () => after2(resolve(path, true), async (key) => {
          if (key === DELEGATE || key === null || key === "" || entryAt(key)?.type !== "directory")
            return DELEGATE;
          if (walkRoot === null || key !== walkRoot && !stringStartsWith(key, walkRoot + "/"))
            walkRoot = key;
          const within5 = walkRoot;
          const walking = opening.length > 0;
          if (opening.length < WALKED_DIRECTORIES)
            opening[opening.length] = key;
          const handle = await directoryPool.open(path, key, async () => {
            const guessed = repeated(key, DIRECTORY_BATCH_LIMIT - 1);
            if (!walking && guessed.length === 0)
              return [];
            await listingOf(key);
            const named = new SafeSet();
            const ordered = new SafeList();
            const after3 = walkAfter(key, within5, DIRECTORY_BATCH_LIMIT - 1);
            for (let i = 0; i < guessed.length + after3.length; i++) {
              const candidate = i < guessed.length ? guessed[i] : after3[i - guessed.length];
              if (!named.has(candidate)) {
                named.add(candidate);
                ordered[ordered.length] = candidate;
              }
            }
            const limit = DIRECTORY_BATCH_LIMIT - 1;
            const beneath = (base) => {
              const under2 = new SafeList();
              for (let i = 0; i < ordered.length && under2.length < limit; i++)
                if (base === "" || stringStartsWith(ordered[i], base + "/"))
                  under2[under2.length] = ordered[i];
              return under2;
            };
            const candidates = new SafeList();
            if (typeof path === "string") {
              for (let i = 0; i < ordered.length && i < limit; i++)
                candidates[i] = "/" + ordered[i];
              return candidates;
            }
            if (objectHasOwn(path, "directory")) {
              const base = path.path !== "" && path.path[path.path.length - 1] === "/" ? stringSlice(path.path, 0, path.path.length - 1) : path.path;
              const under2 = beneath(key);
              for (let i = 0; i < under2.length; i++)
                candidates[i] = { ...path, path: (base === "" ? "" : base + "/") + stringSlice(under2[i], key.length + 1) };
              return candidates;
            }
            const root = keyOf(path.root);
            const under = beneath(root);
            for (let i = 0; i < under.length; i++)
              candidates[i] = { ...path, path: root === "" ? under[i] : stringSlice(under[i], root.length + 1) };
            return candidates;
          });
          if (handle === null)
            return DELEGATE;
          return { ...handle, stat: await fs.fstat(handle.id) };
        }), () => openOnSession(path, flags));
      }
      if (!readOnly && holder !== null) {
        const local = decide(() => after2(walkFor(path, openFollows(openFlags(flags))), (walk) => walk === DELEGATE || !decidable(walk.key, walk) ? DELEGATE : after2(holder.open(walk.key, typeof path === "string" ? path : path.path, flags), (handle) => handle === void 0 ? DELEGATE : heldOpen(handle))));
        return after2(local, (handle) => handle === DELEGATE ? openOnSession(path, flags) : handle);
      }
      return openOnSession(path, flags);
    };
    const provisionally = (path, follow, decided) => {
      if (holder === null || !store.ready())
        throw NOT_NOW;
      const walk = walkFor(path, follow);
      if (walk === DELEGATE || walk instanceof PromiseConstructor)
        throw NOT_NOW;
      const row = ownEntryAt(walk.key);
      if (row === void 0)
        throw NOT_NOW;
      const done = decided(walk.key, row);
      if (done === false || done === void 0)
        throw NOT_NOW;
      counts.local++;
      return done;
    };
    const decidedThenSent = (decided, session2) => {
      if (now || holder === null)
        return session2();
      let value;
      try {
        value = decided();
      } catch {
        return session2();
      }
      return shown(promiseThen(holder.flush(), () => value));
    };
    const ownChange = (keys, decided, session2) => {
      const rows = new SafeList();
      let known = true;
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        rows[i] = key === void 0 || !store.ready() ? void 0 : ownEntryAt(key);
        if (rows[i] === void 0)
          known = false;
      }
      const placed = known ? rows : void 0;
      if (now) {
        if (placed === void 0 || decided(placed, false) === false)
          throw NOT_NOW;
        counts.local++;
        return void 0;
      }
      let undecided = placed !== void 0;
      for (let i = 0; undecided && i < keys.length; i++)
        undecided = !holder.holds(keys[i]) || holder.provisional.touches(keys[i]);
      if (undecided && placed !== void 0) {
        let answer2;
        try {
          let holds = false;
          for (let i = 0; !holds && i < keys.length; i++)
            holds = holder.holds(keys[i]);
          answer2 = decided(placed, !holds);
        } catch {
          return session2();
        }
        if (answer2 !== false) {
          counts.local++;
          return after2(answer2, () => void 0);
        }
      }
      return session2();
    };
    const openByNumber = (path, flags) => {
      if (flags.directory)
        throw NOT_NOW;
      return heldOpen(provisionally(path, openFollows(openFlags(flags)), (key, row) => holder.provisional.open(key, pathOf(path), flags, row)));
    };
    const readOwn = (handleId, offset, length) => {
      const desc = holder.provisional.descriptor(handleId);
      if (!now && ownValue(desc.inode, "cell") === void 0 && holder.provisional.sessionOf(handleId, "read") !== void 0 && (ownValue(desc, "description") !== void 0 || holder.provisional.inodeOf(handleId) === void 0))
        return readByAnchor(handleId, offset, length);
      const read = () => holder.read(handleId, offset, length);
      let done;
      try {
        done = read();
      } catch (error) {
        if (now || (typeof error === "object" && error !== null ? ownField(error, "code") : void 0) !== "ESTALE")
          throw error;
        return readByAnchor(handleId, offset, length);
      }
      if (done !== void 0)
        return done;
      if (now) {
        const of = holder.provisional.inodeOf(handleId);
        if (of !== void 0 && !holder.provisional.pending(of.entry.dev, of.entry.ino))
          refusedFetch = faultIn(of.key, of.entry);
        throw NOT_NOW;
      }
      const at = holder.provisional.inodeOf(handleId);
      if (at === void 0)
        return readByAnchor(handleId, offset, length);
      return promiseThen(promiseResolve(contentOf(at.key, at.entry)), () => read() ?? readByAnchor(handleId, offset, length), (error) => {
        if (holder.provisional.sessionOf(handleId, "read") === void 0)
          throw error;
        return readByAnchor(handleId, offset, length);
      });
    };
    const statByAnchor = async (handleId) => {
      const key = holder.keyOf(handleId);
      await holder.send();
      const session2 = holder.provisional.sessionOf(handleId);
      if (session2 === void 0)
        throw fsError2("ESTALE", "fstat", "/" + key);
      delegated("fstat");
      return authority.fstat(session2);
    };
    const readByAnchor = async (handleId, offset, length) => {
      const desc = holder.provisional.descriptor(handleId);
      if (!desc.read)
        throw fsError2("EBADF", "read", desc.path);
      const key = holder.keyOf(handleId);
      await holder.send();
      const session2 = holder.provisional.sessionOf(handleId, "read");
      if (session2 === void 0)
        throw fsError2("ESTALE", "read", "/" + key);
      const start = offset ?? holder.seek(handleId, 0, "current");
      delegated("read");
      const chunk = await authority.read(session2, start, length);
      if (offset === null)
        holder.seek(handleId, start + chunk.length, "set");
      return chunk;
    };
    const openOnSession = (path, flags) => {
      if (now)
        return openByNumber(path, flags);
      const readOnly = !flags.write && !flags.create && !flags.truncate && !flags.append && !flags.exclusive;
      if (!readOnly) {
        const through = () => {
          if (holder === null || !store.ready() || flags.directory)
            return DELEGATE;
          return after2(walkFor(path, openFollows(openFlags(flags))), (walk) => {
            if (walk === DELEGATE)
              return DELEGATE;
            const there = ownEntryAt(walk.key);
            if (there === void 0 || there?.type === "directory")
              return DELEGATE;
            const opened = holder.provisional.open(walk.key, pathOf(path), flags, there, true);
            if (opened === void 0)
              return DELEGATE;
            counts.local++;
            const desc = holder.provisional.descriptor(opened.id);
            const opening2 = desc === void 0 ? void 0 : ownValue(desc, "opening");
            if (opening2 === void 0)
              return heldOpen(opened);
            return promiseThen(opening2, () => heldOpen(opened), (error) => {
              holder.provisional.abandon(opened.id);
              throw error;
            });
          });
        };
        return after2(through(), (handle) => {
          if (handle !== DELEGATE)
            return handle;
          if (flags.create || flags.truncate)
            return shown(changing("open", () => authority.open(path, flags)));
          delegated("open");
          return after2(authority.open(path, flags), (opened) => {
            unwritten.add(opened.id);
            return opened;
          });
        });
      }
      delegated("open");
      return after2(authority.open(path, flags), (handle) => {
        readers.add(handle.id);
        if (residency !== void 0)
          readerKeys.set(handle.id, keyOf(handle.path));
        const { type, dev, ino, size } = handle.stat;
        if (dev === store.device) {
          const key = keyOf(handle.path);
          if (type === "directory")
            directories.set(handle.id, { key, dev, ino });
          else if (type === "file" && size > WASI_RESIDENT_FILE_CAP_BYTES)
            paged.set(handle.id, { key, dev, ino });
        }
        return handle;
      });
    };
    fs.fstat = (handleId) => {
      if (directoryPool?.owns(handleId))
        return answer("fstat", () => {
          const current = directoryPool.local(handleId);
          return current ? statOf(current.entry) : DELEGATE;
        }, () => authority.fstat(handleId));
      if (holder?.owns(handleId))
        return caughtUpFor(() => {
          if (!now && ownValue(holder.provisional.descriptor(handleId).inode, "cell") === void 0 && holder.provisional.sessionOf(handleId) !== void 0)
            return statByAnchor(handleId);
          const entry = identified(handleId, "fstat");
          counts.local++;
          return statOf(entry);
        });
      delegated("fstat");
      return authority.fstat(handleId);
    };
    fs.read = (handleId, offset, length) => {
      if (holder?.owns(handleId))
        return caughtUpFor(() => {
          counts.local++;
          return readOwn(handleId, offset, length);
        });
      const file = paged.get(handleId);
      if (file !== void 0 && offset !== null && length > 0) {
        return answer("read", () => after2(resolve("/" + file.key, false), (resolved) => {
          const now2 = resolved === DELEGATE ? void 0 : entryAt(file.key);
          if (now2 === void 0 || now2 === null || now2.type !== "file" || now2.dev !== file.dev || now2.ino !== file.ino) {
            paged.delete(handleId);
            return DELEGATE;
          }
          if (offset >= now2.size)
            return new Uint8ArrayConstructor(0);
          const end = mathMin(now2.size, offset + length);
          const first = mathFloor(offset / RESIDENT_PAGE_BYTES);
          const last = mathFloor((end - 1) / RESIDENT_PAGE_BYTES);
          return after2(store.pages(file.key, now2.revision, now2.size, first, last), (found) => {
            if (found === null) {
              paged.delete(handleId);
              return DELEGATE;
            }
            counts.pagedReads++;
            counts.pagesFetched += found.fetched;
            const out = new Uint8ArrayConstructor(end - offset);
            for (let i = 0; i < found.pages.length; i++) {
              const page = found.pages[i];
              const start = (first + i) * RESIDENT_PAGE_BYTES;
              const from = mathMax(offset, start);
              const to = mathMin(end, start + page.length);
              typedArraySet(out, bytesView(page, from - start, to - start), from - offset);
            }
            return out;
          });
        }), () => authority.read(handleId, offset, length));
      }
      delegated("read");
      return authority.read(handleId, offset, length);
    };
    fs.seek = (handleId, offset, whence) => {
      if (holder?.owns(handleId)) {
        counts.local++;
        return holder.seek(handleId, offset, whence);
      }
      delegated("seek");
      return authority.seek(handleId, offset, whence);
    };
    fs.write = (handleId, offset, bytes) => {
      if (holder?.owns(handleId)) {
        counts.local++;
        return holder.write(handleId, offset, bytes, !now && answeredWrites);
      }
      if (now)
        throw NOT_NOW;
      unwritten.delete(handleId);
      return changing("write", () => authority.write(handleId, offset, bytes));
    };
    fs.ftruncate = (handleId, size) => {
      if (holder?.owns(handleId)) {
        counts.local++;
        return holder.ftruncate(handleId, size, !now && answeredWrites);
      }
      if (now)
        throw NOT_NOW;
      unwritten.delete(handleId);
      return changing("ftruncate", () => authority.ftruncate(handleId, size));
    };
    fs.close = (handleId) => {
      if (directoryPool?.owns(handleId)) {
        counts.local++;
        return directoryPool.close(handleId, !now);
      }
      if (holder?.owns(handleId)) {
        counts.local++;
        holder.close(handleId);
        return holder.reportRecorded();
      }
      if (now)
        throw NOT_NOW;
      if (readers.delete(handleId)) {
        directories.delete(handleId);
        paged.delete(handleId);
        readerKeys.delete(handleId);
        delegated("close");
        return authority.close(handleId);
      }
      if (unwritten.delete(handleId)) {
        delegated("close");
        return authority.close(handleId);
      }
      return changing("close", () => authority.close(handleId));
    };
    fs.readdirHandle = (handleId) => answer("readdirHandle", () => {
      const key = directoryKey(handleId);
      if (key === void 0)
        return DELEGATE;
      return after2(listingOf(key), (entries) => entries === DELEGATE ? DELEGATE : arrayCopy(byCodeUnit(entries)));
    }, () => authority.readdirHandle(handleId));
    fs.fsync = (handleId) => {
      if (now) {
        if (handleId !== void 0 && !holder?.owns(handleId)) {
          if (handleId < 0)
            throw fsError2("EBADF", "fsync", stringOf(handleId));
          throw NOT_NOW;
        }
        holder?.reportRecorded();
        return;
      }
      if (handleId !== void 0 && holder?.owns(handleId))
        return holder.flush();
      const synced = async () => {
        await holder?.flush();
        delegated("fsync");
        await authority.fsync(handleId);
      };
      return synced();
    };
    const bySessionStatus = reflectGet(fs, "setStatus");
    if (typeof bySessionStatus === "function") {
      reflectSet(fs, "setStatus", (handleId, status) => {
        if (holder?.owns(handleId)) {
          counts.local++;
          holder.setStatus(handleId, status);
          return;
        }
        return reflectApply(bySessionStatus, fs, [handleId, status]);
      });
    }
    const bySessionReopen = reflectGet(fs, "reopen");
    if (typeof bySessionReopen === "function") {
      reflectSet(fs, "reopen", (target, flags, options) => {
        const held = holder;
        if (!held?.owns(target.handle))
          return reflectApply(bySessionReopen, fs, [target, flags, options]);
        const desc = held.provisional.descriptor(target.handle);
        const described = ownValue(desc.inode, "cell") === void 0 && (ownValue(desc, "description") !== void 0 || held.provisional.sessionOf(target.handle) !== void 0);
        const local = !now && described ? void 0 : held.reopen(target.handle, flags);
        if (local !== void 0) {
          counts.local++;
          return heldOpen(local);
        }
        if (now)
          throw NOT_NOW;
        const identity2 = { dev: desc.inode.dev, ino: desc.inode.ino };
        const name = "/" + held.keyOf(target.handle);
        return promiseThen(promiseThen(held.flush(), () => held.provisional.sessionOf(target.handle)), (session2) => session2 === void 0 ? openIdentified(fs, name, false, flags, identity2) : reflectApply(bySessionReopen, fs, [{ handle: session2 }, flags, options]));
      });
    }
    const argumentsOf = (first, rest) => {
      const args = new SafeList();
      args[0] = first;
      for (let i = 0; i < rest.length; i++)
        args[i + 1] = rest[i];
      return args;
    };
    const byHandle = ["fchmod", "fchown", "futimes", "dup"];
    for (let i = 0; i < byHandle.length; i++) {
      const name = byHandle[i];
      const passed = reflectGet(fs, name);
      if (typeof passed !== "function")
        continue;
      reflectSet(fs, name, (handleId, ...rest) => {
        if (!holder?.owns(handleId))
          return reflectApply(passed, fs, argumentsOf(handleId, rest));
        if (name === "dup")
          return holder.dup(handleId);
        return holderAttrs(name, handleId, rest);
      });
    }
    const ownerSide = (value) => typeof value === "number" && value !== -1 ? value : null;
    const holderAttrs = (name, handleId, rest) => {
      const change = name === "fchmod" ? { mode: NumberOf(rest[0]) } : name === "fchown" ? { uid: ownerSide(rest[0]), gid: ownerSide(rest[1]) } : { atime: rest[0], mtime: rest[1] };
      if (holder.fsetattr(handleId, change) || now)
        return void 0;
      return holder.flush();
    };
    const byClient = (name, op) => {
      if (now)
        throw NOT_NOW;
      const files = op.type === "rename" ? holder.provisional.planMove(op.from, op.to, "/" + op.from) : void 0;
      return shown((async () => {
        try {
          delegated(name);
          if (op.type === "rename")
            holder.changing([op.from, op.to]);
          else if (op.type === "call" && (op.call.call === "unlink" || op.call.call === "rmdir"))
            holder.changing([op.call.path]);
          const answered2 = holder.client.submit(op);
          try {
            await answered2;
          } finally {
            owed.own++;
          }
          if (op.type === "rename") {
            holder.superseded(op.from);
            holder.superseded(op.to);
            files?.commit();
          } else if (op.type === "call" && (op.call.call === "unlink" || op.call.call === "rmdir"))
            holder.superseded(op.call.path);
        } finally {
          files?.cancel();
        }
      })());
    };
    const pathOf = (path) => typeof path === "string" ? path : path.path;
    const bySessionWriteFile = fs.writeFile;
    const walkToWrite = (path, makesParents) => {
      if (!makesParents)
        return walkFor(path, true);
      const missing = (error) => {
        if (errnoCodeOf(error) === "ENOENT")
          return DELEGATE;
        throw error;
      };
      try {
        const walk = walkFor(path, true);
        return walk instanceof PromiseConstructor ? promiseThen(walk, void 0, missing) : walk;
      } catch (error) {
        return missing(error);
      }
    };
    fs.writeFile = (path, bytes, options) => {
      if (holder === null || options?.expectedRevision !== void 0)
        return bySessionWriteFile(path, bytes, options);
      const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
      const flags = { write: true, create: true, truncate: true, mode: 438, ...options?.umask === void 0 ? {} : { umask: options.umask } };
      const local = decide(() => after2(walkToWrite(path, options?.createParents === true), (walk) => {
        if (walk === DELEGATE || !decidable(walk.key, walk))
          return DELEGATE;
        return holder.writeFile(walk.key, pathOf(path), data, flags) ?? DELEGATE;
      }));
      const decided = () => provisionally(path, true, (key, row) => holder.provisional.writeFile(key, pathOf(path), data, row, options?.umask) && (holder.entry(key)?.revision ?? 0));
      return after2(local, (done) => done !== DELEGATE ? done : options?.createParents === true ? bySessionWriteFile(path, bytes, options) : now ? decided() : decidedThenSent(decided, () => bySessionWriteFile(path, bytes, options)));
    };
    const bySessionMkdir = fs.mkdir;
    fs.mkdir = (path, options) => {
      if (holder === null)
        return bySessionMkdir(path, options);
      if (options?.recursive) {
        if (typeof path !== "string")
          return bySessionMkdir(path, options);
        return now ? mkdirParents(path, options) : decidedThenSent(() => mkdirParents(path, options), () => bySessionMkdir(path, options));
      }
      const mode = options?.mode ?? 511;
      let named;
      const local = decide(() => after2(walkFor(path, false), (walk) => {
        if (walk === DELEGATE)
          return DELEGATE;
        named = walk.key;
        if (!decidable(walk.key, walk))
          return DELEGATE;
        return after2(holder.mkdir(walk.key, pathOf(path), mode, options?.umask), (done) => done ? void 0 : DELEGATE);
      }));
      return after2(local, (done) => done !== DELEGATE ? void 0 : ownChange([named], (rows, awaited) => holder.provisional.mkdir(named, pathOf(path), mode, rows[0], options?.umask, awaited), () => named !== void 0 ? byClient("mkdir", { type: "call", call: { call: "mkdir", path: named, mode, ...options?.umask === void 0 ? {} : { umask: options.umask } } }) : bySessionMkdir(path, options)));
    };
    const mkdirParents = (path, options) => {
      const segments = stringSplit(path, "/");
      const parts = new SafeList();
      for (let i = 0; i < segments.length; i++)
        if (segments[i] !== "" && segments[i] !== ".")
          parts[parts.length] = segments[i];
      const askedMode = ownValue(options, "mode");
      const askedUmask = ownValue(options, "umask");
      const planned = [];
      const making = new SafeSet();
      let current = "";
      for (let at = 0; at < parts.length; at++) {
        const part = parts[at];
        const last = at === parts.length - 1;
        if (part === "..") {
          current = parentKey5(current);
          continue;
        }
        const next = current === "" ? part : `${current}/${part}`;
        if (making.has(current)) {
          planned[planned.length] = next;
          making.add(next);
          current = next;
          continue;
        }
        const walked = walkOnce("", next, true);
        if (walked === null)
          throw fsError2("ELOOP", "mkdir", path);
        const entry = typeof walked === "string" ? ownEntryAt(walked) : void 0;
        if (entry === void 0)
          throw NOT_NOW;
        if (entry === null) {
          const parent = ownEntryAt(parentKey5(walked));
          if (!parent || parent.type !== "directory" || parent.dev !== store.device)
            throw NOT_NOW;
          if (!modeAllows(parent, 3, store.cred))
            throw fsError2("EACCES", "mkdir", path);
          if (((askedMode ?? 511) & 3584) !== 0)
            throw NOT_NOW;
          planned[planned.length] = walked;
          making.add(walked);
          current = walked;
          continue;
        }
        if (entry.type !== "directory")
          throw fsError2(last ? "EEXIST" : "ENOTDIR", "mkdir", path);
        current = walked;
      }
      for (let i = 0; i < planned.length; i++) {
        const key = planned[i];
        fs.mkdir("/" + key, { ...askedMode === void 0 ? {} : { mode: askedMode }, ...askedUmask === void 0 ? {} : { umask: askedUmask } });
      }
      return void 0;
    };
    const bySessionUnlink = fs.unlink;
    fs.unlink = (path) => {
      if (holder === null)
        return bySessionUnlink(path);
      let named;
      const local = decide(() => after2(walkFor(path, false), (walk) => {
        if (walk === DELEGATE)
          return DELEGATE;
        named = walk.key;
        if (!decidable(walk.key, walk))
          return DELEGATE;
        return after2(holder.unlink(walk.key, pathOf(path)), (done) => done ? void 0 : DELEGATE);
      }));
      return after2(local, (done) => done !== DELEGATE ? void 0 : ownChange([named], (rows, awaited) => holder.provisional.unlink(named, pathOf(path), rows[0], awaited), () => named !== void 0 ? byClient("unlink", { type: "call", call: { call: "unlink", path: named } }) : bySessionUnlink(path)));
    };
    const vouchedContent = ({ key }) => {
      const cursor = store.cursor();
      if (cursor === null || holder.client.vouch(key, rootOf(cursor)) !== "held")
        return void 0;
      const entry = entryAt(key);
      return entry ? store.content(key, entry.revision) : void 0;
    };
    const bySessionCopy = fs.copyFile;
    const copyOnSession = (from, to, options) => {
      const key = keyOf(pathOf(to));
      const answered2 = promiseResolve(bySessionCopy(from, to, options));
      holder.copying(key, answered2);
      return promiseThen(answered2, () => {
        holder.superseded(key);
      });
    };
    fs.copyFile = (from, to, options) => {
      if (holder === null || options?.preserve === true)
        return bySessionCopy(from, to, options);
      const local = decide(() => after2(walkFor(from, true), (source) => source === DELEGATE ? DELEGATE : after2(walkFor(to, true), (target) => {
        if (target === DELEGATE || !decidable(target.key, source, target))
          return DELEGATE;
        return holder.copyFile(source.key, target.key, pathOf(to), vouchedContent(source), options?.keepMode === true) ? void 0 : DELEGATE;
      })));
      return after2(local, (done) => done !== DELEGATE ? void 0 : now ? void provisionally(from, true, (source, row) => {
        if (row === null)
          throw fsError2("ENOENT", "copyfile", pathOf(from));
        return provisionally(to, true, (target, there) => holder.provisional.copyFile(source, target, pathOf(to), row, there, options?.keepMode === true));
      }) : copyOnSession(from, to, options));
    };
    const bySessionRename = fs.rename;
    fs.rename = (from, to) => {
      if (holder === null)
        return bySessionRename(from, to);
      let names2;
      const local = decide(() => after2(walkFor(from, false), (source) => source === DELEGATE ? DELEGATE : after2(walkFor(to, false), (target) => {
        if (target === DELEGATE)
          return DELEGATE;
        names2 = [source.key, target.key];
        if (!decidable(source.key, source, target))
          return DELEGATE;
        return after2(holder.rename(source.key, target.key, pathOf(from)), (done) => done ? void 0 : DELEGATE);
      })));
      return after2(local, (done) => done !== DELEGATE ? void 0 : ownChange(names2 ?? [void 0], (rows, awaited) => holder.provisional.rename(names2[0], names2[1], pathOf(from), rows[0], rows[1], awaited), () => names2 !== void 0 ? byClient("rename", { type: "rename", from: names2[0], to: names2[1] }) : bySessionRename(from, to)));
    };
    const byPath = ["chmod", "chown", "utimes"];
    for (let i = 0; i < byPath.length; i++) {
      const name = byPath[i];
      const passed = reflectGet(fs, name);
      reflectSet(fs, name, (path, ...given) => {
        let rest = given;
        if (name === "chown") {
          rest = new SafeList();
          rest[0] = ownerSide(given[0]);
          rest[1] = ownerSide(given[1]);
          for (let j = 2; j < given.length; j++)
            rest[j] = given[j];
        }
        const linkOptions = rest[2];
        const link = name !== "chmod" && linkOptions !== void 0 && linkOptions !== null && ownValue(linkOptions, "followSymlinks") === false;
        const attrs = name === "chmod" ? { mode: NumberOf(rest[0]) } : name === "chown" ? { uid: ownerSide(rest[0]), gid: ownerSide(rest[1]) } : { atime: rest[0], mtime: rest[1] };
        if (holder === null)
          return reflectApply(passed, fs, argumentsOf(path, rest));
        let named;
        const local = decide(() => after2(walkFor(path, !link), (walk) => {
          if (walk === DELEGATE)
            return DELEGATE;
          named = walk.key;
          if (link || !decidable(walk.key, walk))
            return DELEGATE;
          return holder.setattr(walk.key, attrs) ? void 0 : DELEGATE;
        }));
        return after2(local, (done) => {
          if (done !== DELEGATE)
            return void 0;
          const key = named;
          return ownChange([key], (rows, awaited) => holder.provisional.setattr(key, pathOf(path), attrs, rows[0], awaited, link), () => key === void 0 || !holder.holds(key) ? reflectApply(passed, fs, argumentsOf(path, rest)) : after2(reflectApply(passed, fs, argumentsOf(path, rest)), (receipt) => {
            holder.undecided(key);
            return receipt;
          }));
        });
      });
    }
    const byName = (name, passed, pathAt, op, decided) => (...args) => {
      if (holder === null)
        return reflectApply(passed, void 0, args);
      return after2(walkFor(args[pathAt], false), (walk) => {
        const key = walk === DELEGATE ? void 0 : walk.key;
        return ownChange([key], (rows, awaited) => decided(key, rows[0], args, awaited), () => key === void 0 ? reflectApply(passed, void 0, args) : byClient(name, op(key, args)));
      });
    };
    const bySessionRmdir = fs.rmdir;
    fs.rmdir = byName("rmdir", (path) => bySessionRmdir(path), 0, (key) => ({ type: "call", call: { call: "rmdir", path: key } }), (key, row, args, awaited) => holder.provisional.rmdir(key, pathOf(args[0]), row, awaited));
    const bySessionSymlink = fs.symlink;
    fs.symlink = byName("symlink", (target, path) => bySessionSymlink(target, path), 1, (key, args) => ({ type: "call", call: { call: "symlink", path: key, target: args[0] } }), (key, row, args, awaited) => holder.provisional.symlink(key, pathOf(args[1]), args[0], row, awaited));
    const openRefusal = (path, given) => {
      const flags = openFlags(given);
      const flagged = flagsRefusal(flags);
      if (flagged !== null)
        return fsError2(flagged, "open", path);
      let walked;
      try {
        walked = walkOnce("", keyOf(path), openFollows(flags));
      } catch {
        return null;
      }
      const entry = typeof walked === "string" ? entryAt(walked) : void 0;
      if (!entry)
        return null;
      if (flags.exclusive && flags.create)
        return fsError2("EEXIST", "open", path);
      if (entry.type === "symlink" && !flags.followSymlinks)
        return fsError2(flags.directory ? "ENOTDIR" : "ELOOP", "open", path);
      return null;
    };
    const notResident = (syscall, args) => {
      counts.notResident++;
      const target = args[0];
      const path = typeof target === "number" ? holder?.owns(target) ? "/" + holder.keyOf(target) : stringOf(target) : typeof target === "string" || typeof target === "object" && target !== null && objectHasOwn(target, "path") ? pathOf(target) : "";
      if (syscall === "open" && typeof target === "string" && !climbs(target)) {
        const refusal = openRefusal(target, args[1]);
        if (refusal !== null)
          return refusal;
      }
      if (typeof target === "string" && !climbs(target)) {
        const walked = walkOnce("", keyOf(target), true);
        const entry = typeof walked === "string" ? entryAt(walked) : void 0;
        if (entry?.type === "directory" && refusesADirectory(syscall, args))
          return fsError2("EISDIR", syscall, target);
        if (entry && !modeAllows(entry, 4, store.cred))
          return fsError2("EACCES", syscall, target);
      }
      return fsError2("EAGAIN", syscall, path, void 0, {
        detail: `resource temporarily unavailable, ${syscall} '${path}' \u2014 '${path}' exists but its content is not resident in this process, and a synchronous call cannot wait to fetch it`
      });
    };
    const missed = new SafeSet();
    const keyFor = (target) => {
      if (typeof target === "number")
        return holder?.owns(target) ? holder.keyOf(target) : readerKeys.get(target);
      if (typeof target === "string")
        return keyOf(target);
      if (typeof target === "object" && target !== null && objectHasOwn(target, "root"))
        return keyOf(`${target.root}/${pathOf(target)}`);
      return void 0;
    };
    const refused = (syscall, args, fetch) => {
      const key = CONTENT_READS.has(syscall) ? keyFor(args[0]) : void 0;
      if (key === void 0)
        return;
      const speculation = residency.speculation();
      if (speculation !== null) {
        speculation.missed(key, fetch);
        return;
      }
      if (missed.has(key))
        return;
      missed.add(key);
      ownValue(residency, "missed")?.(key);
    };
    const answered = (args) => {
      const key = keyFor(args[0]);
      if (key === void 0)
        return;
      missed.delete(key);
      try {
        const at = walkOnce("", key, true);
        if (typeof at === "string")
          missed.delete(at);
      } catch {
      }
    };
    if (residency !== void 0) {
      CONTENT_READS.forEach((name) => {
        const passed = reflectGet(fs, name);
        if (typeof passed !== "function")
          return;
        reflectSet(fs, name, (...args) => {
          if (now || missed.size === 0)
            return reflectApply(passed, fs, args);
          const refusal = (error) => {
            if (ANSWERED_REFUSALS.has(errnoCodeOf(error) ?? ""))
              answered(args);
            throw error;
          };
          let answer2;
          try {
            answer2 = reflectApply(passed, fs, args);
          } catch (error) {
            return refusal(error);
          }
          if (!(answer2 instanceof PromiseConstructor)) {
            answered(args);
            return answer2;
          }
          return promiseThen(answer2, (value) => {
            answered(args);
            return value;
          }, refusal);
        });
      });
    }
    const knownAbsent = (key) => {
      if (!store.ready())
        return false;
      try {
        const at = walkOnce("", key, true);
        return typeof at === "string" && entryAt(at) === null;
      } catch (error) {
        const code = errnoCodeOf(error);
        return code === "ENOENT" || code === "ENOTDIR";
      }
    };
    fs.misses = async () => {
      await faultsEnded();
      const keys = setList(missed);
      for (let i = 0; i < keys.length; i++)
        if (knownAbsent(keys[i]))
          missed.delete(keys[i]);
      return arrayCopy(setList(missed));
    };
    const synchronous = objectCreate(null);
    names.forEach((name) => {
      if (NO_SYNCHRONOUS_FORM.has(name) || typeof reflectGet(fs, name) !== "function")
        return;
      reflectSet(synchronous, name, (...args) => {
        const was = now;
        now = true;
        try {
          const value = reflectApply(reflectGet(fs, name), fs, args);
          if (value instanceof PromiseConstructor) {
            promiseThen(value, void 0, () => {
            });
            throw new Error2(`${name}: the synchronous filesystem began a wait`);
          }
          return value;
        } catch (error) {
          if (error !== NOT_NOW)
            throw error;
          const refusal = notResident(name, args);
          if (residency !== void 0 && errnoCodeOf(refusal) === "EAGAIN")
            refused(name, args, refusedFetch);
          refusedFetch = null;
          throw refusal;
        } finally {
          now = was;
        }
      });
    });
    reflectSet(fs, "synchronous", synchronous);
    return fs;
  }

  // ../core/dist/runtime/wasi/process-filesystem.js
  function isHomeDirectory(key) {
    return key === "root" || stringStartsWith(key, "home/") && key.length > "home/".length && !stringIncludes(stringSlice(key, "home/".length), "/");
  }
  function processFilesystem(supervisor, view, options = {}) {
    const authority = supervisorFilesystem(supervisor);
    const journalSql = ownValue(options, "journalSql");
    const holdsGrants = ownValue(options, "holdsGrants");
    const { ...delegation } = options;
    reflectDeleteProperty(delegation, "journalSql");
    reflectDeleteProperty(delegation, "holdsGrants");
    const directories = answeringSupervisor(supervisor);
    return residentFilesystem(authority, view, {
      ...delegation,
      session: supervisorSession(supervisor, authority, void 0, holdsGrants !== false),
      isHomeRoot: isHomeDirectory,
      ...typeof reflectGet(directories, "fsReadDirectories") === "function" ? { readDirectories: (request) => reflectApply(reflectGet(directories, "fsReadDirectories"), directories, [request]) } : {},
      ...journalSql === void 0 ? {} : { journal: sqlJournal(journalSql) }
    });
  }

  // src/vfs/resident/index.ts
  function dropSqlStore(storage) {
    const sql = reflectGet(storage, "sql");
    const exec = sql === void 0 || sql === null ? void 0 : reflectGet(sql, "exec");
    if (typeof exec !== "function") return;
    const held = new SafeList();
    const rows = reflectApply(exec, sql, ["SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('file', 'chunk', 'ns', 'meta', 'page')"]);
    const iterator = reflectApply(reflectGet(rows, symbolIterator), rows, []);
    const next = reflectGet(iterator, "next");
    for (let step = reflectApply(next, iterator, []); !step.done; step = reflectApply(next, iterator, [])) {
      held[held.length] = stringOf(step.value.name);
    }
    for (let i = 0; i < held.length; i++) reflectApply(exec, sql, ["DROP TABLE IF EXISTS " + held[i]]);
  }
  function createResidentStore(options = {}) {
    const coherence = createCoherence();
    const admission = createAdmission(coherence);
    const namespace = createNamespace(coherence, admission);
    const observeRead = ownValue(options, "observeRead") ?? null;
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
        const storage = typeof ctx === "object" && ctx !== null ? reflectGet(ctx, "storage") : void 0;
        if (!storage || typeof storage.kv?.get !== "function" || typeof storage.put !== "function") {
          throw new Error2(
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
