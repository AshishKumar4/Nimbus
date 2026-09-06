/**
 * session/rpc.ts — Supervisor RPC + W8 child_process + legacy VFS impls.
 *
 * Why free-functions instead of class methods:
 * the DO RPC fabric calls these by name, so the supervisor's class
 * MUST keep the method names as delegators (otherwise the fabric
 * looks them up and finds nothing). Putting the bodies in free
 * functions and having the class methods one-line-delegate keeps
 * the class file small AND lets these be unit-tested without a DO
 * harness (the `RpcHost` parameter is a narrow contract).
 *
 * Bodies for every `_rpc*`, `vfs*`, `_emit*`, and `_reportExternalExit`
 * method live here. The class retains the method NAMES as one-line
 * delegators in src/session/nimbus-session.ts.
 * 1-line delegators (per plan §IX.4 R1: DO RPC fabric uses name dispatch
 * via the stub).
 *
 * Per DEFECT-D1: ctx is taken via `(self as any).ctx` cast where needed
 * (rpcInnerDoFetch uses self.ctx.id and self.ctx.facets; rpcPutRegistryEntries
 * uses self.ctx.storage.sql). The InitHost-style escape applies because
 * these ~3 sites would each need ctx threaded through; cast at boundary
 * is acceptable per plan §IX recommendation 1.
 */
import { enc, dec } from '@nimbus-sh/core/_shared/bytes.js';
import { normalizeTerminalNewlines } from '@nimbus-sh/core/_shared/terminal.js';
import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { getInnerDoClass } from '@nimbus-sh/fabric/inner-do-registry.js';
import { NpmCache } from '../npm/cache.js';
import { EsbuildService } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { SqliteRuntimeFsBridge } from '@nimbus-sh/core/runtime/sqlite-runtime-fs-bridge.js';
import { notifyTerminalEvent } from '../runtime/process-logs-api.js';
import { IsolatePool } from '@nimbus-sh/fabric/isolate-pool.js';
import { residentBootSpecSchema, } from '@nimbus-sh/fabric/process-fabric.js';
import { processes, } from '@nimbus-sh/fabric/workerd-facet-host.js';
import { supervisorEntrypoint } from '@nimbus-sh/fabric/composition.js';
import { headerPairs, isolateToken, } from '@nimbus-sh/fabric/process-host.js';
import { OpencodeStageSpecSchema } from '../facets/opencode-staging.js';
import { recordFailure, getLastRpcFrame, getLastFacetId, } from '@nimbus-sh/platform/oom-discriminator.js';
import { classifyError } from '@nimbus-sh/platform/oom-classify.js';
import { acquireSupervisorReadAllocation, } from '@nimbus-sh/platform/heavy-alloc-coord.js';
import { rpcPayloadEnd, rpcPayloadStart, } from '@nimbus-sh/platform/diag-counters.js';
import { CRED_KERNEL, CRED_SESSION_USER, } from '@nimbus-sh/core/runtime/os-contracts.js';
import { getSymlinkRegistry } from '@nimbus-sh/core/vfs/symlink-registry.js';
import { MAX_RPC_SAFE_PAYLOAD_BYTES } from '@nimbus-sh/platform/limits.js';
import { FS_LIST_PAGE_LIMIT, FS_READ_BATCH_PATH_LIMIT, FS_READ_BATCH_REQUEST_BYTES, } from '@nimbus-sh/core/constants.js';
import { routeSessionLoopback } from './loopback.js';
import { clearPortCapability } from './port-capability.js';
import { normalizeVfsPath, parentVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { z } from 'zod/v4';
const WriteBatchInodeSchema = z.object({
    path: z.string(),
    parentPath: z.string(),
    kind: z.enum(['file', 'directory', 'symlink']).optional(),
    isDir: z.boolean(),
    size: z.number(),
    atime: z.number().optional(),
    mtime: z.number(),
    mode: z.number(),
    chunkCount: z.number(),
});
const WriteBatchChunkSchema = z.object({
    path: z.string(),
    chunkId: z.number(),
    data: z.unknown(),
}).passthrough();
const WriteBatchPayloadSchema = z.object({
    inodes: z.array(WriteBatchInodeSchema).default([]),
    chunks: z.array(WriteBatchChunkSchema).default([]),
    deletePaths: z.array(z.string()).optional(),
}).passthrough();
/**
 * Bridge key for the pid-less (host caller) filesystem view. ProcessTable
 * allocates pids from 1 upwards, so 0 can never collide with a process.
 */
const HOST_CALLER_KEY = 0;
function processPid(pid) {
    if (!Number.isInteger(pid) || typeof pid !== 'number' || pid <= 0) {
        throw new Error('filesystem RPC requires a valid process pid');
    }
    return pid;
}
/**
 * Resolve the credential a filesystem RPC acts with.
 *
 * A pid identifies an in-sandbox process and always wins: SupervisorRPC stamps
 * it from its own `ctx.props`, so a process can neither choose nor drop it.
 * `undefined` means the caller is not a process at all — the SDK over the DO
 * binding, the remote `/rpc` dispatcher, the static asset server — and those
 * act as the unprivileged session user, the same identity `exec` runs as.
 * A supplied-but-invalid pid still throws: only an absent pid is a host call.
 */
function callerCred(self, pid) {
    return pid === undefined ? CRED_SESSION_USER : self.processes.cred(processPid(pid));
}
function processVfs(self, pid) {
    self.ensureSqliteFs();
    return self.sqliteFs.as(callerCred(self, pid));
}
function runtimeFs(self, pid) {
    const key = pid === undefined ? HOST_CALLER_KEY : processPid(pid);
    const vfs = processVfs(self, pid);
    if (!self.runtimeFsBridges)
        self.runtimeFsBridges = new Map();
    let bridge = self.runtimeFsBridges.get(key);
    if (!bridge) {
        bridge = new SqliteRuntimeFsBridge(vfs, self.sqliteFs);
        self.runtimeFsBridges.set(key, bridge);
    }
    else {
        bridge.updateCredential(vfs);
    }
    return bridge;
}
function checkedReadPayloadBytes(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new RangeError(`filesystem RPC read size must be a non-negative safe integer: ${bytes}`);
    }
    if (bytes > MAX_RPC_SAFE_PAYLOAD_BYTES) {
        throw new RangeError(`filesystem RPC read payload ${bytes} exceeds the ${MAX_RPC_SAFE_PAYLOAD_BYTES}-byte limit`);
    }
    return bytes;
}
/**
 * Bytes a ranged read can actually return, so the reservation covers the
 * result rather than the ask. A 64 KiB range over a 200-byte file retains 200
 * bytes; reserving the range would let a handful of small reads exhaust the
 * read reserve and serialise a workload whose real cost is negligible.
 *
 * `stat` here is a local SQLite lookup inside the DO — the same one
 * `_rpcReadFile` makes for the same reason — not a second round trip.
 */
async function rangeReadBytes(fs, path, offset, length) {
    const stat = await fs.stat(path);
    if (!stat)
        return 0;
    return Math.max(0, Math.min(length, stat.size - offset));
}
async function withReadAllocation(bytes, read) {
    const payloadBytes = checkedReadPayloadBytes(bytes);
    if (payloadBytes === 0)
        return read();
    const lease = await acquireSupervisorReadAllocation(payloadBytes);
    rpcPayloadStart(payloadBytes);
    try {
        return await read();
    }
    finally {
        rpcPayloadEnd(payloadBytes);
        lease.release();
    }
}
export async function _rpcReadFile(self, path, pid) {
    const fs = runtimeFs(self, pid);
    const stat = await fs.stat(path);
    if (!stat)
        return null;
    return withReadAllocation(stat.size, async () => {
        const bytes = await fs.readFile(path);
        return bytes ? dec.decode(bytes) : null;
    });
}
/**
 * Read a file as raw bytes (Uint8Array). Used by git network facet for
 * binary .git/objects/** and packfile reads, where TextDecoder/TextEncoder
 * round-tripping through readFile (string) would corrupt bytes.
 */
export async function _rpcReadFileBytes(self, path, pid) {
    const fs = runtimeFs(self, pid);
    const stat = await fs.stat(path);
    if (!stat)
        return null;
    return withReadAllocation(stat.size, () => fs.readFile(path));
}
/**
 * Phase-3 inner-DO fetch dispatcher. Called by NimbusDOStub.fetch()
 * from the inner Worker via the env.NIMBUS_SESSION loopback. We
 * resolve the inner DO class from the module-level registry (keyed
 * by <thisDoId>:<bindingName>), use ctx.facets.get with the inner's
 * id string as the facet id, and forward the serialized Request.
 *
 * All steps run in THIS RPC method's context, so no cross-request
 * I/O boundaries are crossed — the ctx.facets stub and its fetch()
 * are both created here.
 */
export async function _rpcInnerDoFetch(self, req) {
    const cls = getInnerDoClass(self.ctx.id.toString(), req.bindingName);
    if (!cls) {
        const body = enc.encode(`Nimbus: inner DO binding '${req.bindingName}' has no registered class (supervisor=${self.ctx.id.toString()})`);
        return {
            status: 502,
            statusText: 'Bad Gateway',
            headers: [['Content-Type', 'text/plain']],
            body: body.buffer,
        };
    }
    const facetName = 'innerDO-' + req.bindingName + '-' + req.id;
    const facet = self.ctx.facets.get(facetName, async () => ({
        class: cls,
        id: req.id, // FacetStartupOptions.id — inner DO sees this as its ctx.id
    }));
    try {
        // Reconstruct the Request in the current context.
        const headers = new Headers();
        for (const [k, v] of req.headers)
            headers.append(k, v);
        const r = new Request(req.url, {
            method: req.method,
            headers,
            body: req.body,
        });
        const res = await facet.fetch(r);
        try {
            const resHeaderList = [];
            res.headers.forEach((v, k) => { resHeaderList.push([k, v]); });
            const resBody = await res.arrayBuffer();
            return {
                status: res.status,
                statusText: res.statusText,
                headers: resHeaderList,
                body: resBody,
            };
        }
        finally {
            disposeRpcResource(res);
        }
    }
    catch (e) {
        const body = enc.encode(`Nimbus inner DO error: ${e?.message || String(e)}`);
        return {
            status: 500,
            statusText: 'Internal Server Error',
            headers: [['Content-Type', 'text/plain']],
            body: body.buffer,
        };
    }
}
export async function _rpcWriteFile(self, path, content, pid) {
    // binary-fs wave: SqliteVFS.writeFile already accepts string | Uint8Array
    // (sqlite-vfs.ts:937), so we forward the content shape unchanged. RPC
    // structured-clone preserves Uint8Array across the boundary; structured-
    // clone doesn't accept Buffer subclass instances, so fs.writeFileSync on
    // a Buffer flows through node-shims.ts:writeFileSync which stores it as
    // a plain Uint8Array on the cell — the shape that arrives here.
    return runtimeFs(self, pid).writeFile(path, content);
}
/**
 * Write one host-governed file at a session root and let ordinary Unix
 * permissions keep it that way: the root becomes a sticky 1777 directory owned
 * by the kernel, and the file itself is kernel-owned and read-only.
 *
 * The guest keeps normal use of the root — it creates, edits and removes its
 * own files there, which is what the sticky bit is for — and cannot replace,
 * rename or remove this one. That is the whole mechanism; there is no special
 * case anywhere in the filesystem for it.
 *
 * Deliberately absent from the remote HTTP RPC dispatcher: the point is a file
 * the sandboxed program cannot forge, so only an embedder holding the DO stub
 * may write it.
 */
export async function _rpcWriteProtectedRootFile(self, rootPath, path, content) {
    self.ensureSqliteFs();
    const root = normalizeVfsPath(rootPath);
    const protectedPath = normalizeVfsPath(path);
    if (!root || parentVfsPath(protectedPath) !== root) {
        throw new Error('protected file must be a direct child of the declared session root');
    }
    const fs = self.sqliteFs.as(CRED_KERNEL);
    if (!fs.exists(root) || !fs.isDirectory(root)) {
        throw new Error('protected file session root does not exist');
    }
    fs.chown(root, CRED_KERNEL.uid, CRED_KERNEL.gid);
    fs.chmod(root, 0o1777);
    fs.writeFile(protectedPath, content);
    fs.chown(protectedPath, CRED_KERNEL.uid, CRED_KERNEL.gid);
    fs.chmod(protectedPath, 0o444);
}
export async function _rpcStat(self, path, pid) {
    return runtimeFs(self, pid).stat(path);
}
export async function _rpcLstat(self, path, pid) {
    return runtimeFs(self, pid).stat(path, { followSymlinks: false });
}
export async function _rpcHasLegacySymlinkUnder(self, path, pid) {
    runtimeFs(self, pid);
    return getSymlinkRegistry(self.sqliteFs).hasAtOrBelow(path);
}
export async function _rpcUtimes(self, path, atimeMs, mtimeMs, pid) {
    await runtimeFs(self, pid).utimes(path, atimeMs, mtimeMs);
}
export async function _rpcChmod(self, path, mode, pid) {
    await runtimeFs(self, pid).chmod(path, mode);
}
export async function _rpcAccess(self, path, mode, pid) {
    await runtimeFs(self, pid).access(path, mode);
}
export async function _rpcChown(self, path, uid, gid, pid, options) {
    await runtimeFs(self, pid).chown(path, uid, gid, options);
}
export async function _rpcSetUmask(self, mask, pid) {
    return self.processes.setUmask(processPid(pid), mask);
}
export async function _rpcReaddir(self, path, pid) {
    return runtimeFs(self, pid).readdir(path);
}
export async function _rpcExists(self, path, pid) {
    return (await runtimeFs(self, pid).stat(path)) !== null;
}
export async function _rpcMkdir(self, path, pid) {
    await runtimeFs(self, pid).mkdir(path, { recursive: true });
}
export async function _rpcRmdir(self, path, pid) {
    await runtimeFs(self, pid).rmdir(path);
}
export async function _rpcRename(self, from, to, pid) {
    await runtimeFs(self, pid).rename(from, to);
}
export async function _rpcReadlink(self, path, pid) {
    return runtimeFs(self, pid).readlink(path);
}
export async function _rpcSymlink(self, target, path, pid) {
    await runtimeFs(self, pid).symlink(target, path);
}
const FsRangeOffsetSchema = z.number().int().min(0).finite();
const FsReadRangeArgsSchema = z.object({
    path: z.string(),
    offset: FsRangeOffsetSchema,
    length: FsRangeOffsetSchema,
});
const FsReadBatchArgsSchema = z.array(z.object({
    path: z.string().min(1),
    offset: FsRangeOffsetSchema,
    length: FsRangeOffsetSchema.max(FS_READ_BATCH_REQUEST_BYTES),
})).min(1).max(FS_READ_BATCH_PATH_LIMIT);
const FsWriteRangeArgsSchema = z.object({
    path: z.string(),
    offset: FsRangeOffsetSchema,
});
const FsAppendArgsSchema = z.object({
    path: z.string(),
    writerId: z.string().uuid(),
    moduleId: z.string().uuid(),
    operationId: z.string().regex(/^[1-9][0-9]*$/).max(32),
});
const FsAppendAckArgsSchema = FsAppendArgsSchema.pick({
    writerId: true,
    moduleId: true,
    operationId: true,
});
const FsTruncateArgsSchema = z.object({
    path: z.string(),
    size: FsRangeOffsetSchema,
});
// A facet supplies its own cursor, so it is untrusted input. A null epoch is
// the legitimate first call from a facet that has never acquired.
const FsAcquireArgsSchema = z.object({
    epoch: z.string().max(64).nullable(),
    cursor: z.number().int().min(0),
});
// Also facet-supplied, so also untrusted. `after` is a resume key from a
// previous page and is bounded like any other path; `limit` is clamped rather
// than rejected, because an over-large ask is a caller wanting more of an
// answer it is entitled to, not an attempt to exceed a byte budget the way an
// over-large read batch is.
const FsListArgsSchema = z.object({
    after: z.string().max(4096).nullable(),
    limit: z.number().int().min(1).max(FS_LIST_PAGE_LIMIT).nullable(),
});
export async function _rpcFsRevision(self, path, pid) {
    return runtimeFs(self, pid).revision(typeof path === 'string' ? path : undefined);
}
/**
 * The facet's WebSocket relay. A facet does not open its own sockets: the
 * supervisor terminates them, so an inbound frame arrives as a reply to a
 * poll the facet is already blocked on and can carry the same cache
 * invalidation every other supervisor-delivered resumption carries. See
 * session/ws-relay.ts for why mediating the transport is not enough.
 *
 * The URL is untrusted input, so it is parsed rather than pattern-matched and
 * only the two WebSocket schemes are accepted. Nothing else about the request
 * comes from the facet — no facet-supplied header is forwarded, so the
 * supervisor cannot be induced to attach its own ambient credentials to a
 * destination the facet chose.
 */
const WsOpenArgsSchema = z.object({
    url: z.string().max(2048).refine((value) => {
        let parsed;
        try {
            parsed = new URL(value);
        }
        catch {
            return false;
        }
        return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
    }, { message: 'a relayed socket needs a ws: or wss: URL' }),
    protocols: z.array(z.string().max(64)).max(8),
});
export async function _rpcWsOpen(self, url, protocols, pid) {
    const args = WsOpenArgsSchema.parse({ url, protocols: protocols ?? [] });
    return self._ensureWebSocketRelay().open(processPid(pid), args.url, args.protocols);
}
export async function _rpcWsPoll(self, id, waitMs, pid) {
    return self._ensureWebSocketRelay().poll(processPid(pid), Number(id), Number(waitMs) || 0);
}
export async function _rpcWsSend(self, id, text, bytes, pid) {
    self._ensureWebSocketRelay().send(processPid(pid), Number(id), text ?? null, bytes ?? null);
}
export async function _rpcWsClose(self, id, code, reason, pid) {
    self._ensureWebSocketRelay().close(processPid(pid), Number(id), code, reason);
}
/**
 * The facet cache-coherence barrier: what changed since `cursor`.
 *
 * Returned as payload, never on an Error — custom Error properties do not
 * survive structured clone across the RPC boundary, so a cursor carried that
 * way would silently arrive as undefined.
 */
export async function _rpcFsAcquire(self, epoch, cursor, pid) {
    const args = FsAcquireArgsSchema.parse({ epoch, cursor });
    return runtimeFs(self, pid).acquire(args.epoch, args.cursor);
}
/**
 * Enumerate the session filesystem for a process, one bounded page at a time.
 *
 * Goes through `runtimeFs(self, pid)` like every other fs RPC, so the listing
 * is filtered by the calling process's own credential rather than the kernel's
 * — a process must not learn of a path it could not stat.
 */
export async function _rpcFsList(self, after, limit, pid) {
    const args = FsListArgsSchema.parse({ after: after ?? null, limit: limit ?? null });
    return runtimeFs(self, pid).list(args.after, args.limit ?? undefined);
}
export async function _rpcFsReadRange(self, path, offset, length, pid) {
    const args = FsReadRangeArgsSchema.parse({ path, offset, length });
    const fs = runtimeFs(self, pid);
    return withReadAllocation(await rangeReadBytes(fs, args.path, args.offset, args.length), () => fs.readRange(args.path, args.offset, args.length));
}
/**
 * The same read, through the same process credential and the same bridge, with
 * the LRU content cache bypassed.
 *
 * For a boot spec's by-path members and nothing else. Those are the largest
 * files a session holds — a ruby interpreter image is 34.3 MiB against a 32 MiB
 * cache — and a host reads each one once, in slices, to hand to a Worker Loader
 * module map. Serving them through the demand-paging path would evict the
 * user's entire hot working set and pin the blob in this DO's heap for the rest
 * of the session, which is the pathology `readFileUncached` was added to stop
 * when clang crashed the supervisor. A process hosted on this DO already reads
 * them uncached; one hosted elsewhere has to be able to say so too, or the
 * substrate that was supposed to relieve the coordinator damages it instead.
 */
export async function _rpcFsReadRangeUncached(self, path, offset, length, pid) {
    const args = FsReadRangeArgsSchema.parse({ path, offset, length });
    const fs = runtimeFs(self, pid);
    return withReadAllocation(await rangeReadBytes(fs, args.path, args.offset, args.length), () => fs.readRange(args.path, args.offset, args.length, { cached: false }));
}
/**
 * Read many ranges in ONE round trip.
 *
 * Every entry is the same read `_rpcFsReadRange` performs, through the same
 * process credential and the same live bridge, in request order. A batch is
 * therefore exactly as authoritative as the individual reads it replaces —
 * it takes no snapshot and consults nothing the single-read path would not.
 * What it saves is round trips, which is the whole cost of a read.
 *
 * One failing path must not cost the caller the whole batch — with N separate
 * calls it would have learned each outcome — so a read that throws is
 * reported in its own slot and the rest of the batch proceeds. A missing path
 * yields `bytes: null`, exactly as the single read does.
 *
 * Bounds are checked before any read and rejected rather than trimmed: a
 * caller that silently got fewer entries than it asked for would read a
 * truncated file as a complete one.
 */
export async function _rpcFsReadBatch(self, requests, pid) {
    const args = FsReadBatchArgsSchema.parse(requests);
    const requestedBytes = args.reduce((total, request) => total + request.length, 0);
    if (requestedBytes > FS_READ_BATCH_REQUEST_BYTES) {
        throw new RangeError(`filesystem read batch requests ${requestedBytes} bytes across ${args.length} ranges, `
            + `over the ${FS_READ_BATCH_REQUEST_BYTES}-byte limit`);
    }
    // Sizing pass. A path this process may not stat contributes nothing and
    // still gets its own entry below — denying one path must not deny the
    // batch, which is what N separate reads would have done.
    const fs = runtimeFs(self, pid);
    let residentBytes = 0;
    for (const request of args) {
        try {
            residentBytes += await rangeReadBytes(fs, request.path, request.offset, request.length);
        }
        catch { /* the read pass reports this path's error in its own slot */ }
    }
    return withReadAllocation(residentBytes, async () => {
        const entries = [];
        for (const request of args) {
            try {
                entries.push({ bytes: await fs.readRange(request.path, request.offset, request.length) });
            }
            catch (error) {
                entries.push({ error: readBatchEntryError(error) });
            }
        }
        return entries;
    });
}
/**
 * Errors cross an RPC boundary as `name`/`message` only, so the code a
 * caller needs to map to an errno travels as data.
 */
function readBatchEntryError(error) {
    if (typeof error === 'object' && error !== null) {
        const code = Reflect.get(error, 'code');
        const message = Reflect.get(error, 'message');
        if (typeof code === 'string') {
            return { code, message: typeof message === 'string' ? message : code };
        }
        if (typeof message === 'string')
            return { message };
    }
    return { message: String(error) };
}
export async function _rpcFsWriteRange(self, path, offset, bytes, pid) {
    const args = FsWriteRangeArgsSchema.parse({ path, offset });
    return runtimeFs(self, pid).writeRange(args.path, args.offset, normalizeWriteBatchChunkData(bytes));
}
export async function _rpcFsAppend(self, path, writerId, moduleId, operationId, bytes, pid) {
    const args = FsAppendArgsSchema.parse({ path, writerId, moduleId, operationId });
    const sequence = Number(args.operationId);
    if (!Number.isSafeInteger(sequence)) {
        throw new Error('filesystem append operation exceeds the safe integer range');
    }
    const processId = processPid(pid);
    const data = normalizeWriteBatchChunkData(bytes);
    const digestBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    const digest = Array.from(digestBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return runtimeFs(self, pid).appendOnce(args.path, processId, args.writerId, args.moduleId, sequence, digest, data);
}
export async function _rpcFsAppendAck(self, writerId, moduleId, operationId, pid) {
    const args = FsAppendAckArgsSchema.parse({ writerId, moduleId, operationId });
    const sequence = Number(args.operationId);
    if (!Number.isSafeInteger(sequence)) {
        throw new Error('filesystem append operation exceeds the safe integer range');
    }
    const processId = processPid(pid);
    await runtimeFs(self, processId).acknowledgeAppend(processId, args.writerId, args.moduleId, sequence);
}
export async function _rpcFsTruncate(self, path, size, pid) {
    const args = FsTruncateArgsSchema.parse({ path, size });
    await runtimeFs(self, pid).truncate(args.path, args.size);
}
export async function _rpcFsOpen(self, path, flags, pid) {
    return runtimeFs(self, pid).open(path, flags || {});
}
export async function _rpcFsRead(self, handleId, offset, length, pid) {
    return withReadAllocation(length, () => runtimeFs(self, pid).read(handleId, offset, length));
}
export async function _rpcFsWrite(self, handleId, offset, bytes, pid) {
    let data;
    if (bytes instanceof Uint8Array)
        data = bytes;
    else if (bytes instanceof ArrayBuffer)
        data = new Uint8Array(bytes);
    else
        data = new Uint8Array(bytes || []);
    return runtimeFs(self, pid).write(handleId, offset, data);
}
export async function _rpcFsClose(self, handleId, pid) {
    await runtimeFs(self, pid).close(handleId);
}
/**
 * Called by CirrusHmrRPC.hmrSend. Runs in the DO's own context so
 * we can legally write to hibernatable WS sockets owned by this
 * DO. The HmrBridge holds the client→WS map; we delegate to it.
 */
export async function _rpcHmrRelay(self, clientId, msg) {
    if (!self.cirrusReal)
        return;
    self.cirrusReal.hmr.relayToBrowser(clientId, msg);
}
export async function _rpcUnlink(self, path, pid) {
    await runtimeFs(self, pid).unlink(path);
}
/**
 * Bulk-write files and directories via one transactionSync().
 * Called from facets that accumulate writes locally (git clone/fetch/pull,
 * potentially others) to avoid thousands of individual writeFile RPCs.
 *
 * payload: {
 *   inodes: BatchInodeEntry[],
 *   chunks: { path, chunkId, data: Uint8Array | ArrayBuffer }[],
 *   deletePaths?: string[]
 * }
 */
export async function _rpcWriteBatch(self, payload, pid) {
    const parsed = WriteBatchPayloadSchema.safeParse(payload);
    if (!parsed.success)
        throw new Error('writeBatch payload failed validation');
    const { inodes, chunks: rawChunks, deletePaths } = parsed.data;
    // Normalize chunk data — RPC may deliver Uint8Array, ArrayBuffer, or { type: 'Buffer', data: [...] }
    const chunks = rawChunks.map((c) => ({
        path: c.path,
        chunkId: c.chunkId,
        data: normalizeWriteBatchChunkData(c.data),
    }));
    return processVfs(self, pid).writeBatch({
        inodes,
        chunks,
        deletePaths,
    });
}
function normalizeWriteBatchChunkData(value) {
    if (value instanceof Uint8Array)
        return value;
    if (value instanceof ArrayBuffer)
        return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (Array.isArray(value))
        return new Uint8Array(value);
    if ((typeof value === 'object' || typeof value === 'function') && value !== null) {
        const data = Reflect.get(value, 'data');
        if (Array.isArray(data))
            return new Uint8Array(data);
    }
    return new Uint8Array(0);
}
/**
 * W7 — Streaming bulk-write entry point. Receives a
 * ReadableStream<Uint8Array> in the W7 v3 wire format (see
 * src/_shared/w7-frame.ts) and hands the raw pull-controlled stream to
 * SqliteVFS.writeStream().
 *
 * Bypasses the 32 MiB structured-clone cap that constrained the
 * legacy writeBatch path — workerd flow-controls the byte stream
 * end-to-end.
 *
 * Unlike strict writeBatch, the stream contract is path-atomic with a
 * committed prefix: every reported path is complete, but earlier publish
 * groups remain durable when a later group fails. The typed result carries
 * the exact durable progress.
 */
export async function _rpcWriteBatchStream(self, stream, mutationOwner, pid) {
    // [P0a — COORDINATOR-OVERLOAD]
    //
    // core WASI (semaphore here): rejected. Parking peer-side awaits in a
    // user-space queue extended each peer's _rpcFanoutExecute round-trip
    // time, which made workerd cancel the peer→coordinator PARENT RPC
    // with the same overload error (observed in production 7c3f1b25:
    // "[batch-fanout] aborted: ExecutionError: Durable Object is
    // overloaded"). The semaphore moved the queue-age problem one layer
    // up — same symptom, worse blast radius (whole-batch abort instead
    // of per-package fail).
    //
    // filesystem WASI (shared flush + adaptive shard cap, no semaphore): the
    // producer-side fix. The peer-side install-batch-facet now shares
    // ONE inode/chunk accumulator across all packages in a peer's
    // shard (src/npm/install-batch-facet.ts), so 39 packages → ~3-5
    // RPCs to coordinator instead of 39+. Combined with shard cap of 8
    // (src/npm/installer.ts), 620 deps → 8 peers × ~3 flushes = ~24
    // total writeBatchStream RPCs at the coordinator (vs 620+ pre-fix).
    // Workerd's input-gate queue depth on the coordinator stays well
    // under the queue-age threshold without any user-space semaphore.
    const decodeDrainStartedAt = performance.now();
    return processVfs(self, pid).writeStream(stream, {
        decodeDrainStartedAt,
        mutationOwner,
    });
}
/**
 * Bulk-write npm registry cache entries in ONE RPC. Used by the
 * resolver-facet to flush a wave of resolved packages back to the
 * supervisor without per-entry round-trips.
 *
 * Payload is the array of RegistryCacheEntry shapes from src/npm-cache.ts.
 * Returns { written, failed } so the facet can surface partial-write
 * warnings to the install log.
 */
export async function _rpcPutRegistryEntries(self, entries) {
    self.ensureSqliteFs();
    const npmCache = new NpmCache(self.ctx.storage.sql);
    if (!Array.isArray(entries))
        return { written: 0, failed: 0 };
    return npmCache.putRegistryEntries(entries);
}
/**
 * Post-reset semantics: a pid at or below the current generation's pid floor
 * belongs to a facet spawned by a PREVIOUS DO instance (see PID_GEN_STRIDE).
 * The in-memory process state that owned it — table entry, input store, shell
 * association — died with that instance, so the coherent contract is a clean,
 * attributed death: refuse its output, kill its stdin pump, and mark/broadcast
 * an honest exit so a surviving process-terminal tab shows what happened
 * instead of a silent half-alive display.
 */
function isPriorGenerationPid(self, pid) {
    return pid > 0 && pid <= self.processes.pidBase;
}
export const PRIOR_GENERATION_EXIT_REASON = 'process lost: instance reset';
export async function _rpcStdout(self, pid, data) {
    // Prior-generation straggler (facet outlived a DO instance reset): drop —
    // its output must not merge into this generation's logs or shell.
    if (isPriorGenerationPid(self, pid))
        return;
    // Always buffer raw data (keeps ANSI for replay). Terminal paint only
    // if someone is listening — detached sessions shouldn't silently lose
    // output. Skip pid=0 (the supervisor-rpc fallback when no props.pid
    // was threaded) to avoid polluting a sentinel slot with output from
    // un-traceable facets.
    try {
        if (pid > 0)
            self.processes.appendOutput(pid, 'stdout', data);
        if (self.terminal && shouldMirrorProcessOutputToShell(self, pid)) {
            self.terminal.write(normalizeTerminalNewlines(data));
        }
    }
    catch (e) {
        // Fix 5: surface RPC envelope errors when NIMBUS_DEBUG=1. Silent
        // drops here are exactly what hides bugs; default-off so we don't
        // blow up terminals with normal-operation noise, but diagnosable on
        // demand.
        if (self.nimbusDebug && self.terminal) {
            try {
                self.terminal.write(`\x1b[33m[rpc-error] _rpcStdout(pid=${pid}) threw: ${e?.message || e}\x1b[0m\r\n`);
            }
            catch { }
        }
    }
}
export async function _rpcStderr(self, pid, data) {
    if (isPriorGenerationPid(self, pid))
        return;
    try {
        if (pid > 0)
            self.processes.appendOutput(pid, 'stderr', data);
        // Terminal gets red wrapping; the ring buffer keeps it raw so the
        // stream tag can drive color decisions at replay time.
        if (self.terminal && shouldMirrorProcessOutputToShell(self, pid)) {
            self.terminal.write(`\x1b[31m${normalizeTerminalNewlines(data)}\x1b[0m`);
        }
    }
    catch (e) {
        if (self.nimbusDebug && self.terminal) {
            try {
                self.terminal.write(`\x1b[33m[rpc-error] _rpcStderr(pid=${pid}) threw: ${e?.message || e}\x1b[0m\r\n`);
            }
            catch { }
        }
    }
}
function shouldMirrorProcessOutputToShell(self, pid) {
    if (pid <= 0)
        return true;
    const entry = self.processes.get(pid);
    // No table entry: either a reaped process's late flush or a facet that
    // outlived an instance reset. Neither owns the user's shell anymore — the
    // output still lands in the log ring above, never on the shell WS (an
    // attached-TTY straggler would otherwise spray alternate-screen ANSI over
    // the prompt).
    if (!entry)
        return false;
    return entry.attachedTty !== true;
}
/**
 * Called by facets from their `finally` block after I/O has drained.
 * Marks the log store so `logs` / `ps` can show the exit code, and
 * fires `_emitExitDump` if the process exited non-zero with buffered
 * output.
 *
 * Idempotent — double-call is a no-op (ProcessLogStore.markExit guards).
 */
export async function _rpcReportExit(self, pid, code, tail) {
    if (pid <= 0)
        return; // Ignore the pid-0 sentinel.
    // Prior-generation straggler unwinding after an instance reset: this
    // instance never owned the pid, so skip the table/lifecycle plumbing and
    // record ONLY the honest exit — the log store broadcast reaches any
    // surviving process-terminal tab still attached to the old pid.
    if (isPriorGenerationPid(self, pid)) {
        self.processes.markExit(pid, code, PRIOR_GENERATION_EXIT_REASON);
        return;
    }
    try {
        self.processes.closeInput(pid);
    }
    catch { }
    // A relayed socket is held open by the supervisor on the process's behalf,
    // so it does not die when the facet does. Nothing else would ever close
    // it, and a live one keeps buffering into the supervisor's heap.
    try {
        self.webSocketRelay?.closeForPid(pid);
    }
    catch { }
    self.runtimeFsBridges?.delete(pid);
    if (tail)
        self.processes.appendOutput(pid, 'stderr', tail);
    // Guard against double-reporting: if we've already recorded exit
    // (e.g. from an external kill path) don't dump twice.
    if (self.processes.getExit(pid))
        return;
    self.processes.markExit(pid, code);
    try {
        self.facetManager?.noteProcessReportedExit?.(pid, code);
    }
    catch {
        try {
            self.processes.exit(pid, code);
        }
        catch { }
    }
    // Structured exit notification for the tabs UI. Idempotent on the
    // client — subscribeExit fires once, and the shell-exec finalizer
    // also emits, so we dedupe on pid there. Include the command (when
    // available via ProcessTable) so the UI can surface a tab for pids
    // whose spawn event was suppressed (e.g. `node -e` short evals).
    const cmdFromTable = self.processes.get(pid)?.command;
    notifyTerminalEvent(self.terminal, { type: 'exit', pid, code, command: cmdFromTable });
    // SHELL-FOLLOWUPS-5 (2026-05-11): only dump on non-zero exit.
    //
    // Pre-fix Fix-4 policy was "dump whenever the ring buffer has
    // bytes, regardless of code" (intent: catch the
    // clean-but-silent failure where stderr traceback was buffered
    // but user wasn't watching). Real-world cost: every successful
    // `node -e`, `python -c`, etc. printed stdout once live, then
    // again as a post-exit dump — double-print on the happy path.
    //
    // New policy:
    //   - Non-zero exit AND non-empty buffer → dump (failure context)
    //   - Zero exit → no dump (live stream already showed it)
    //
    // Reconnect-replay path is preserved by the `logs <pid>` shell
    // command + `/api/processes/<pid>/logs` endpoint, neither of
    // which depends on the inline dump.
    //
    // NOTE: _emitShellExecDone (below) carries an identical gate;
    // both paths must agree because either may fire first depending
    // on facet vs. shell-finalizer ordering.
    if (code !== 0 && self.processes.logSize(pid) > 0) {
        self._emitExitDump(pid, code);
    }
    // Fix 5: verbose exit trace gated on NIMBUS_DEBUG=1. Facets already
    // get a spawn banner via FacetManager.onSpawn; this closes the loop.
    if (self.nimbusDebug && self.terminal) {
        const entry = self.processes.get(pid);
        const cmd = entry?.command || `pid ${pid}`;
        const colorExit = code === 0 ? '\x1b[2m' : '\x1b[2;31m';
        self.terminal.write(`${colorExit}[facet exited: pid=${pid} code=${code} cmd="${cmd}"]\x1b[0m\r\n`);
    }
}
/**
 * Emit a formatted exit-dump banner + last 30 lines of output to the
 * terminal. Called from both the facet-reported exit path and the
 * external-kill path (timeout / abort).
 *
 * Race notes:
 *   - Terminal.write is buffered with a 5ms flush; concurrent writes
 *     from facet stdout still in flight interleave cleanly at flush
 *     time.
 *   - If no terminal is attached, the dump is simply skipped — the
 *     log buffer still has everything, so `logs <pid>` recovers it.
 */
export function _emitExitDump(self, pid, code) {
    if (!self.terminal)
        return;
    const entry = self.processes.get(pid);
    const cmd = entry?.command || `pid ${pid}`;
    const chunks = self.processes.tailLogs(pid, { lines: 30 });
    const sep = '─'.repeat(60);
    const color = code === 0 ? '\x1b[2;33m' : '\x1b[31m'; // yellow-dim for clean-silent
    self.terminal.write(`\r\n${color}${sep}\r\n` +
        `Process ${pid} (${cmd}) exited with code ${code}\r\n` +
        `${sep}\x1b[0m\r\n`);
    for (const c of chunks) {
        const terminalData = normalizeTerminalNewlines(c.data);
        const painted = c.stream === 'stderr' ? `\x1b[31m${terminalData}\x1b[0m` : terminalData;
        self.terminal.write(painted);
    }
    self.terminal.write(`${color}${sep}\x1b[0m\r\n`);
}
/**
 * Fix 3 + Fix 4 + Fix 5: finalizer for shellExecuteTracked.
 *
 * Runs after a tracked shell.execute finishes (any path). Chooses when
 * to emit the exit-dump banner and when to log the debug trace.
 *
 * Dump policy (Fix 4):
 *   - Non-zero exit AND any buffered output → always dump.
 *   - Zero exit AND buffered output has >0 bytes → dump anyway. Rationale:
 *     an npm run that returned "success" while the ring buffer still has
 *     a traceback is the exact "clean-but-silent failure" we're hunting.
 *     The replay is unique information the user didn't see live (e.g.
 *     because the terminal was reconnected after the fact).
 *   - Zero exit AND empty buffer → nothing to say. Skip.
 *
 * Trace policy (Fix 5):
 *   - NIMBUS_DEBUG=1: always print `[exited pid=N code=C duration=Xms]`.
 *   - Default: print only for non-zero OR long-running scripts (the
 *     cmd-start banner makes them expect an exit marker).
 *
 * Called with the already-marked pid (processes.exit + processes.markExit
 * ran in shellExecuteTracked's finally).
 */
export function _emitShellExecDone(self, pid, cmd, code, durationMs) {
    const bufSize = self.processes.logSize(pid);
    // SHELL-FOLLOWUPS-5 (2026-05-11): only dump on non-zero exit.
    //
    // Pre-fix policy was "dump regardless of code when buffer non-empty"
    // (Fix 4 from W3.5 era, intent: catch clean-but-silent failure
    // where user couldn't see live output e.g. across reconnect).
    //
    // Real-world cost: for every successful `node -e`, `python -c`,
    // `npx X --version`, etc., user saw output once live + once
    // again in the post-exit dump. Annoying double-print for the
    // common-case interactive session.
    //
    // New policy:
    //   - Non-zero exit AND non-empty buffer → dump (failure context)
    //   - Zero exit → no dump (live stream already showed it)
    //
    // Reconnect-replay path is preserved by the `logs <pid>` shell
    // command + `/api/processes/<pid>/logs` endpoint, neither of
    // which depends on the inline dump.
    const shouldDump = bufSize > 0 && code !== 0;
    if (shouldDump) {
        self._emitExitDump(pid, code);
    }
    if (self.terminal) {
        const traceAlways = self.nimbusDebug;
        const isLongRunning = /^(vite|wrangler|next|nuxt|astro|remix|dev|serve|start|watch)\b/.test(cmd);
        if (traceAlways || code !== 0 || isLongRunning) {
            const colorExit = code === 0 ? '\x1b[2m' : '\x1b[2;31m';
            self.terminal.write(`${colorExit}[shell exited: pid=${pid} code=${code} duration=${durationMs}ms]\x1b[0m\r\n`);
        }
    }
}
/**
 * External-exit path: invoked by FacetManager when a process is killed
 * outside the facet's own try/finally (timeout, explicit abort, or the
 * `kill` shell command). Appends a synthetic stderr line so the dump
 * has useful context, then runs the same dump machinery.
 */
export function _reportExternalExit(self, pid, code, reason) {
    if (self.processes.getExit(pid))
        return;
    try {
        self.processes.closeInput(pid);
    }
    catch { }
    // A relayed socket is held open by the supervisor on the process's behalf,
    // so it does not die when the facet does. Nothing else would ever close
    // it, and a live one keeps buffering into the supervisor's heap.
    try {
        self.webSocketRelay?.closeForPid(pid);
    }
    catch { }
    self.runtimeFsBridges?.delete(pid);
    if (reason) {
        self.processes.appendOutput(pid, 'stderr', `[process killed: ${reason}]\n`);
    }
    self.processes.markExit(pid, code, reason);
    const cmdFromTable = self.processes.get(pid)?.command;
    notifyTerminalEvent(self.terminal, { type: 'exit', pid, code, reason, command: cmdFromTable });
    if (self.terminal && self.processes.logSize(pid) > 0) {
        self._emitExitDump(pid, code);
    }
    // W5 Lever 5: ring entry for every external exit with a non-zero
    // code. The FacetManager already records its own exits inline via
    // _w5RecordTermination — this catches the residual paths
    // (timeouts dispatched via the timeout-handler in FacetManager
    // call back through hooks.onExternalExit, which reaches here).
    // The ring is bounded; double-recording is harmless.
    if (code !== 0) {
        try {
            let cause = classifyError(reason);
            if (code === 124 && cause === 'unknown')
                cause = 'rpc_timeout';
            recordFailure({
                at: Date.now(),
                phase: 'facet',
                cause,
                rssEstimateBytes: self._diagPeakRss,
                heapUsedBytes: self._diagPeakHeapUsed,
                lruBytes: 0, inFlightBytes: 0,
                lastRpcFrame: getLastRpcFrame(),
                lastFacetId: getLastFacetId(),
                exitCode: code,
                pid,
                message: reason,
            });
        }
        catch { /* fail-soft */ }
    }
}
/**
* W1: orphan-pid predicate exposed for the alarm dispatcher. A pid is
* "orphaned" if the process table has no record of it — either reap()
* already removed it, or it never fully registered. Long-running
* facets that hang and get GC'd fall into this category.
*/
export function _logJanitorOrphanCheck(self) {
    return (pid) => !self.processes.get(pid);
}
export async function _rpcPrefetch(self, cwd, entryCode) {
    // W2.6a: de-quarantined. require-resolver.ts is now the primary
    // content-bundle source for FacetManager.exec via buildPrefetchBundle.
    // This RPC entrypoint is retained for facet-side callers that may
    // want to refresh the bundle mid-execution; today only the
    // SupervisorRPC.prefetch surface exposes it externally.
    self.ensureSqliteFs();
    const { prefetchForRequire } = await import('@nimbus-sh/core/runtime/require-resolver.js');
    return prefetchForRequire(self.sqliteFs, entryCode, cwd).bundle;
}
export async function _rpcRegisterPort(self, pid, port) {
    // Port registration stores the facet association
    // The actual facet stub is stored by FacetManager separately
    // A new registration retires the previous occupant's preview capability.
    await clearPortCapability(self, port);
    self.portRegistry.register(port, pid);
}
export async function _rpcUnregisterPort(self, port) {
    self.portRegistry.unregister(port);
}
export async function _rpcRouteLoopback(self, port, request) {
    // In-session loopback routing for a facet's outbound fetch — the same policy
    // as kernel.routeLoopback (session/init.ts) used by the shell curl/node path.
    const res = await routeSessionLoopback(self, port, request);
    return res ?? new Response(JSON.stringify({ error: 'connection refused (no server listening)', port }), { status: 502, headers: { 'Content-Type': 'application/json' } });
}
export async function _rpcTransform(self, code, loader) {
    if (!self.esbuildService) {
        self.ensureSqliteFs();
        if (!self.sqliteFs)
            throw new Error('Session VFS is not initialized');
        self.esbuildService = new EsbuildService(self.sqliteFs.as(CRED_KERNEL));
    }
    try {
        const result = await self.esbuildService.transform(code, {
            loader: loader || 'ts',
            format: 'esm',
            target: 'esnext',
            sourcemap: 'inline',
        });
        return { code: result.code, map: result.map };
    }
    catch (e) {
        return null;
    }
}
// ── child_process RPC entrypoints [W8 Phase 1] ────────────────────────
//
// Delegate to the lazily-constructed FacetProcessManager. Defensive
// ensureFacetProcessManager() handles cold-start cases where a child
// facet calls cp* before the supervisor has initialized the broker
// (e.g., immediately after DO hibernation wake-up).
export async function _rpcCpSpawn(self, req) {
    const fpm = self._ensureFacetProcessManager();
    return fpm.spawn(req);
}
export async function _rpcCpStdinWrite(self, childPid, data) {
    if (self.processes.hasInput(childPid)) {
        return self.processes.writeInput(childPid, data);
    }
    const fpm = self._ensureFacetProcessManager();
    return fpm.stdinWrite(childPid, data);
}
export async function _rpcCpStdinEnd(self, childPid) {
    if (self.processes.hasInput(childPid)) {
        self.processes.endInput(childPid);
        return;
    }
    const fpm = self._ensureFacetProcessManager();
    fpm.stdinEnd(childPid);
}
export async function _rpcCpReadStdin(self, childPid, waitMs) {
    // Prior-generation straggler: its ProcessInputStore died with the old
    // instance. Deliver a kill so the facet's stdin pump unwinds immediately
    // with explicit semantics (__ProcessExit(137) → reportExit → the honest
    // prior-generation exit mark above) instead of polling a void.
    if (isPriorGenerationPid(self, childPid)) {
        return { signal: 'SIGKILL', ended: true };
    }
    if (self.processes.hasInput(childPid)) {
        return self.processes.readInput(childPid, waitMs);
    }
    const fpm = self._ensureFacetProcessManager();
    return fpm.cpReadStdin(childPid, waitMs);
}
export async function _rpcCpReadOutput(self, childPid, fd, sinceSeq, waitMs) {
    const fpm = self._ensureFacetProcessManager();
    return fpm.readOutput(childPid, fd, sinceSeq, waitMs);
}
export async function _rpcCpDrainOutput(self, childPid) {
    const fpm = self._ensureFacetProcessManager();
    return fpm.drainOutput(childPid);
}
export async function _rpcCpKill(self, childPid, signal) {
    const fpm = self._ensureFacetProcessManager();
    return fpm.kill(childPid, signal);
}
export async function _rpcCpWait(self, childPid, waitMs) {
    const fpm = self._ensureFacetProcessManager();
    return fpm.wait(childPid, waitMs);
}
/**
 * child-process isolation gap #1: dispatch a single cp.spawn request inline using the
 * existing pure-builtin / facet-direct logic, returning final stdout/
 * stderr/exitCode rather than streaming via hooks. Called by
 * spawn-facet.ts:runSpawnInIsolate from inside a fresh Worker Loader
 * isolate (the per-spawn fresh-isolate envelope).
 *
 * The fpm exposes a `dispatchInline(req, kind)` that adapts the
 * existing _dispatch path (originally hook-based) into a string-result
 * shape. That adapter is responsible for ensuring stdout/stderr are
 * accumulated inline rather than streamed.
 */
export async function _rpcCpDispatchInline(self, req, kind) {
    const fpm = self._ensureFacetProcessManager();
    return fpm.dispatchInline(req, kind);
}
// ── Legacy VFS RPC Entrypoints (direct method calls) ──────────────────
// Kept for backward compatibility with direct DO stub callers.
/** RPC: Read a file from the VFS. Returns ArrayBuffer or null. */
export function vfsReadFile(self, path) {
    self.ensureSqliteFs();
    try {
        const stripped = path.replace(/^\/+/, '');
        const data = self.sqliteFs.as(CRED_KERNEL).readFile(stripped);
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    catch {
        return null;
    }
}
/** RPC: Read a file as string. Returns string or null. */
export function vfsReadFileString(self, path) {
    self.ensureSqliteFs();
    try {
        const stripped = path.replace(/^\/+/, '');
        return self.sqliteFs.as(CRED_KERNEL).readFileString(stripped);
    }
    catch {
        return null;
    }
}
/** RPC: Stat a path. Returns file metadata or null. */
export function vfsStat(self, path) {
    self.ensureSqliteFs();
    try {
        const stripped = path.replace(/^\/+/, '');
        return self.sqliteFs.as(CRED_KERNEL).stat(stripped);
    }
    catch {
        return null;
    }
}
/** RPC: Check if path exists. */
export function vfsExists(self, path) {
    self.ensureSqliteFs();
    const stripped = path.replace(/^\/+/, '');
    return self.sqliteFs.as(CRED_KERNEL).exists(stripped);
}
/** RPC: List directory contents. Returns array of { name, type }. */
export function vfsReaddir(self, path) {
    self.ensureSqliteFs();
    try {
        const stripped = path.replace(/^\/+/, '');
        return self.sqliteFs.as(CRED_KERNEL).readdir(stripped);
    }
    catch {
        return [];
    }
}
/** RPC: Write a file to the VFS. */
export function vfsWriteFile(self, path, data) {
    self.ensureSqliteFs();
    const stripped = path.replace(/^\/+/, '');
    self.sqliteFs.as(CRED_KERNEL).writeFile(stripped, new Uint8Array(data));
}
/**
 * RPC: peer-DO execute leg of Fanout's peer-DO fanout topology.
 *
 * Called by a coordinator NimbusSession DO via
 * `env.NIMBUS_SESSION.idFromName(siblingName).get()._rpcFanoutExecute(...)`.
 * THIS DO instance acts as a peer worker: it runs ONE IsolatePool
 * over its assigned shard and returns the per-task results.
 *
 * Cap-sidestep mechanic
 * ─────────────────────
 * The supervisor's `submitMany` makes N RPC calls to N peer DOs.
 * Each RPC is a stub.fetch / RPC method invocation, NOT an
 * `env.LOADER.get()` from the supervisor's own method context — so
 * those N calls don't count against the V8 4-loaders-per-method cap.
 * Inside this RPC handler, we run a SINGLE IsolatePool with concurrency
 * matching the shard size — and since the shard arrived via the peer
 * router (capped at MAX_PEER_FANOUT = 32 peers, so each shard is
 * ⌈totalTasks / 32⌉ wide), the in-DO pool stays well under 4.
 *
 * Failure model
 * ─────────────
 * Throws bubble back to the coordinator's RPC promise (rejects on
 * the supervisor side). The coordinator's `submitMany` Promise.all
 * surfaces the first reject; the install path treats it as a hard
 * failure (matching today's single-facet `pool.submit` posture).
 *
 * Bytes-isolation
 * ───────────────
 * The fnSource string is forwarded verbatim into a fresh
 * IsolatePool, which serializes it into the loader's worker
 * code. No supervisor-side eval. Same trust posture as every other
 * IsolatePool dispatch.
 */
export async function _rpcFanoutExecute(self, fnSource, args, poolOpts = {}) {
    if (!Array.isArray(args)) {
        throw new TypeError('_rpcFanoutExecute: args must be an array');
    }
    if (args.length === 0)
        return { results: [] };
    // Concurrency = shard size, capped at 4 (the V8 in-DO ceiling).
    // Shard size on the coordinator side is at most ⌈totalTasks / N⌉
    // where N <= MAX_PEER_FANOUT (32) — for typical 50-pkg installs
    // with N=8 peers, that's 7 tasks per peer, capped to 4 here so
    // each peer DO stays safely below the cap.
    const concurrency = Math.min(args.length, 4);
    const pool = new IsolatePool(self.env, self.ctx, {
        concurrency,
        timeoutMs: poolOpts.timeoutMs,
        tag: poolOpts.tag ?? 'fanout-peer',
        preamble: poolOpts.preamble,
        wasmModules: poolOpts.wasmModules,
        extraBindings: poolOpts.extraBindings,
        omitSupervisor: poolOpts.omitSupervisor,
        // INSTALL-HONESTY: route SUPERVISOR.* back to the coordinator
        // (the user's session DO), not the peer DO. When undefined
        // (back-compat with non-fanout callers), IsolatePool falls
        // back to ctx.id.toString() — the legacy behavior, correct for
        // single-DO callers.
        supervisorDoIdOverride: poolOpts.coordinatorDoId,
        supervisorPid: poolOpts.supervisorPid,
    });
    try {
        // mapSource accepts the pre-serialized fnSource forwarded by the
        // coordinator (the function was already validated +
        // serialized via serializeFunction on the coordinator side).
        const results = await pool.mapSource(fnSource, args);
        return { results };
    }
    finally {
        try {
            pool.dispose();
        }
        catch { /* best-effort */ }
    }
}
// ── Process fabric: the peer host leg ───────────────────────────────────────
//
// THIS DO instance acts as a process host for a sibling coordinator session:
// it opens the process as a facet of ITSELF — the same `processes().spawn`
// call the coordinator makes when it hosts one directly — so the facet lands
// in THIS DO's workerd process, with its own memory AND its own CPU. The
// facet's SUPERVISOR binding is minted for the COORDINATOR's doId, so every
// syscall routes back to the user's session. Same trust and routing posture as
// _rpcFanoutExecute's INSTALL-HONESTY override.
//
// Nothing here knows what the process is, and nothing here decides anything: a
// coordinator reaches this leg only because its deployment set
// NIMBUS_PROCESS_HOST=peer. See loaders/process-host.ts.
/** The fabric's boot-spec shape, with the staged arm validated as Nimbus's
 *  opencode stage — this RPC is the peer's trust boundary for it. */
const ResidentBootSpecSchema = residentBootSpecSchema(OpencodeStageSpecSchema);
const HostProcessOptsSchema = z.object({
    /** Full doId of the coordinator session (SUPERVISOR routing target). */
    coordinatorDoId: z.string().min(1),
    /** Supervisor-assigned pid of the process entry on the coordinator. */
    pid: z.number().int().positive(),
    /** Trusted identity of this concrete resident-host incarnation. */
    writerId: z.string().uuid(),
    /** Keyed dynamic-worker identity on THIS peer's loader. */
    workerKey: z.string().min(1),
    /** Unforgeable capability for the fetch-semantic WebSocket hop. */
    webSocketCapability: z.string().uuid(),
    /** Opaque arguments forwarded to the runner's startProcess. */
    startArgs: z.unknown().optional(),
});
/**
 * How long a boot-payload or routed-HTTP leg waits for its process's host
 * record. Normally zero: the coordinator issues `_rpcHostProcess` first and it
 * registers before its first await. The wait exists so neither leg can lose a
 * race with RPC delivery order.
 */
const HOSTED_RECORD_WAIT_MS = 30_000;
/**
 * Whole-file reads for a boot spec's by-path members, in ranges. This is the
 * one thing a peer does differently from a coordinator, and it is a PARAMETER
 * of `processes().spawn` rather than a branch inside it: the coordinator reads
 * its own disk synchronously, a peer reads the same disk over the supervisor.
 *
 * Ranged because these are the session's largest files — a ruby
 * interpreter+stdlib image is 34.3 MiB — and workerd's 32 MiB ceiling applies
 * to each returned VALUE, not to the call. UNCACHED for the same reason the
 * coordinator's own reader is: caching a 34 MiB blob in a 32 MiB LRU evicts
 * everything the session was using and holds the blob for the session's life.
 *
 * The credential is the PROCESS's, not the kernel's, because that is what a
 * supervisor RPC carries and no substrate should be able to read more than the
 * process it hosts. Boot-spec members are reachable under it by construction:
 * the image store is kernel-owned mode 0644 precisely so any process can read
 * it, and the installed runtime images are world-readable too — which is not
 * an assumption, it is what makes ruby, python and node boot on a peer in the
 * live gates.
 */
const RESIDENT_READ_RANGE_BYTES = 4 * 1024 * 1024;
function peerDiskReader(supervisor) {
    const supervisorRpc = supervisorEntrypoint();
    if (!supervisorRpc) {
        throw new Error('Nimbus: ctx.exports.SupervisorRPC unavailable');
    }
    const fs = supervisorRpc({ props: supervisor });
    return { readFile: (path) => readSupervisorFile(fs, path) };
}
async function readSupervisorFile(fs, path) {
    const stat = await fs.stat(path);
    const size = Number(stat?.size);
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error(`Nimbus: cannot size '${path}' for a resident process's module map`);
    }
    const out = new Uint8Array(size);
    for (let offset = 0; offset < size;) {
        const chunk = await fs.fsReadRangeUncached(path, offset, Math.min(RESIDENT_READ_RANGE_BYTES, size - offset));
        if (!chunk || chunk.byteLength === 0) {
            throw new Error(`Nimbus: '${path}' returned no bytes at offset ${offset}`);
        }
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}
function registerHostedRecord(self, workerKey, record) {
    const records = self._hostedProcesses;
    records.set(workerKey, record);
    const waiters = self._hostedProcessWaiters;
    const pending = waiters.get(workerKey);
    if (!pending)
        return;
    waiters.delete(workerKey);
    for (const notify of pending)
        notify(record);
}
/**
 * The record for `workerKey`, waiting briefly if the host leg has not landed
 * yet — the coordinator issues it first and it registers before its first
 * await, so normally there is nothing to wait for, but RPC delivery order is
 * not a guarantee.
 *
 * A host runs exactly ONE process: its Durable Object name carries the pid
 * (`<doId>:proc:<pid>:<attempt>`) and pids never repeat, being strided by
 * generation. So a key this host is not hosting is a key it never will host,
 * and parking a waiter for it would let anyone holding a NIMBUS_SESSION stub
 * accumulate map entries and 30-second timers here by the thousand. Once
 * something is known, an unknown key is refused immediately instead.
 */
function awaitHostedRecord(self, workerKey) {
    const records = self._hostedProcesses;
    const existing = records.get(workerKey);
    if (existing)
        return Promise.resolve(existing);
    const waiters = self._hostedProcessWaiters;
    if (records.size > 0 || (waiters.size > 0 && !waiters.has(workerKey))) {
        return Promise.reject(new Error(`Nimbus: peer hosts no process for key '${workerKey}'`));
    }
    return new Promise((resolve, reject) => {
        const pending = waiters.get(workerKey) ?? new Set();
        const notify = (record) => { clearTimeout(timer); resolve(record); };
        const timer = setTimeout(() => {
            pending.delete(notify);
            if (pending.size === 0)
                waiters.delete(workerKey);
            reject(new Error(`Nimbus: peer hosts no process for key '${workerKey}'`));
        }, HOSTED_RECORD_WAIT_MS);
        pending.add(notify);
        waiters.set(workerKey, pending);
    });
}
/**
 * RPC: placement probe. Returns this peer's module-scope isolate token so the
 * coordinator can verify the peer landed in a distinct workerd process — the
 * same token means a shared process, which is the CPU sharing a peer exists to
 * escape.
 */
export function _rpcProcessHostProbe(_self) {
    return { isolateToken: isolateToken() };
}
/**
 * RPC: host a resident process. Held open by the coordinator for the process's
 * whole life, and it is that held call which keeps this DO resident — nothing
 * arms an alarm to wake a host back up. Resolves when the coordinator releases
 * the process; rejects if it could not be opened at all.
 *
 * The runner's start CONTRACT never crosses. The coordinator's fabric decides
 * from it when the process is over and releases, which cancels this call — so
 * this leg holds uniformly and has no idea whether it is hosting a TUI or a
 * server.
 *
 * If the coordinator dies, workerd cancels this inbound call, the facet is
 * released in the `finally` below, and the process dies with it: a hosting
 * peer never outlives its parent session.
 */
export async function _rpcHostProcess(self, boot, opts) {
    const hostOpts = HostProcessOptsSchema.parse(opts);
    const spec = ResidentBootSpecSchema.parse(boot);
    const { workerKey } = hostOpts;
    const supervisor = {
        doId: hostOpts.coordinatorDoId,
        pid: hostOpts.pid,
        writerId: hostOpts.writerId,
    };
    let cancel = () => { };
    const cancelled = new Promise((resolve) => { cancel = resolve; });
    let settleFacet = () => { };
    let failFacet = () => { };
    const facetPromise = new Promise((resolve, reject) => {
        settleFacet = resolve;
        failFacet = reject;
    });
    let settleStarted = () => { };
    let failStarted = () => { };
    const startedPromise = new Promise((resolve, reject) => {
        settleStarted = resolve;
        failStarted = reject;
    });
    // Nothing awaits these unless a leg asks for them; keep the runtime from
    // reporting them as unhandled while the process is healthy.
    facetPromise.catch(() => { });
    startedPromise.catch(() => { });
    registerHostedRecord(self, workerKey, {
        facet: facetPromise,
        started: startedPromise,
        webSocketCapability: hostOpts.webSocketCapability,
        cancelled,
        cancel,
    });
    let facet;
    try {
        facet = processes(self.ctx, self.env).spawn(() => peerDiskReader(supervisor), supervisor, {
            pid: hostOpts.pid,
            workerKey,
            boot: spec,
            writerId: hostOpts.writerId,
            startArgs: hostOpts.startArgs,
        });
        settleFacet(facet);
        facet.started.then(settleStarted, failStarted);
        await cancelled;
        return { ok: true };
    }
    catch (e) {
        failFacet(e);
        failStarted(e);
        throw e;
    }
    finally {
        // The record OUTLIVES the process on purpose, and a peer hosts exactly one
        // (its name carries the pid), so this is one entry per host for the life of
        // the instance. Dropping it would make a request that arrives after a kill
        // wait out `HOSTED_RECORD_WAIT_MS` and then blame the wrong thing; keeping
        // it routes that request into the released facet, which is exactly what a
        // coordinator-hosted one does — it says the process is no longer running.
        await facet?.release();
    }
}
/**
 * RPC: settle once the process is OPEN on this peer, or reject with whatever
 * stopped it from opening.
 *
 * This exists so a host failure surfaces at the same place on both substrates.
 * Opening a facet of your own DO either throws or does not, before the fabric
 * has a handle; opening one on a peer is a message, and without this the
 * coordinator would return a handle for a process that never existed and only
 * discover it later, through `done`. A caller must not have to know which
 * substrate it is on to know what a successful spawn means.
 */
export async function _rpcAwaitHostedOpen(self, workerKey) {
    const record = await awaitHostedRecord(self, workerKey);
    await record.facet;
    return { ok: true };
}
/**
 * RPC: read back the runner's startProcess payload. `_rpcHostProcess` started
 * it; this never starts anything, so a coordinator asking twice gets the same
 * answer a local facet would have returned inline — and for a `lifetime`
 * runner it settles at exit, exactly as the local one does.
 */
export async function _rpcAwaitHostedBoot(self, workerKey) {
    const record = await awaitHostedRecord(self, workerKey);
    return { payload: await record.started };
}
/**
 * RPC: inbound HTTP for a port owned by a process this peer hosts.
 *
 * A `Request`/`Response` cannot cross a sibling-DO hop by reference — workerd
 * rejects it with "Entrypoints to dynamically-loaded workers cannot be
 * transferred to other Workers", because the object belongs to the
 * dynamically-loaded facet on the other side. Their PARTS travel fine, and a
 * body is a plain ReadableStream, which RPC transfers with flow control. So
 * the leg carries the parts and rebuilds the object on each side: no
 * buffering, no size ceiling, and an SSE or chunked body still flows live.
 *
 * The response body is re-piped through an identity stream owned by THIS
 * isolate before it is returned, for the same reason the parts exist at all:
 * what leaves here must not be an object the loaded worker owns.
 */
export async function _rpcRouteHostedHttp(self, workerKey, wire) {
    const record = await awaitHostedRecord(self, workerKey);
    const facet = await record.facet;
    const headers = new Headers();
    for (const [k, v] of wire.headers)
        headers.append(k, v);
    const init = { method: wire.method, headers };
    if (wire.body) {
        init.body = wire.body;
        init.duplex = 'half';
    }
    const response = await facet.handleHttpRequest(new Request(wire.url, init));
    let body = null;
    if (response.body) {
        const { readable, writable } = new IdentityTransformStream();
        self.ctx.waitUntil(response.body.pipeTo(writable).catch(() => { }));
        body = readable;
    }
    return {
        status: response.status,
        statusText: response.statusText,
        headers: headerPairs(response.headers),
        body,
    };
}
/**
 * The peer end of the upgrade hop. Reached by `fetch` rather than RPC, so the
 * 101 and its live socket travel back as themselves.
 *
 * The workerKey names a process and is derivable from a pid, so it does not
 * authorise on its own; the capability is minted by whoever opened the process
 * and never leaves the two sessions that hold it. A mismatch is a 404 and not
 * a 403, so the route reveals nothing about what this peer is hosting.
 */
export async function routeHostedWebSocket(self, workerKey, capability, request) {
    const record = await awaitHostedRecord(self, workerKey);
    if (record.webSocketCapability !== capability)
        return new Response('Not found', { status: 404 });
    const facet = await record.facet;
    return facet.handleWebSocketRequest(request);
}
/**
 * RPC: deterministic kill of a hosted process — the same teardown a
 * coordinator applies to a facet of its own, and it does not answer until it
 * has happened. The facet is released HERE rather than left to the held call's
 * `finally`, because a caller that has to guess whether the process is really
 * gone cannot retire the writer identity behind it.
 */
export async function _rpcCancelHostProcess(self, workerKey) {
    const records = self._hostedProcesses;
    const record = records.get(workerKey);
    if (!record)
        return { cancelled: false };
    const facet = await record.facet.catch(() => null);
    await facet?.release();
    try {
        record.cancel();
    }
    catch { /* best-effort */ }
    return { cancelled: true };
}
// ── Cache-observability stats forward (cache metrics support) ──────
//
// SupervisorRPC handlers run in a SEPARATE isolate from the DO they
// service (loopback service-binding semantics). When they bump
// per-tier cache counters via src/_shared/cache-stats.ts, they bump
// the LOCAL singleton in the SupervisorRPC isolate. /api/_diag/cache
// reads the DO's singleton — different grid, no visibility.
//
// Fix: SupervisorRPC handlers forward the bump via this DO-side RPC.
// Pattern mirrors recordR2RaceCounters in installer.ts:1168 where the
// facet returns counters and the supervisor folds them into the DO
// singleton. Here the loopback boundary is the equivalent of the
// facet-supervisor boundary.
//
// One forward per (tier, kind, isHit, bytes) tuple. Batch via the
// `events` array so a single supervisor RPC handler can flush multiple
// bumps in one round-trip.
import { recordHit as _rpcRecordHit, recordMiss as _rpcRecordMiss } from '@nimbus-sh/core/_shared/cache-stats.js';
export async function _rpcRecordCacheStats(_self, events) {
    // Defensive iteration — caller is in-house (supervisor-rpc.ts) but
    // a malformed event must NOT throw and break the install. Iterate
    // with type-narrowing; an unknown `kind` is silently skipped.
    for (const e of events) {
        if (e.kind === 'hit') {
            _rpcRecordHit(e.tier, e.cacheKind, e.bytes);
        }
        else if (e.kind === 'miss') {
            _rpcRecordMiss(e.tier, e.cacheKind);
        }
    }
}
