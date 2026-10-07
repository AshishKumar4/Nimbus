"use strict";
var __nimbusProcessFsModule = (() => {
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

  var process_fs_client_exports = {};
  __export(process_fs_client_exports, {
    DECIDED_BACKLOG_BYTES: () => DECIDED_BACKLOG_BYTES,
    DECIDED_BACKLOG_OPS: () => DECIDED_BACKLOG_OPS,
    GRANT_AFTER: () => GRANT_AFTER,
    GRANT_IDLE_MS: () => GRANT_IDLE_MS,
    MAX_DELEGATIONS_PER_PROCESS: () => MAX_DELEGATIONS_PER_PROCESS,
    PROCESS_FS_ROOM_BYTES: () => PROCESS_FS_ROOM_BYTES,
    PROCESS_FS_SYNC_CAP_BYTES: () => PROCESS_FS_SYNC_CAP_BYTES,
    processFsClient: () => processFsClient
  });

  var CRC_NATIVE_MIN_BYTES = 128;
  var nativeCrc32 = (() => {
    try {
      const crc322 = globalThis.process?.getBuiltinModule?.("node:zlib")?.crc32;
      return typeof crc322 === "function" ? crc322 : null;
    } catch {
      return null;
    }
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

  var CHUNK_SIZE = 65536;
  var MAX_TX_BLOB_BYTES = 1 * 1024 * 1024;
  var SQLITE_MAX_STATEMENT_BYTES = 100 * 1024;
  var MAX_RPC_SAFE_PAYLOAD_BYTES = 28 * 1024 * 1024;
  var ONE_SHOT_MODULE_MAP_MAX_BYTES = 18 * 1024 * 1024;
  var SUPERVISOR_HEAP_CEILING_BYTES = 64 * 1024 * 1024;
  var FACET_OWN_WRITE_MEMORY_BYTES = 32 * 1024 * 1024;
  var WASI_RESIDENT_STORE_BYTES = 32 * 1024 * 1024;
  var SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES = 40 * 1024 * 1024;
  var SUPERVISOR_READ_RESERVE_BYTES = 1024 * 1024;
  var MAX_GLOBAL_WRITE_STREAM_CREDIT_BYTES = 8 * 1024 * 1024;

  function utf8Length(text) {
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
          yield encodeMetadataRecord(RecordTag.Rename, { from: op.from, to: op.to }, state);
          break;
        case "truncate":
          state.summary.pathCount++;
          state.summary.opCount++;
          yield encodeMetadataRecord(RecordTag.Truncate, { path: op.path, size: op.size }, state);
          break;
        case "setattr":
          state.summary.pathCount++;
          state.summary.opCount++;
          yield encodeMetadataRecord(RecordTag.SetAttr, { path: op.path, ...op.attrs }, state);
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
      ...file.inode.offset === void 0 ? {} : { offset: file.inode.offset }
    }, state);
    let fileCheck = 0;
    let chunkId = 0;
    const pieces2 = file.source === null ? givenChunks(file.chunks) : fixedChunks(file.inode, file.source);
    for await (const data of pieces2) {
      const contentBytes = new TextEncoder().encode(file.contentId);
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
    let pending = new Uint8Array(Math.min(CHUNK_SIZE, inode.size));
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
        const take = Math.min(pending.byteLength - filled, part.byteLength - offset);
        pending.set(part.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === pending.byteLength) {
          yield pending;
          pending = new Uint8Array(Math.min(CHUNK_SIZE, inode.size - total + (part.byteLength - offset)));
          filled = 0;
        }
      }
    }
    if (total !== inode.size) {
      throw new Error(`w7-frame: ${inode.path}: streamed source ended at ${total} of ${inode.size} bytes`);
    }
  }
  function encodeMetadataRecord(tag, value, state) {
    const payload = new TextEncoder().encode(JSON.stringify(value));
    if (payload.byteLength > MAX_METADATA_BYTES) {
      throw new Error(`w7-frame: metadata record exceeds ${MAX_METADATA_BYTES} bytes`);
    }
    const header = recordHeader(tag, payload.byteLength);
    if (state && tag !== RecordTag.BatchEnd) {
      state.batchCheck = updateRecordCheck(state.batchCheck, header, payload);
      state.summary.recordCount++;
    }
    return [concatBytes(header, payload)];
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
    const streamsByPath =   new Map();
    for (const stream of payload.streams ?? []) {
      const path = canonicalPath(stream.path, "stream path");
      if (streamsByPath.has(path))
        throw new Error(`w7-frame: duplicate stream for ${path}`);
      streamsByPath.set(path, stream.source);
    }
    const chunksByPath =   new Map();
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
            to: ownedPaths.claim(canonicalPath(op.to, "rename target"))
          };
        case "truncate":
          return { kind: "truncate", path: ownedPaths.claim(canonicalPath(op.path, "truncate path")), size: safeInteger(op.size, "truncate size") };
        case "setattr":
          return { kind: "setattr", path: ownedPaths.claim(canonicalPath(op.path, "setattr path")), attrs: parseAttrs(op.attrs, "setattr") };
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
      return { uid: u32(value.uid, `${label} uid`), gid: u32(value.gid, `${label} gid`) };
    if (keys === "atime,mtime")
      return { atime: safeInteger(value.atime, `${label} atime`), mtime: safeInteger(value.mtime, `${label} mtime`) };
    throw new Error(`w7-frame: ${label} changes the mode, the owner or the times, one of them: got ${keys || "nothing"}`);
  }
  function parsePathCall(value, path) {
    const keys = Object.keys(value).sort().join(",");
    switch (value.call) {
      case "mkdir": {
        const optional = keys.replace(",existing", "").replace(",ino", "");
        if (optional !== "call,mode,path")
          break;
        if (value.existing !== void 0 && value.existing !== "ok")
          throw new Error(`w7-frame: mkdir existing is 'ok' or absent, not ${String(value.existing)}`);
        return {
          call: "mkdir",
          path: path(value.path, "mkdir path"),
          mode: u32(value.mode, "mkdir mode"),
          ...value.ino === void 0 ? {} : { ino: inodeNumber(value.ino, "mkdir ino") },
          ...value.existing === void 0 ? {} : { existing: "ok" }
        };
      }
      case "unlink":
      case "rmdir":
        if (keys !== "call,path")
          break;
        return { call: value.call, path: path(value.path, `${value.call} path`) };
      case "symlink":
        if (keys !== "call,path,target" && keys !== "call,ino,path,target")
          break;
        return {
          call: "symlink",
          path: path(value.path, "symlink path"),
          target: boundedString(value.target, "symlink target", MAX_PATH_BYTES),
          ...value.ino === void 0 ? {} : { ino: inodeNumber(value.ino, "symlink ino") }
        };
      case "ftruncate":
        if (keys !== "call,ino,path,size" && keys !== "call,path,size")
          break;
        return {
          call: "ftruncate",
          path: path(value.path, "ftruncate path"),
          size: safeInteger(value.size, "ftruncate size"),
          ...value.ino === void 0 ? {} : { ino: inodeNumber(value.ino, "ftruncate ino") }
        };
      default:
        throw new Error(`w7-frame: unknown call ${String(value.call)}`);
    }
    throw new Error(`w7-frame: ${String(value.call)} takes other fields: got ${keys}`);
  }
  function inodeNumber(value, label) {
    const ino = safeInteger(value, label);
    if (ino < 2)
      throw new Error(`w7-frame: ${label} must be at least 2`);
    return ino;
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
    paths =   new Set();
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
    const out = [];
    for (const segment of path.split("/")) {
      if (segment === "..") {
        if (out.length > 0)
          out.pop();
      } else if (segment !== "" && segment !== ".") {
        out.push(segment);
      }
    }
    return out.join("/");
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
    const seen =   new Set();
    const messages = [];
    let flagged = false;
    let link = input;
    while (link !== null && !seen.has(link)) {
      seen.add(link);
      const overloaded = "overloaded" in link && link.overloaded === true || isDoOverloaded(link.message);
      if (overloaded)
        return "overloaded";
      if ("retryable" in link && link.retryable === true)
        flagged = true;
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

  function retryDelayMs(schedule, attempt) {
    const base = schedule[Math.min(attempt, schedule.length - 1)] ?? 0;
    return Math.max(0, Math.round(base + (Math.random() * 2 - 1) * base * 0.25));
  }

  var WAVE_PATHS = W7_MAX_PATHS_PER_BATCH - 8;
  var WAVE_PATH_BYTES = W7_MAX_OWNED_PATH_BYTES - 4 * 1024;
  var WAVE_BYTES = 4 * 1024 * 1024;
  var SEND_SLICE_BYTES = 1024 * 1024;
  var encoder = new TextEncoder();
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

  var SYSCALL_VERDICTS =   new Set([
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
    EBADF: "bad file descriptor"
  };
  var ERRNO_DESCRIPTION = {
    ...VFS_DESCRIPTION,
    EBADF: "bad file descriptor",
    EFBIG: "file too large",
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
    EFAULT: "bad address in system call argument"
  };

  var PROCESS_FS_SYNC_CAP_BYTES = 64 * 1024 * 1024;
  var PROCESS_FS_ROOM_BYTES = 2 * WAVE_BYTES;
  var DECIDED_BACKLOG_OPS = 2 * WAVE_PATHS;
  var DECIDED_BACKLOG_BYTES = 2 * WAVE_BYTES;
  var DATA_PIECE_BYTES = WAVE_BYTES;
  var MAX_DELEGATIONS_PER_PROCESS = 8;
  var GRANT_AFTER = 8;
  var GRANT_IDLE_MS = 2e3;
  var GRANT_INOS = 4096;
  var GRANT_BYTES = 64 * 1024 * 1024;
  var RECALL_POLL_MS = 2e4;
  function parentKey(key) {
    const at = key.lastIndexOf("/");
    return at < 0 ? "" : key.slice(0, at);
  }
  function within(key, root) {
    return root === "" || key === root || key.startsWith(`${root}/`);
  }
  function commonAncestor(left, right) {
    const a = left.split("/");
    const b = right.split("/");
    const out = [];
    for (let index = 0; index < Math.min(a.length, b.length) && a[index] === b[index]; index++) out.push(a[index]);
    return out.join("/");
  }
  var GLOBAL_TIMERS2 = {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer)
  };
  function utf8Length2(text) {
    return new TextEncoder().encode(text).byteLength;
  }
  function pathsOf(op) {
    switch (op.type) {
      case "run":
        return [op.path];
      case "call":
        return [op.call.path];
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
  function nameOf(op) {
    return op.type === "call" ? op.call.call : op.type === "run" ? op.name : op.type;
  }
  function fsError(errno, message, path) {
    return Object.assign(new Error(message), { code: errno, path });
  }
  function pieces(op) {
    if (op.type !== "call" || !("data" in op.call) || op.call.data.byteLength <= DATA_PIECE_BYTES) return [op];
    const call = op.call;
    const data = call.data;
    const out = [{ type: "call", call: { ...call, data: data.subarray(0, DATA_PIECE_BYTES) } }];
    for (let at = DATA_PIECE_BYTES; at < data.byteLength; at += DATA_PIECE_BYTES) {
      const piece = data.subarray(at, Math.min(data.byteLength, at + DATA_PIECE_BYTES));
      const ino = "ino" in call ? call.ino : void 0;
      out.push(call.call === "append" || call.call === "appendFile" ? { type: "call", call: { call: "append", path: call.path, ...ino === void 0 ? {} : { ino }, data: piece } } : { type: "call", call: { call: "write", path: call.path, ...ino === void 0 ? {} : { ino }, offset: (call.call === "write" ? call.offset : 0) + at, data: piece } });
    }
    return out;
  }
  function processFsClient(options) {
    const { session } = options;
    const timers = options.timers ?? GLOBAL_TIMERS2;
    const now = options.now ?? Date.now;
    const syncCap = options.syncCapBytes ?? PROCESS_FS_SYNC_CAP_BYTES;
    const charge = options.charge ?? (() => {
    });
    const queue = [];
    let inFlight = null;
    let scheduled = false;
    let pendingBytes = 0;
    let pendingSyncBytes = 0;
    let pendingSyncOps = 0;
    let epoch = null;
    let nextSeq = 1;
    let ack = 0;
    let wave = 0;
    const failures = [];
    let logged = 0;
    let answered = 0;
    const marks = [];
    let windowed = 0;
    const roomWaiters = [];
    const grantRoom = (bytes) => {
      windowed += bytes;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        windowed -= bytes;
        while (roomWaiters.length > 0 && (windowed === 0 || windowed + roomWaiters[0].bytes <= PROCESS_FS_ROOM_BYTES)) {
          const next = roomWaiters.shift();
          next.resolve(grantRoom(next.bytes));
        }
      };
    };
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
      renewed: 0
    };
    const grantAfter = options.grantAfter ?? GRANT_AFTER;
    const grantIdleMs = options.grantIdleMs ?? GRANT_IDLE_MS;
    const recallPollMs = options.recallPollMs ?? RECALL_POLL_MS;
    const grants = [];
    const mutations =   new Map();
    const refusedRoots =   new Set();
    const rangeOf =   new Map();
    let claiming = null;
    let paused = false;
    let sending = null;
    let idleTimer = null;
    let settling = false;
    const settled = (entry) => {
      pendingBytes -= entry.bytes;
      if (entry.acknowledged) {
        pendingSyncBytes -= entry.bytes;
        pendingSyncOps--;
      }
      answered = Math.max(answered, entry.order);
      for (let at = marks.length - 1; at >= 0; at--) {
        if (marks[at].mark <= answered) marks.splice(at, 1)[0].resolve();
      }
    };
    const fail = (entry, errno, message) => {
      settled(entry);
      const path = entry.paths[0] ?? "";
      if (entry.acknowledged) {
        failures.push({ op: nameOf(entry.op), path, errno, message });
        entry.resolve({});
      } else {
        entry.reject(fsError(errno, message, path));
      }
    };
    const writerFor = async () => {
      if (epoch !== null && (epoch.writer === null || now() - epoch.openedAt < WAVE_EPOCH_TTL_MS / 2)) return epoch.writer;
      charge("openWaveWriter");
      const openedAt = now();
      const writer = await session.openWriter(counters.epochs === 0);
      epoch = { writer, openedAt };
      counters.epochs++;
      nextSeq = 1;
      ack = 0;
      wave = 0;
      return writer;
    };
    const cut = () => {
      const limit = marks.reduce((least, waiting) => Math.min(least, waiting.mark), Infinity);
      const taken = [];
      const owned =   new Set();
      let pathBytes = 0;
      let bytes = 0;
      while (queue.length > 0) {
        const next = queue[0];
        if (next.op.type === "run") {
          if (taken.length === 0) taken.push(queue.shift());
          break;
        }
        const fresh = next.paths.filter((path) => !owned.has(path));
        const freshBytes = fresh.reduce((sum, path) => sum + utf8Length2(path), 0);
        if (taken.length > 0 && (next.order > limit || owned.size + fresh.length > WAVE_PATHS || pathBytes + freshBytes > WAVE_PATH_BYTES || bytes + next.bytes > WAVE_BYTES)) break;
        for (const path of fresh) owned.add(path);
        pathBytes += freshBytes;
        bytes += next.bytes;
        taken.push(queue.shift());
      }
      return taken;
    };
    const send = async (entries) => {
      const first = entries[0];
      if (first.op.type === "run") {
        const { name, run } = first.op;
        charge(name);
        try {
          const value = await run();
          settled(first);
          first.resolve({ value });
        } catch (error2) {
          const code = error2?.code;
          fail(first, typeof code === "string" ? code : "EIO", error2 instanceof Error ? error2.message : String(error2));
        }
        return;
      }
      let writer;
      try {
        writer = await writerFor();
      } catch (error2) {
        for (const entry of entries) fail(entry, "EIO", `the session gave this process no writer: ${error2 instanceof Error ? error2.message : String(error2)}`);
        return;
      }
      const bytes = await encodeWriteBatch({ inodes: [], chunks: [], ops: entries.map((entry) => entry.op) });
      for (const entry of entries) if (entry.seq === 0) entry.seq = nextSeq++;
      const firstSeq = entries[0].seq;
      counters.waves++;
      counters.maxWaveOps = Math.max(counters.maxWaveOps, entries.length);
      wave++;
      let result;
      try {
        charge("writeBatchStream");
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
            charge("writeBatchStream");
          },
          timers
        });
      } catch (error2) {
        lostEpoch(entries, `the session did not answer this write: ${error2 instanceof Error ? error2.message : String(error2)}`);
        return;
      }
      const answer = result;
      const error = answer.ok ? null : answer.error;
      const cursor = writer === null ? firstSeq - 1 + (answer.ok ? entries.length : answer.committedOps) : answer.sequence?.cursor;
      if (cursor === void 0) {
        lostEpoch(entries, `the session answered this write without its cursor: ${error?.message ?? "no error"}`);
        return;
      }
      ack = Math.max(ack, cursor);
      const refused = writer === null ? error?.errno !== void 0 && SYSCALL_VERDICTS.has(error.errno) ? { seq: cursor + 1, errno: error.errno, message: error.message } : null : answer.sequence?.refused ?? null;
      let receipt = 0;
      const back = [];
      const mutations2 = new Map((answer.mutations ?? []).map((mutation) => [mutation.index, mutation]));
      for (const [index, entry] of entries.entries()) {
        if (refused !== null && entry.seq === refused.seq) {
          counters.refused++;
          fail(entry, refused.errno, refused.message);
          if (writer === null) ack = Math.max(ack, entry.seq);
          continue;
        }
        if (entry.seq <= cursor) {
          settled(entry);
          let answered2 = {};
          const path = entry.op.type === "call" && "data" in entry.op.call ? entry.op.call.path : null;
          const published = answer.receipts[receipt];
          if (path !== null && published?.path === path) {
            receipt++;
            const { path: _path, ...stat } = published;
            answered2 = { receipt: stat };
          }
          const mutation = mutations2.get(index);
          if (mutation !== void 0) answered2.mutation = { before: mutation.before, after: mutation.after };
          entry.resolve(answered2);
          continue;
        }
        back.push(entry);
      }
      if (back.length === 0) return;
      if (answer.ok || refused !== null) {
        queue.unshift(...back);
        return;
      }
      lostEpoch(back, `the session could not apply this write: ${error?.message ?? "no error"}`);
    };
    const lostEpoch = (entries, message) => {
      for (const entry of entries) {
        counters.lost++;
        fail(entry, "EIO", message);
      }
      epoch = null;
      for (const entry of queue) entry.seq = 0;
    };
    const pump = () => {
      scheduled = false;
      if (inFlight !== null || paused) return;
      if (queue.length === 0) return;
      const entries = cut();
      inFlight = entries;
      sending = send(entries).finally(() => {
        inFlight = null;
        sending = null;
        pump();
      });
    };
    const schedule = () => {
      if (scheduled || inFlight !== null || paused) return;
      scheduled = true;
      queueMicrotask(pump);
    };
    const quiet = async () => {
      while (sending !== null) await sending;
    };
    const live = () => grants.filter((grant) => !grant.ended);
    const allowedRoot = (root) => root !== "" && !(options.isHomeRoot?.(root) ?? false);
    const close = async (grant) => {
      grant.closing = true;
      await client.flush();
      await end(grant);
    };
    const end = async (grant) => {
      if (grant.ended) return;
      grant.ended = true;
      const at = grants.indexOf(grant);
      if (at >= 0) grants.splice(at, 1);
      counters.released++;
      options.released?.(grant.root);
      try {
        charge("fsReleaseExclusiveMutation");
        await session.grants?.release(grant.owner);
      } catch {
      }
    };
    const answerRecalls = async (grant) => {
      const port = session.grants;
      while (!grant.ended) {
        let kind;
        try {
          charge("fsAwaitRecall");
          kind = await port.awaitRecall(grant.owner, recallPollMs);
        } catch {
          if (!grant.ended) {
            grant.ended = true;
            const at = grants.indexOf(grant);
            if (at >= 0) grants.splice(at, 1);
            options.released?.(grant.root);
          }
          return;
        }
        if (kind === null || grant.ended) continue;
        counters.recalls++;
        await client.flush();
        if (kind === "share") {
          grant.shared = true;
          options.released?.(grant.root);
        }
        try {
          charge("fsRecalled");
          await port.recalled(grant.owner, kind);
        } catch {
        }
        if (kind === "revoke") {
          grant.ended = true;
          const at = grants.indexOf(grant);
          if (at >= 0) grants.splice(at, 1);
          options.released?.(grant.root);
          return;
        }
      }
    };
    const armIdle = () => {
      if (idleTimer !== null || live().length === 0) return;
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
      if (port === void 0 || claiming !== null || settling) return;
      claiming = (async () => {
        let target = root;
        const held = live();
        if (held.length >= MAX_DELEGATIONS_PER_PROCESS) {
          let best = "";
          for (const grant2 of held) {
            const shared = commonAncestor(grant2.root, root);
            if (shared.length > best.length) best = shared;
          }
          if (!allowedRoot(best)) return;
          target = best;
        }
        const covered = live().filter((grant2) => within(grant2.root, target));
        if (covered.length > 0) {
          await Promise.all(covered.map(close));
          if (covered.some((grant2) => grant2.root !== target)) counters.widened++;
          else counters.renewed++;
        }
        await client.flush();
        paused = true;
        await quiet();
        const inos = rangeOf.has(target) ? rangeOf.get(target) * 2 : options.grantInos ?? GRANT_INOS;
        let granted;
        try {
          charge("fsAcquireExclusiveMutation");
          granted = await port.acquire("/" + target, { reads: true, inos, bytes: GRANT_BYTES });
        } catch (error) {
          if (error?.code !== "ENOENT") refusedRoots.add(target);
          counters.grantsRefused++;
          return;
        }
        rangeOf.set(target, inos);
        const grant = {
          root: granted.root,
          owner: granted.owner,
          umask: granted.umask ?? 18,
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
        for (const key of [...mutations.keys()]) if (within(key, root) || within(root, key)) mutations.delete(key);
        schedule();
      });
    };
    const heldGrant = (key) => grants.find((grant) => !grant.ended && !grant.closing && !grant.shared && within(key, grant.root));
    const client = {
      holder(key) {
        const held = heldGrant(key);
        if (held !== void 0) {
          if (pendingSyncOps >= DECIDED_BACKLOG_OPS || pendingSyncBytes >= DECIDED_BACKLOG_BYTES) return void 0;
          held.lastUsed = now();
          return held;
        }
        if (session.grants === void 0 || settling) return void 0;
        if (grants.some((grant) => !grant.ended && within(key, grant.root))) return void 0;
        let deepest;
        for (let root = parentKey(key); allowedRoot(root); root = parentKey(root)) {
          if ([...refusedRoots].some((refused) => within(root, refused))) break;
          const seen = (mutations.get(root) ?? 0) + 1;
          mutations.set(root, seen);
          if (seen >= grantAfter && deepest === void 0) deepest = root;
        }
        if (deepest !== void 0) claim(deepest);
        return void 0;
      },
      number(grant) {
        const held = grant;
        if (held.ended || held.closing || held.nextIno >= held.endIno) return void 0;
        if (held.endIno - held.nextIno <= held.inos / 4) queueMicrotask(() => claim(held.root));
        return held.nextIno++;
      },
      draw(grant, bytes) {
        const held = grant;
        if (held.ended || held.bytesLeft < bytes) return false;
        held.bytesLeft -= bytes;
        return true;
      },
      held(key) {
        return heldGrant(key);
      },
      holds(key) {
        return grants.some((grant) => !grant.ended && within(key, grant.root));
      },
      pending() {
        return queue.length > 0 || inFlight !== null;
      },
      submit(op, submitOptions) {
        const acknowledged = submitOptions?.acknowledged === true;
        const named = pathsOf(op);
        for (const path of named) if (!canonical(path)) throw fsError("EINVAL", `EINVAL: not a filesystem path the session takes: '${path}'`, path);
        const parts = pieces(op);
        const bytes = parts.reduce((sum, part) => sum + (part.type === "call" && "data" in part.call ? part.call.data.byteLength : 0), 0);
        if (acknowledged && pendingSyncBytes + bytes > syncCap) {
          throw fsError("ENOMEM", `ENOMEM: ${pendingSyncBytes} bytes of synchronous writes are waiting for the session, and this one (${bytes}) would pass the ${syncCap}-byte cap; let the program yield (an await) for them to be sent`, pathsOf(op)[0] ?? "");
        }
        const answers = parts.map((part) => new Promise((resolve, reject) => {
          const partBytes = part.type === "call" && "data" in part.call ? part.call.data.byteLength : 0;
          queue.push({ op: part, seq: 0, order: ++logged, bytes: partBytes, paths: pathsOf(part), acknowledged, resolve, reject });
          pendingBytes += partBytes;
          if (acknowledged) {
            pendingSyncBytes += partBytes;
            pendingSyncOps++;
          }
          counters.ops++;
        }));
        schedule();
        const answer = Promise.all(answers).then((all) => {
          const first = all[0]?.mutation;
          const last = all[all.length - 1];
          if (last === void 0) return {};
          const { mutation: _mutation, ...rest } = last;
          return first !== void 0 && last.mutation !== void 0 ? { ...rest, mutation: { before: first.before, after: last.mutation.after } } : rest;
        });
        if (acknowledged) answer.catch(() => {
        });
        return answer;
      },
      call(name, path, run, callOptions) {
        const acknowledged = callOptions?.acknowledged === true;
        const answer = new Promise((resolve, reject) => {
          queue.push({ op: { type: "run", name, path, run }, seq: 0, order: ++logged, bytes: 0, paths: [path], acknowledged, resolve, reject });
          counters.ops++;
        });
        schedule();
        if (acknowledged) answer.catch(() => {
        });
        return answer.then((answered2) => answered2.value);
      },
      flush() {
        options.drain?.();
        const mark = logged;
        if (answered >= mark) return Promise.resolve();
        const flushed = new Promise((resolve) => {
          marks.push({ mark, resolve });
        });
        schedule();
        return flushed;
      },
      async settle() {
        settling = true;
        if (claiming !== null) await claiming;
        try {
          while (answered < logged) await client.flush();
        } finally {
          if (idleTimer !== null) {
            timers.clearTimeout(idleTimer);
            idleTimer = null;
          }
          for (const grant of live()) await close(grant);
          settling = false;
        }
        const taken = client.takeFailures();
        if (taken.length > 0) {
          throw Object.assign(new Error(
            `${taken.length} filesystem change${taken.length === 1 ? "" : "s"} this process made did not reach the session:
` + taken.map((failure) => `  ${failure.op} ${failure.path}: ${failure.errno}: ${failure.message}`).join("\n")
          ), { code: "EIO", failures: taken });
        }
      },
      takeFailures() {
        return failures.splice(0, failures.length);
      },
      noteFailure(failure) {
        failures.push(failure);
      },
      get pendingBytes() {
        return pendingBytes;
      },
      room(bytes) {
        if (roomWaiters.length === 0 && (windowed === 0 || windowed + bytes <= PROCESS_FS_ROOM_BYTES)) return Promise.resolve(grantRoom(bytes));
        return new Promise((resolve) => {
          roomWaiters.push({ bytes, resolve });
        });
      },
      stats() {
        return { ...counters };
      }
    };
    return client;
  }
  return __toCommonJS(process_fs_client_exports);
})();

const __vfsWriteGenerations = Object.create(null);
// Per-path: the authority revision the resident cell in __vfsBundle is
// known-good at. Only a flush of this facet's own bytes sets one, this
// facet's own partial mutations of a stamped cell advance it, and the
// ACQUIRE barrier is the only reader. An unstamped cell is simply evicted,
// so a mutation path that forgets to stamp costs a refetch and never a
// stale byte. Infinity is not a revision: it is the lease below, held
// while one of this facet's own mutations of the path is in flight.
// Heap cells only: the resident store dates each row in the row itself
// (__nimbusResidentRows), and this map says nothing about those.
const __vfsBundleRevisions = Object.create(null);
// Own mutations in flight per path: the stamp the first lease began with,
// how many are outstanding, whether a receipt has already proven a peer
// wrote inside the window, and the highest revision a barrier reported for
// the path while the lease suppressed it.
//
// Overlapping own mutations of one path are legal — chown and the chmod
// ride-along are not queued behind each other — so a second begin reuses
// the record rather than opening a second window, and an end whose receipt
// reports a `before` past the record's stamp marks `peer`. That verdict
// cannot distinguish a stranger's write from the sibling own mutation still
// in flight, and does not try to: it is a conservative refetch, never
// staleness.
const __vfsOwnLeases = Object.create(null);
// Per path with a PARKED write: the highest revision a barrier reported for
// it while that write was in flight. A parked cell is unstamped, so the
// barrier evicts it and consumes the report; the flush's own revision is
// what finally says whether that report was its own write coming back.
// Bounded by the parked set — the entry is retired with the cell below.
const __vfsParkedReports = Object.create(null);
const __vfsAppendWrites = Object.create(null);
const __vfsWrites = new Proxy(Object.create(null), {
  set(target, path, value) {
    target[path] = value;
    delete __vfsAppendWrites[path];
    delete __vfsParkedReports[path];
    __vfsWriteGenerations[path] = (__vfsWriteGenerations[path] || 0) + 1;
    // Parking a cell is the only signal a synchronous write leaves. It is
    // therefore the one place a write-back can be scheduled from, and it
    // covers every sync mutation — writeFileSync, appendFileSync, the fd
    // writes, rename — with no per-call-site duplication.
    __nimbusScheduleVfsWriteBack();
    return true;
  },
  deleteProperty(target, path) {
    delete __vfsAppendWrites[path];
    delete __vfsParkedReports[path];
    if (Object.prototype.hasOwnProperty.call(target, path)) {
      delete target[path];
      __vfsWriteGenerations[path] = (__vfsWriteGenerations[path] || 0) + 1;
    }
    return true;
  },
});

const __vfsMutationTails = new Map();
const __nimbusPendingVfsMutations = new Set();
let __nimbusPendingVfsMutationFailure;
let __nimbusHasPendingVfsMutationFailure = false;
const __vfsWriteClaims = new Map();
// Per path: this facet's own writes and mutations the authority has been
// asked to apply whose acknowledgement is not adjudicated yet
// (__nimbusOwnAcknowledgement). Each entry settles, never rejects.
const __vfsOwnAcks = new Map();
const __nimbusVfsAppendRangeResult = {};
let __nimbusVfsAppendOperationSequence = 0;

function __nimbusVfsPathKey(path) {
  return String(path).replace(/^\/+/, "");
}

/**
 * The process's filesystem client (core _shared/process-fs-client.ts,
 * spliced ahead of this ledger as __nimbusProcessFsModule): every mutation
 * the program makes reaches the session through it, as a numbered call in
 * its waves, in the order the program made them. Made at first use, with
 * the supervisor read at each call (the opencode runner binds __supervisor
 * late), its timers the raw ones captured below, and published for the
 * runtime's effect and exit boundaries (globalThis.__nimbusProcessFs).
 */
let __nimbusProcessFsInstance = null;
function __nimbusProcessFs() {
  if (__nimbusProcessFsInstance !== null) return __nimbusProcessFsInstance;
  const supervisor = () => {
    const bound = typeof __supervisor !== "undefined" ? __supervisor : null;
    if (!bound) throw Object.assign(new Error("EIO: this process has no supervisor to write to"), { code: "EIO" });
    return bound;
  };
  __nimbusProcessFsInstance = __nimbusProcessFsModule.processFsClient({
    session: {
      // Called as methods of the stub, never through .call/.apply: on an RPC stub those are remote method names too.
      openWriter: (first) => {
        const bound = supervisor();
        return typeof bound.openWaveWriter === "function" ? bound.openWaveWriter(first) : Promise.resolve(null);
      },
      writeBatchStream: (stream, fence, owner) => (owner === undefined
        ? supervisor().writeBatchStream(stream, fence)
        : supervisor().writeBatchStream(stream, fence, owner)),
      // The subtrees the process writes often enough: decided here
      // (__nimbusDecidedHere), sent in its waves, recalled by another's access.
      grants: {
        acquire: (path, delegate) => supervisor().fsAcquireExclusiveMutation(path, { delegate }),
        release: async (owner) => { await supervisor().fsReleaseExclusiveMutation(owner); },
        awaitRecall: (owner, waitMs) => supervisor().fsAwaitRecall(owner, waitMs),
        recalled: async (owner, kind) => { await supervisor().fsRecalled(owner, kind); },
      },
    },
    // Home directories themselves are never held: the shell and the editor live there.
    isHomeRoot: (key) => (key.startsWith("home/") && key.length > 5 && !key.includes("/", 5)) || key === "root",
    timers: { setTimeout: __nimbusRawTimer, clearTimeout: __nimbusRawClearTimer },
  });
  globalThis.__nimbusProcessFs = __nimbusProcessFsInstance;
  return __nimbusProcessFsInstance;
}

/**
 * Log a mutation into the process's client: answered once the session has
 * it (its receipt for a data call), rejected with its errno. Counted as an
 * operation in flight until then (__nimbusPendingOps), so the program is not
 * taken for finished while its write is out.
 */
function __nimbusSubmitVfs(op, acknowledged = false) {
  if (typeof globalThis.__nimbusPendingOps !== "number") globalThis.__nimbusPendingOps = 0;
  // The program's own change, named as it made it: what a run that waits for
  // stdin cannot do twice (the runner's stop-replay, where it has one).
  if (typeof __nimbusStopReplay !== "undefined") __nimbusStopReplay.effect(op.type === "call" ? op.call.call : op.type);
  const answer = __nimbusProcessFs().submit(op, { acknowledged });
  globalThis.__nimbusPendingOps++;
  const settled = () => { globalThis.__nimbusPendingOps--; globalThis.__nimbusHandleReleased?.(); };
  answer.then(settled, settled);
  return answer;
}

/**
 * Whether a change at `path` is decided here: in a subtree the process
 * holds, its async form is answered once it is logged (its sync view is
 * already changed), and the session's answer comes with the log's waves; a
 * refusal then is reported as an acknowledged change's is. Counts the change
 * toward taking the subtree when none is held.
 */
function __nimbusDecidedHere(path, bytes = 0) {
  if (typeof __supervisor === "undefined" || __supervisor === null) return false;
  // What it decided and the session has not answered yet (logged or not)
  // stays under the client's bound: past it, the change waits for its own
  // answer. A process that dies holds at most that, unsent.
  if (__nimbusDecidedOps >= __nimbusProcessFsModule.DECIDED_BACKLOG_OPS
      || __nimbusDecidedBytes + bytes > __nimbusProcessFsModule.DECIDED_BACKLOG_BYTES) return false;
  return __nimbusProcessFs().holder(__nimbusVfsPathKey(path)) !== undefined;
}

/** Changes decided here (__nimbusDecidedHere) the session has not answered: their count and bytes. */
let __nimbusDecidedOps = 0;
let __nimbusDecidedBytes = 0;

/** `work`, a change decided here of `bytes`: counted until the session answers it. */
function __nimbusDecided(work, bytes = 0) {
  __nimbusDecidedOps++;
  __nimbusDecidedBytes += bytes;
  const settled = () => { __nimbusDecidedOps--; __nimbusDecidedBytes -= bytes; };
  Promise.resolve(work).then(settled, settled);
  return work;
}

/**
 * `work`, a change the program was already told succeeded (a synchronous
 * call, or an async one decided here): not awaited, and its refusal or
 * unknown fate reported as the client reports its own, at the next effect
 * and when the process settles.
 */
function __nimbusAcknowledged(work, syscall, path) {
  if (!work || typeof work.then !== "function") return;
  work.then(undefined, (error) => {
    if (typeof __supervisor === "undefined" || __supervisor === null) return;
    const code = error && typeof error.code === "string" ? error.code : "EIO";
    __nimbusProcessFs().noteFailure({ op: syscall, path: __nimbusVfsPathKey(path), errno: code, message: error && error.message ? error.message : String(error) });
  });
}

/** A mutation no call record carries, made by `run` in its place in the client's log (ProcessFsClient.call). */
function __nimbusVfsCall(name, path, run) {
  if (typeof globalThis.__nimbusPendingOps !== "number") globalThis.__nimbusPendingOps = 0;
  if (typeof __nimbusStopReplay !== "undefined") __nimbusStopReplay.effect(name);
  const answer = __nimbusProcessFs().call(name, __nimbusVfsPathKey(path), run);
  globalThis.__nimbusPendingOps++;
  const settled = () => { globalThis.__nimbusPendingOps--; globalThis.__nimbusHandleReleased?.(); };
  answer.then(settled, settled);
  return answer;
}

/** A cell's bytes, as a data call carries them. */
function __nimbusVfsCellBytes(content) {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

/**
 * Errno values that are the filesystem ANSWERING the syscall: the path is not
 * there, it is a directory, the descriptor is closed. The operation did not
 * apply, no bytes were in flight, and nothing the program believes is saved
 * has been lost. Node hands these to the caller and lets it decide — which is
 * why `fs.truncate(missing).catch(() => {})` is ordinary, correct code.
 *
 * ENOSPC is one of them: the session's storage ledger (N18) refuses a write
 * before any of it is made. So are EROFS (a read-only mount) and EBUSY (an
 * exclusive-mutation lease): the namespace refuses those before the backend
 * is called.
 *
 * Everything else — EIO, a dropped RPC, an authority that died, an
 * error carrying no errno at all — is not an answer. It means the outcome of
 * a write is UNKNOWN, and that is a durability event no matter what the
 * program caught. Unrecognised is treated as durability-class on purpose: the
 * safe direction is to surface.
 */
const __NIMBUS_SYSCALL_VERDICT_CODES = new Set([
  "ENOENT", "EEXIST", "EISDIR", "ENOTDIR", "ENOTEMPTY",
  "EBADF", "EINVAL", "EPERM", "EACCES", "ELOOP", "ENAMETOOLONG", "ENOSPC",
  "EROFS", "EBUSY",
]);

function __nimbusIsDurabilityFailure(error) {
  if (error && typeof error === "object" && error.nimbusRefusedWriteBack === true) return true;
  const code = error && typeof error === "object" ? error.code : undefined;
  return typeof code !== "string" || !__NIMBUS_SYSCALL_VERDICT_CODES.has(code);
}

/**
 * Everything already queued for `path` and for every proper ancestor of it,
 * as of NOW — a snapshot, not a subscription.
 *
 * The queue orders mutations per path and nothing else, so `mkdirSync(a)`
 * followed by anything under `a` — `mkdirSync(a/b)`, a flushed write of
 * `a/f`, an `fs.promises.open(a/f, "w")` — could reach the authority
 * ahead of the directory it lives in and be answered ENOENT for a parent
 * the program had demonstrably created. node-tar does exactly this for
 * every entry it extracts.
 *
 * Snapshotting at call time is what keeps the graph acyclic: a mutation
 * only ever waits on mutations that were queued before it, in program
 * order. Capturing the tails inside the mutation body instead would let a
 * rename queued behind a slow ancestor pick up a descendant that was
 * queued after it — and that descendant is already waiting on the rename.
 *
 * Map lookups only; resolves on the next tick when nothing is pending.
 * Tails never reject, so neither does this.
 */
function __nimbusAwaitAncestorMutations(path) {
  const pending = [];
  let prefix = "";
  for (const segment of __nimbusVfsPathKey(path).split("/")) {
    if (!segment) continue;
    prefix = prefix ? prefix + "/" + segment : segment;
    const tail = __vfsMutationTails.get(prefix);
    if (tail) pending.push(tail);
  }
  return pending.length === 0 ? Promise.resolve() : Promise.all(pending).then(() => undefined);
}

/**
 * Everything already queued strictly BELOW `path`, as of now. The
 * complement of the ancestor wait, for the two mutations that act on a
 * whole subtree: rmdir needs the children gone first, and a rename must
 * not carry the old name across while a mutation under it is still bound
 * for the old name.
 */
function __nimbusAwaitSubtreeMutations(path) {
  const prefix = __nimbusVfsPathKey(path) + "/";
  const pending = [];
  for (const [key, tail] of __vfsMutationTails) {
    if (key.startsWith(prefix)) pending.push(tail);
  }
  return pending.length === 0 ? Promise.resolve() : Promise.all(pending).then(() => undefined);
}

/**
 * Order a mutation behind the others queued for the same path.
 *
 * A rejection is ALSO reported to the drain when it is durability-class. That
 * second channel is not redundancy: the tail handler below marks `result`
 * handled, which suppresses the platform's own `unhandledrejection` signal,
 * so retention is the only thing that can reach a durability boundary. Losing
 * it is how a handler whose write failed still answers 200 — silent wrong
 * data, which is what this ledger exists to prevent.
 *
 * What must NOT be retained is a plain syscall verdict. The queue used to
 * retain those too, so an error the program had already caught was delivered
 * a second time at teardown and killed the process: `opencode --help`
 * rendered its whole help surface and then exited 1 on the
 * `fs.truncate(logfile).catch(() => {})` in its logger init.
 *
 * The seam is the ERROR, not the call site. The same source line —
 * `fs.promises.truncate(p).catch(() => {})` — must exit 0 when the file was
 * simply absent, and must fail the response when the authority could not say
 * whether the write landed. No per-call-site flag can express that, because
 * both cases arrive through the same call site.
 */
function __nimbusQueueVfsMutation(path, mutation, retainFailure = true) {
  const key = __nimbusVfsPathKey(path);
  const previous = __vfsMutationTails.get(key) || Promise.resolve();
  // Every queued mutation is ordered behind the structural mutations
  // pending for its ancestors — one place, so a flushed write, an fd write
  // and a queued mkdir all obey the same rule without each site knowing it.
  const ancestors = __nimbusAwaitAncestorMutations(key);
  const result = previous.then(() => ancestors).then(mutation);
  __nimbusPendingVfsMutations.add(result);
  // A failed mutation rejects its own caller but must not poison later writes
  // for the same path or become an unhandled queue-cleanup rejection.
  let tail;
  const clearTail = () => {
    __nimbusPendingVfsMutations.delete(result);
    if (__vfsMutationTails.get(key) === tail) {
      __vfsMutationTails.delete(key);
    }
  };
  tail = result.then(clearTail, (error) => {
    if (retainFailure
        && __nimbusIsDurabilityFailure(error)
        && !__nimbusHasPendingVfsMutationFailure) {
      __nimbusHasPendingVfsMutationFailure = true;
      __nimbusPendingVfsMutationFailure = error;
    }
    clearTail();
  });
  __vfsMutationTails.set(key, tail);
  return result;
}

/**
 * Run `work` as an acknowledgement in flight for `path`: one of this
 * facet's own writes or mutations of it, from being issued to the authority
 * through adjudicating what the authority answered — the stamp that dates
 * the cell, or the eviction when a barrier's report outran it.
 *
 * Until then the facet cannot tell whether the authority has applied it, or
 * at which revision, and a barrier that reported the path cannot tell whether
 * that report was this very write or a peer's after it. Served, the facet's
 * own bytes would then be read past a peer that overwrote them — beside
 * another path the same peer wrote afterwards, read new. So no resumption
 * runs while such a report is outstanding against one of these
 * (__nimbusReportedOwnAcknowledgements). A write that is only parked is not
 * in flight: it has not reached the authority, cannot have been applied
 * before any report, and will be applied after every one it has missed.
 *
 * `generation` is the parked cell a whole-file write-back carries
 * (__vfsWriteGenerations): once a newer one is parked over it, that newer
 * cell is what the facet serves, and this acknowledgement no longer says
 * anything about the bytes a resumption would read.
 */
function __nimbusOwnAcknowledgement(path, work, generation) {
  const key = __nimbusVfsPathKey(path);
  const acked = work();
  const ack = { settled: acked.then(() => undefined, () => undefined), generation };
  let held = __vfsOwnAcks.get(key);
  if (!held) {
    held = new Set();
    __vfsOwnAcks.set(key, held);
  }
  held.add(ack);
  ack.settled.then(() => {
    held.delete(ack);
    if (held.size === 0 && __vfsOwnAcks.get(key) === held) __vfsOwnAcks.delete(key);
  });
  return acked;
}

/**
 * The own acknowledgements in flight for every path that carries a report
 * noted while its write or mutation was out (__nimbusNoteVfsReport) — by the
 * barrier asking or by any before it — as of NOW, settling together; null
 * when there are none. A barrier waits on these before its resumption runs.
 *
 * The reports an answer names are noted before it is admitted, so they are
 * among them. So is one an earlier barrier noted and is still waiting on:
 * that barrier moved the cursor past it, and an answer asked for from there
 * does not name it again, but the own bytes are no fresher for that.
 * Once an acknowledgement lands, its adjudication has decided — a report at
 * or below its revision was this facet's own write coming back and the cell
 * is dated; one above it was a peer writing after, and the cell is evicted
 * and owed a refetch — and the report is retired with it.
 *
 * A write-back whose cell has been superseded is left out: a newer write of
 * the path is parked over it, and no mutation of the path is out beside it.
 * The facet serves that newer cell, which is only parked, so it will be
 * applied above every report made so far. Waiting on the older one would
 * stall a program that writes and yields in a loop on each of its own writes
 * coming back, for nothing it reads.
 */
function __nimbusReportedOwnAcknowledgements() {
  const pending = [];
  for (const [key, held] of __vfsOwnAcks) {
    const lease = __vfsOwnLeases[key];
    if (__vfsParkedReports[key] === undefined && !(lease && lease.reported !== -1)) continue;
    const parkedOver = lease === undefined && Object.prototype.hasOwnProperty.call(__vfsWrites, key);
    for (const ack of held) {
      if (parkedOver && ack.generation !== undefined && ack.generation !== __vfsWriteGenerations[key]) continue;
      pending.push(ack.settled);
    }
  }
  return pending.length === 0 ? null : Promise.all(pending);
}

/**
 * Note a report no answer could name, on every path with an own
 * acknowledgement in flight. A poison, a barrier with no answer, a repair
 * that vouched for nothing: each moves on without saying what changed, so
 * each of those writes is adjudicated as though a peer wrote after it — a
 * refetch, never a stale byte.
 */
function __nimbusNoteUnnamedReports() {
  for (const key of __vfsOwnAcks.keys()) __nimbusNoteVfsReport(key, Infinity);
}

async function __nimbusDrainVfsMutations() {
  while (__nimbusPendingVfsMutations.size > 0) {
    await Promise.allSettled([...__nimbusPendingVfsMutations]);
  }
  if (__nimbusHasPendingVfsMutationFailure) {
    const failure = __nimbusPendingVfsMutationFailure;
    __nimbusHasPendingVfsMutationFailure = false;
    __nimbusPendingVfsMutationFailure = undefined;
    throw failure;
  }
}

function __nimbusCapturePendingVfsAppend(path) {
  const key = __nimbusVfsPathKey(path);
  const append = __vfsAppendWrites[key];
  return append && append.generation === __vfsWriteGenerations[key]
    ? append
    : null;
}

function __nimbusConcatVfsBytes(left, right) {
  const bytes = new Uint8Array(left.byteLength + right.byteLength);
  bytes.set(left, 0);
  bytes.set(right, left.byteLength);
  return bytes;
}

function __nimbusRecordVfsAppend(path, delta, fragment, previous) {
  const key = __nimbusVfsPathKey(path);
  const chain = previous ? previous.chain : { pending: [] };
  let operation;
  if (previous &&
      !previous.claimed &&
      !chain.pending.includes(previous.operation)) {
    operation = previous.operation;
    operation.bytes = __nimbusConcatVfsBytes(operation.bytes, delta);
  } else {
    operation = {
      id: String(++__nimbusVfsAppendOperationSequence),
      bytes: delta.slice(),
    };
  }
  __vfsAppendWrites[key] = {
    generation: __vfsWriteGenerations[key],
    fragment,
    chain,
    operation,
    claimed: false,
  };
}

function __nimbusCaptureVfsWrite(path) {
  const key = __nimbusVfsPathKey(path);
  if (!Object.prototype.hasOwnProperty.call(__vfsWrites, key)) return null;
  return {
    key,
    content: __vfsWrites[key],
    generation: __vfsWriteGenerations[key],
    append: __nimbusCapturePendingVfsAppend(key),
  };
}

function __nimbusVfsAppendOperations(snapshot) {
  const operations = snapshot.append.chain.pending.slice();
  if (!operations.includes(snapshot.append.operation)) {
    operations.push(snapshot.append.operation);
  }
  return operations;
}

function __nimbusBeginVfsAppendOperation(snapshot, operation) {
  if (!snapshot.append.chain.pending.includes(operation)) {
    snapshot.append.chain.pending.push(operation);
  }
}

function __nimbusCommitVfsAppendOperation(snapshot, operation) {
  const index = snapshot.append.chain.pending.indexOf(operation);
  if (index !== -1) snapshot.append.chain.pending.splice(index, 1);
}

/**
 * The authority refused a parked write outright (a syscall verdict:
 * EACCES, EPERM, EISDIR...). The bytes are not the file's and never will
 * be, so the process stops serving them: the parked cell of that generation
 * and any resident copy go, and the shims forget what they recorded of the
 * path, so the next read asks the authority. When no caller will see the
 * rejection (`unseen`: a sync write carried across later), the refusal is
 * retained and reported at exit; an async writer gets it as its verdict.
 */
function __nimbusRefuseParkedWrite(snapshot, error, unseen) {
  if (__vfsWriteGenerations[snapshot.key] === snapshot.generation) {
    delete __vfsWrites[snapshot.key];
    if (typeof __vfsBundle !== "undefined" && __vfsBundle) delete __vfsBundle[snapshot.key];
    const refused = globalThis.__nimbusVfsWriteRefused;
    if (typeof refused === "function") refused(snapshot.key);
  }
  if (unseen && error && typeof error === "object") {
    try { error.nimbusRefusedWriteBack = true; } catch {}
  }
  return error;
}

function __nimbusRunVfsWriteMutation(snapshot, mutation, retainFailure, unseen) {
  return __nimbusQueueVfsMutation(snapshot.key, () => __nimbusOwnAcknowledgement(snapshot.key, async () => {
    let value;
    try {
      value = await mutation(snapshot.content, snapshot);
    } catch (error) {
      // A verdict is the authority's answer; anything else (the client could
      // not get one) may have landed. A whole write's parked bytes stay (sent
      // again, they replace the same file); an append's go, as refused: sent
      // again under a new number, it could land twice.
      if (!__nimbusIsDurabilityFailure(error) || snapshot.append) throw __nimbusRefuseParkedWrite(snapshot, error, unseen);
      throw error;
    }
    if (__vfsWriteGenerations[snapshot.key] === snapshot.generation) {
      // What the barriers reported for this path while the write was in
      // flight. Read before the parked cell is retired below, which drops it.
      const reported = __vfsParkedReports[snapshot.key];
      if (snapshot.append &&
          value === __nimbusVfsAppendRangeResult &&
          typeof __vfsBundle !== "undefined" &&
          __vfsBundle) {
        delete __vfsBundle[snapshot.key];
      } else if (typeof value === "number" &&
                 typeof __vfsBundle !== "undefined" &&
                 __vfsBundle &&
                 !(snapshot.key in __vfsBundle) &&
                 !(reported > value)) {
        // The barrier that evicted the resident copy was answered AHEAD of
        // this very write (see __nimbusBeginOwnMutation for why that
        // ordering is ordinary): it reported the path at the revision this
        // write produced, which is the revision about to be stamped, and
        // the bytes in hand are the authority's content AT that revision.
        // So reinstall them rather than let the identity check below
        // decline and leave the facet holding nothing — a sync read of a
        // file the program just wrote whole would fail EAGAIN.
        //
        // A peer's earlier write was overwritten by this whole-file write.
        // A peer's LATER one is reported ABOVE this revision, and the guard
        // above is that test: reported later, the bytes in hand are not
        // what the authority serves and the eviction stands — a refetch,
        // never a stale byte. The parked cell is dropped right after, so a
        // reinstalled copy is the one the sync view serves.
        __vfsBundle[snapshot.key] = snapshot.content;
      }
      delete __vfsWrites[snapshot.key];
      __nimbusStampFlushedCell(snapshot, value, reported);
    }
    return value;
  }, snapshot.generation), retainFailure);
}

/**
 * Whether this facet's resident set is the SQLite store
 * (vfs/facet-resident-store.ts), which the resident node body splices ahead
 * of this ledger. Its rows carry their own revision, so a stamp is written
 * into the row, and __vfsBundleRevisions — which describes heap cells — says
 * nothing about them.
 */
function __nimbusResidentRows() {
  return typeof __residentStamp === "function"
    && typeof __residentReady !== "undefined"
    && __residentReady === true;
}

/**
 * Record the authority revision a just-flushed cell is known-good at.
 *
 * The barrier reports back every path mutated since the facet's cursor,
 * which includes the facet's OWN writes — the invalidation log has no way
 * to know who caused an entry. Without a stamp the facet drops the cells it
 * authored the instant it flushes them, and a resumption then refetches
 * bytes it is already holding: a self-inflicted cold cache on exactly the
 * files a scaffolder or a build just wrote.
 *
 * A "skip paths I wrote" rule would be unsound — a peer may write the same
 * path after us, and that invalidation is real. The revision separates
 * them: a report AT our revision is our own write coming back, a report
 * ABOVE it is somebody else's and still evicts.
 *
 * Guarded on cell identity rather than on the flush alone. A read that
 * raced the flush may have refilled the cell from an older revision, and
 * stamping that with our newer one would pin a stale byte — the one
 * outcome this whole protocol exists to prevent.
 *
 * Only the written path is stamped, never its parent — deliberately, and it
 * is why a batch of writes still costs ONE invalidation rather than none.
 * Every mutation reports its parent directory too, so stamping the parent
 * here looks like the obvious way to reach zero. It is not: the same
 * revision on the directory would also vouch for a peer's earlier change to
 * the DIRECTORY ITSELF — a chmod at a revision this facet never acquired —
 * and that stale mode would then survive the barrier. The write knows what
 * it did to the file and nothing about the directory. Do not "finish" this
 * by stamping the parent.
 */
function __nimbusStampFlushedCell(snapshot, revision, reported) {
  if (typeof revision !== "number") return;
  if (typeof __vfsBundle === "undefined" || !__vfsBundle) return;
  if (__nimbusResidentRows()) {
    // The row held this write's bytes as the store's own-write revision,
    // which no barrier evicts, so every barrier inside the window KEPT it and
    // consumed its report. Those reports are judged here, against the
    // revision this write produced: at or below it is this write coming
    // back, or a write it overwrote; above it, a peer wrote after, and the
    // eviction those barriers could not perform is owed now. The store dates
    // only a row still holding own bytes, which is the identity guard below
    // in the form rows allow: a fill never replaces own bytes, and a later
    // write of the path fails the generation test before this is reached.
    if (reported > revision) {
      __nimbusEvictLeasedCell(snapshot.key);
      return;
    }
    __residentStamp(snapshot.key, revision);
    return;
  }
  if (__vfsBundle[snapshot.key] !== snapshot.content) return;
  __vfsBundleRevisions[snapshot.key] = revision;
}

/**
 * Take an own-mutation lease on a held cell.
 *
 * One of the facet's OWN partial mutations (ranged write, truncate, utimes,
 * chmod, chown) bumps the path's revision exactly as a flush does, and the
 * ACQUIRE barrier that reports it back cannot tell who caused it. Stamping
 * once the RPC answers is not enough, because the two are CONCURRENT: the
 * supervisor answers `fsAcquire` from memory at once, while a write's
 * response waits on the Durable Object's output gate for durability. So a
 * barrier issued AFTER this facet's own write can be ANSWERED BEFORE that
 * write's response arrives. Its delta lists the path at the write's new
 * revision, the facet's stamp is still the old one, the cell the facet is
 * about to overlay is evicted out from under it, and the next
 * `readFileSync` fails EAGAIN on bytes the program wrote itself.
 * Intermittent, and it is what create-astro shows on staging — the README
 * its extract wrote, read synchronously right after.
 *
 * So the cell is HELD for the whole window instead, and the receipt decides
 * at the end (`__nimbusEndOwnMutation`). `Infinity` is what the barrier's
 * `stamp >= entry.rev` reads as "mine" for every revision it could report
 * while the RPC is in flight.
 *
 * An UNSTAMPED cell is not leased: it keeps today's evict-and-refetch, so a
 * mutation path that never stamps still costs a refetch and never a stale
 * byte. `false` says no lease was taken and the end is a no-op.
 *
 * In the resident store the row is the stamp, so the store holds the row as
 * own bytes for the window (`__residentLease`, which the barrier keeps the
 * way it keeps an Infinity stamp) and hands back the revision it was dated
 * at; the lease record carries that revision exactly as it does here.
 */
function __nimbusBeginOwnMutation(key) {
  if (__nimbusResidentRows()) {
    const open = __vfsOwnLeases[key];
    if (open) { open.pending++; return true; }
    const dated = __residentLease(key);
    if (dated === undefined) return false;
    __vfsOwnLeases[key] = { stamp: dated, pending: 1, peer: false, reported: -1 };
    return true;
  }
  const stamp = __vfsBundleRevisions[key];
  if (stamp === undefined) return false;
  const lease = __vfsOwnLeases[key]
    || (__vfsOwnLeases[key] = { stamp, pending: 0, peer: false, reported: -1 });
  lease.pending++;
  __vfsBundleRevisions[key] = Infinity;
  return true;
}

/**
 * Remember a revision the ACQUIRE barrier has just reported for a path one
 * of this facet's own writes is in flight for. Called for every reported
 * path; a no-op for the ones nothing of ours is touching.
 *
 * A barrier answered inside that window is the whole problem this file is
 * solving, and its report is CONSUMED — the cursor advances past it and
 * nothing will ever raise that revision again. Whether it was this facet's
 * own write coming back or a peer's cannot be decided then, so the number
 * is kept until the write's own revision arrives and can decide it:
 *
 *  - a leased cell had the report SUPPRESSED (the stamp reads Infinity for
 *    every revision), so `__nimbusEndOwnMutation` applies the barrier's own
 *    test against the stamp the receipt settles on.
 *  - a PARKED cell is unstamped, so the barrier evicted it legitimately;
 *    `__nimbusRunVfsWriteMutation` uses this to tell a report of its own
 *    write (put the bytes back) from a peer's later one (leave them gone).
 *
 * Neither can be answered by the receipt alone: it is read in the
 * mutation's own turn, so a peer writing after the mutation landed and
 * before its response arrived is invisible to it.
 */
function __nimbusNoteVfsReport(key, revision) {
  const lease = __vfsOwnLeases[key];
  if (lease && revision > lease.reported) lease.reported = revision;
  if (Object.prototype.hasOwnProperty.call(__vfsWrites, key) &&
      !(__vfsParkedReports[key] >= revision)) {
    __vfsParkedReports[key] = revision;
  }
}

/**
 * `__nimbusNoteVfsReport` for a report that covers a subtree: a
 * subtree-scoped or structural delta entry, which stands for changes at or
 * under `prefix` that it does not name. Every path there that one of this
 * facet's own writes or mutations is in flight for gets the report.
 */
function __nimbusNoteVfsReportUnder(prefix, revision) {
  const under = prefix + "/";
  const keys = new Set([...Object.keys(__vfsOwnLeases), ...Object.keys(__vfsWrites)]);
  for (const key of keys) {
    if (key === prefix || key.startsWith(under)) __nimbusNoteVfsReport(key, revision);
  }
}

/**
 * End one own-mutation lease, and settle the stamp when it was the last.
 *
 * The receipt carries the path's revision on either side of the mutation,
 * both read in the RPC's own synchronous turn:
 *
 *  - `before` at or below the stamp the lease began with — nobody else
 *    touched the path in the window, so the cell with the local effect
 *    applied IS what the authority serves at `after`, and the stamp
 *    advances there.
 *  - `before` past it — a peer wrote inside the window, and the barrier
 *    that would have evicted was suppressed by this lease. The end owes
 *    that eviction, so it performs it.
 *  - no receipt at all (the RPC threw) — the outcome is unknown, which is
 *    handled exactly as a peer's write is.
 *
 * Then every report the lease suppressed is adjudicated against the stamp
 * it settled on: a report ABOVE it is a mutation this receipt does not
 * account for, so the eviction the barrier did not perform is performed
 * here (see `__nimbusNoteVfsReport`).
 *
 * A cell that stopped being held during the window (a poison drop, a
 * parked sync write retiring the stamp) has nothing left to vouch for, so
 * no stamp is restored for it. In the resident store a write parked over
 * the row inside the window owns it from then on, and its flush dates it.
 */
function __nimbusEndOwnMutation(key, held, receipt) {
  if (!held) return;
  const lease = __vfsOwnLeases[key];
  if (!lease) return;
  lease.pending--;
  if (receipt && typeof receipt.before === "number" && typeof receipt.after === "number") {
    if (lease.stamp >= receipt.before) lease.stamp = receipt.after;
    else lease.peer = true;
  } else {
    lease.peer = true;
  }
  if (lease.pending > 0) return;
  delete __vfsOwnLeases[key];
  const evict = lease.peer || lease.reported > lease.stamp;
  if (__nimbusResidentRows()) {
    if (evict) __nimbusEvictLeasedCell(key);
    else if (!Object.prototype.hasOwnProperty.call(__vfsWrites, key)) __residentStamp(key, lease.stamp);
    return;
  }
  const resident = typeof __vfsBundle !== "undefined" && __vfsBundle && key in __vfsBundle;
  if (evict || !resident) {
    delete __vfsBundleRevisions[key];
    if (evict) __nimbusEvictLeasedCell(key);
    return;
  }
  __vfsBundleRevisions[key] = lease.stamp;
}

/**
 * Drop a cell the way the shims' own invalidation does.
 *
 * Content view, stat view and the invalidation count move together in the
 * shims' `_evictResident`, and this source is spliced AHEAD of that
 * closure, so the lease asks through the hook it publishes rather than
 * keeping a second eviction path in step with it. A ledger embedded without
 * the shims has no stat view to keep coherent, and the content view is then
 * all there is to drop.
 */
function __nimbusEvictLeasedCell(key) {
  const evict = globalThis.__nimbusEvictResidentCell;
  if (typeof evict === "function") { evict(key); return; }
  if (typeof __vfsBundle !== "undefined" && __vfsBundle) delete __vfsBundle[key];
}

/** `unseen`: no caller awaits this flush, so a refusal must be retained to be heard. */
function __nimbusFlushVfsWrite(path, mutation, retainFailure = true, unseen = false) {
  const snapshot = __nimbusCaptureVfsWrite(path);
  if (!snapshot) {
    // Nothing parked: what was is already in flight (a directory rename
    // sends its descendants' writes ahead of it), and flushing the path
    // means waiting for that write to land.
    const inFlight = __vfsWriteClaims.get(__nimbusVfsPathKey(path));
    return inFlight ? inFlight.promise : Promise.resolve(undefined);
  }
  const existing = __vfsWriteClaims.get(snapshot.key);
  if (existing && existing.generation === snapshot.generation) {
    return existing.promise;
  }
  if (snapshot.append) snapshot.append.claimed = true;
  const result = __nimbusRunVfsWriteMutation(snapshot, mutation, retainFailure, unseen);
  const claim = { generation: snapshot.generation, promise: result };
  __vfsWriteClaims.set(snapshot.key, claim);
  const release = () => {
    if (__vfsWriteClaims.get(snapshot.key) === claim) {
      __vfsWriteClaims.delete(snapshot.key);
    }
  };
  result.then(() => {
    release();
    // The authority accepted the bytes: the shims learn what it made of the
    // path (owner, mode) for their sync view.
    const landed = globalThis.__nimbusVfsWriteLanded;
    if (typeof landed === "function") landed(snapshot.key);
  }, () => {
    release();
    if (snapshot.append &&
        __vfsAppendWrites[snapshot.key] === snapshot.append) {
      snapshot.append.claimed = false;
    }
  });
  return result;
}

async function __nimbusPersistVfsWrite(supervisor, path, content, snapshot) {
  const key = __nimbusVfsPathKey(path);
  if (snapshot.append) {
    // Each append the process made, as its own call: the client's cursor
    // answers a re-sent one rather than appending it twice.
    for (const operation of __nimbusVfsAppendOperations(snapshot)) {
      __nimbusBeginVfsAppendOperation(snapshot, operation);
      const release = await __nimbusProcessFs().room(operation.bytes.byteLength);
      try { await __nimbusSubmitVfs({ type: "call", call: { call: "appendFile", path: key, mode: 0o666, data: operation.bytes } }); }
      finally { release(); }
      __nimbusCommitVfsAppendOperation(snapshot, operation);
    }
    return __nimbusVfsAppendRangeResult;
  }
  // The revision this write produced. It is what lets the ACQUIRE barrier
  // tell this facet's own mutation apart from a peer's. Logged a window at a
  // time: a drain of thousands of parked cells never holds them all twice.
  // The window is asked before the cell is encoded: thousands of parked
  // cells waiting for one are never all encoded at once.
  const release = await __nimbusProcessFs().room(typeof content === "string" ? content.length : content.byteLength);
  let answer;
  try { answer = await __nimbusSubmitVfs({ type: "call", call: { call: "writeFile", path: key, mode: 0o666, data: __nimbusVfsCellBytes(content) } }); }
  finally { release(); }
  return answer.receipt?.revision;
}

/**
 * Write back the cells parked at THIS instant, and only those.
 *
 * Bounded on purpose, and deliberately not routed through
 * `__nimbusDrainVfsWrites`, whose `while (pending > 0)` waits for the mutation
 * queue to be EMPTY. That wait is correct at process exit, where no new writes
 * are coming. Anywhere else it is a livelock: a facet unpacking a tarball adds
 * mutations faster than the loop retires them, so the loop never returns.
 * Sited ahead of egress — where it was — that stopped the request from ever
 * leaving the facet, and `npx sv create` ran, printed its intro, and then
 * never reported an exit at all. A barrier may delay a request; it may not
 * wait on a condition a busy process never reaches.
 *
 * Failures are retained rather than thrown. The two callers — the debounce
 * below, and the RELEASE barrier ahead of egress — have no frame that could
 * act on one: rejecting the fetch that happened to trigger the flush would
 * blame the wrong operation. The exit drain reports what is retained, so a
 * lost write is loud exactly once and never silent.
 */
async function __nimbusFlushVfsWriteBack(supervisor) {
  if (!supervisor) return;
  const paths = Object.keys(__vfsWrites);
  if (paths.length === 0) return;
  await Promise.allSettled(paths.map((path) => __nimbusFlushVfsWrite(
    path,
    (content, snapshot) => __nimbusPersistVfsWrite(supervisor, path, content, snapshot),
    true,
    true,
  )));
}

/**
 * A synchronous write can only park bytes in `__vfsWrites`: a sync syscall
 * has no channel to the authority. Something else therefore has to carry
 * them across, and the only thing that did was the drain at process exit —
 * so a resident server that writes synchronously never wrote back at all,
 * and a peer reading the same path got the pre-write bytes for the whole
 * life of the process. Measured, not theorised: `writeFileSync` then 50 ms
 * left the authority at null with zero write RPCs issued.
 *
 * Flushing on every write is not the repair — 500 sync writes would become
 * 500 round trips, and an npm install writes thousands. Debounce instead:
 * parking a cell schedules one write-back, and every write that lands before
 * it fires joins that same batch. Steady state costs no more round trips
 * than the exit drain already paid; what changes is when they happen.
 *
 * The timer is the raw platform one, captured before the shims wrap
 * `setTimeout` with the VFS resumption barrier: a write-back is the shim's
 * own infrastructure, not a user resumption, and must not pay an ACQUIRE to
 * deliver an ACQUIRE.
 */
const __NIMBUS_VFS_WRITE_BACK_DELAY_MS = 10;
const __nimbusRawTimer = globalThis.setTimeout;
const __nimbusRawClearTimer = globalThis.clearTimeout;
let __nimbusVfsWriteBackTimer = null;
function __nimbusScheduleVfsWriteBack() {
  if (__nimbusVfsWriteBackTimer !== null) return;
  if (typeof __nimbusRawTimer !== 'function') return;
  __nimbusVfsWriteBackTimer = __nimbusRawTimer(() => {
    __nimbusVfsWriteBackTimer = null;
    const supervisor = typeof __supervisor !== 'undefined' ? __supervisor : null;
    if (!supervisor) return;
    // Not registered in __nimbusPendingVfsMutations: each write it starts
    // registers itself there through __nimbusQueueVfsMutation, so the exit
    // drain already awaits the work. Registering the orchestration too would
    // add an entry nothing ever removes, and that set is drained by a
    // while-loop on its size.
    void __nimbusFlushVfsWriteBack(supervisor);
  }, __NIMBUS_VFS_WRITE_BACK_DELAY_MS);
}

async function __nimbusDrainVfsWrites(supervisor) {
  const paths = Object.keys(__vfsWrites);
  const outcomes = await Promise.allSettled([
    // Each sent once: the process's client re-sends a write whose answer was
    // lost (under its number, so it applies once), and what it could not
    // send is a failure, not another attempt.
    ...paths.map((path) => __nimbusFlushVfsWrite(
      path,
      (content, snapshot) =>
        __nimbusPersistVfsWrite(supervisor, path, content, snapshot),
      false,
      true,
    )),
    __nimbusDrainVfsMutations(),
  ]);
  const failure = outcomes.find((outcome) => outcome.status === "rejected");
  if (failure) throw failure.reason;
  // Everything the process made, answered; a change it was told succeeded
  // that the session refused or never answered fails the run, by name.
  if (__nimbusProcessFsInstance !== null) await __nimbusProcessFsInstance.settle();
}