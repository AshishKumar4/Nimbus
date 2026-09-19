import { CRED_SESSION_USER, requireVfsCred } from '../runtime/os-contracts.js';
import { SqliteRuntimeFsBridge } from '../runtime/sqlite-runtime-fs-bridge.js';
import { getSymlinkRegistry } from '../vfs/symlink-registry.js';
function stringArg(envelope, index) {
    const value = envelope.args?.[index];
    if (typeof value !== 'string') {
        throw new Error(`supervisor op ${envelope.op}: argument ${index} must be a string`);
    }
    return value;
}
function numberArg(envelope, index) {
    const value = envelope.args?.[index];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`supervisor op ${envelope.op}: argument ${index} must be a number`);
    }
    return value;
}
function contentArg(envelope, index) {
    const value = envelope.args?.[index];
    if (typeof value === 'string' || value instanceof Uint8Array)
        return value;
    if (value instanceof ArrayBuffer)
        return new Uint8Array(value);
    throw new Error(`supervisor op ${envelope.op}: argument ${index} must be bytes or text`);
}
function credFor(deps, pid, cred) {
    if (pid === undefined) {
        // Validated through the one VfsCred validator; a host that names a
        // credential names a well-formed one or gets nothing.
        return cred === undefined ? CRED_SESSION_USER : requireVfsCred(cred, 'supervisor op');
    }
    if (cred !== undefined) {
        throw new Error('supervisor op: a process acts as its own credential; cred cannot ride a pid');
    }
    if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error('supervisor op: filesystem operation requires a valid process pid');
    }
    return deps.processes ? deps.processes.cred(pid) : CRED_SESSION_USER;
}
/**
 * The canonical supervisor op set — every operation the supervisor RPC
 * serves. Three consumers key on these names:
 *
 *   - `sessionSupervisorOp` (worker): the DO's host — `extend` overrides for
 *     hosted accounting plus the non-filesystem ops it answers itself.
 *   - `createSupervisorOpHandler`: an in-process workspace — filesystem ops
 *     run against the VFS directly; every other op dispatches to
 *     `deps.host` through SUPERVISOR_OP_ROUTES, the embedder's `_rpc*`
 *     surface.
 *   - `supervisor-host-dispatch`: the test — derives every case's delegate
 *     and expected arguments from SUPERVISOR_OP_ROUTES, not a copied list.
 *
 * An op absent here is not served, on any host.
 */
export const SUPERVISOR_OPS = [
    'readFile', 'readFileBytes', 'writeFile', 'stat', 'lstat',
    'hasLegacySymlinkUnder', 'utimes', 'chmod', 'access', 'chown', 'setUmask',
    'readdir', 'exists', 'mkdir', 'rmdir', 'rename', 'unlink', 'readlink',
    'symlink', 'fsAcquire', 'fsRevision', 'fsList', 'wsOpen', 'wsPoll',
    'wsSend', 'wsClose', 'fsOpen', 'fsRead', 'fsWrite', 'fsClose',
    'fsReadRange', 'fsReadRangeUncached', 'fsReadBatch', 'fsWriteRange',
    'fsAppend', 'fsAppendAck', 'fsTruncate', 'writeBatch', 'writeBatchStream',
    'putRegistryEntries', 'stdout', 'stderr', 'prefetch', 'registerPort',
    'unregisterPort', 'reportExit', 'routeLoopback', 'transform', 'cpSpawn',
    'cpStdinWrite', 'cpStdinEnd', 'cpReadStdin', 'cpReadOutput',
    'cpDrainOutput', 'cpKill', 'cpWait', 'cpDispatchInline',
    'innerDoFetch', 'fanoutExecute', 'processHostProbe', 'hostProcess',
    'awaitHostedOpen', 'awaitHostedBoot', 'routeHostedHttp', 'cancelHostProcess', 'hmrRelay',
];
/** The host-side argument plan per op — how an envelope becomes an _rpc* call. */
export const SUPERVISOR_OP_ROUTES = {
    readFile: { method: '_rpcReadFile', args: [0, 'pid'] },
    readFileBytes: { method: '_rpcReadFileBytes', args: [0, 'pid'] },
    writeFile: { method: '_rpcWriteFile', args: [0, 1, 'pid'] },
    stat: { method: '_rpcStat', args: [0, 'pid'] },
    lstat: { method: '_rpcLstat', args: [0, 'pid'] },
    hasLegacySymlinkUnder: { method: '_rpcHasLegacySymlinkUnder', args: [0, 'pid'] },
    utimes: { method: '_rpcUtimes', args: [0, 1, 2, 'pid'] },
    chmod: { method: '_rpcChmod', args: [0, 1, 'pid'] },
    access: { method: '_rpcAccess', args: [0, 1, 'pid'] },
    chown: { method: '_rpcChown', args: [0, 1, 2, 'pid', 3] },
    setUmask: { method: '_rpcSetUmask', args: [0, 'pid'] },
    readdir: { method: '_rpcReaddir', args: [0, 'pid'] },
    exists: { method: '_rpcExists', args: [0, 'pid'] },
    mkdir: { method: '_rpcMkdir', args: [0, 'pid'] },
    rmdir: { method: '_rpcRmdir', args: [0, 'pid'] },
    rename: { method: '_rpcRename', args: [0, 1, 'pid'] },
    unlink: { method: '_rpcUnlink', args: [0, 'pid'] },
    readlink: { method: '_rpcReadlink', args: [0, 'pid'] },
    symlink: { method: '_rpcSymlink', args: [0, 1, 'pid'] },
    fsAcquire: { method: '_rpcFsAcquire', args: [0, 1, 'pid'] },
    fsRevision: { method: '_rpcFsRevision', args: [0, 'pid'] },
    fsList: { method: '_rpcFsList', args: [0, 1, 'pid'] },
    wsOpen: { method: '_rpcWsOpen', args: [0, 1, 'pid'] },
    wsPoll: { method: '_rpcWsPoll', args: [0, 1, 'pid'] },
    wsSend: { method: '_rpcWsSend', args: [0, 1, 2, 'pid'] },
    wsClose: { method: '_rpcWsClose', args: [0, 1, 2, 'pid'] },
    fsOpen: { method: '_rpcFsOpen', args: [0, 1, 'pid'] },
    fsRead: { method: '_rpcFsRead', args: [0, 1, 2, 'pid'] },
    fsWrite: { method: '_rpcFsWrite', args: [0, 1, 2, 'pid'] },
    fsClose: { method: '_rpcFsClose', args: [0, 'pid'] },
    fsReadRange: { method: '_rpcFsReadRange', args: [0, 1, 2, 'pid'] },
    fsReadRangeUncached: { method: '_rpcFsReadRangeUncached', args: [0, 1, 2, 'pid'] },
    fsReadBatch: { method: '_rpcFsReadBatch', args: [0, 'pid'] },
    fsWriteRange: { method: '_rpcFsWriteRange', args: [0, 1, 2, 'pid'] },
    fsAppend: { method: '_rpcFsAppend', args: [0, 'writerId', 1, 2, 3, 'pid'] },
    fsAppendAck: { method: '_rpcFsAppendAck', args: ['writerId', 0, 1, 'pid'] },
    fsTruncate: { method: '_rpcFsTruncate', args: [0, 1, 'pid'] },
    writeBatch: { method: '_rpcWriteBatch', args: [0, 'pid'] },
    writeBatchStream: { method: '_rpcWriteBatchStream', args: ['stream', 'mutationOwner', 'pid'] },
    putRegistryEntries: { method: '_rpcPutRegistryEntries', args: [0] },
    stdout: { method: '_rpcStdout', args: ['pid', 0] },
    stderr: { method: '_rpcStderr', args: ['pid', 0] },
    prefetch: { method: '_rpcPrefetch', args: [0, 1] },
    registerPort: { method: '_rpcRegisterPort', args: ['pid', 0] },
    unregisterPort: { method: '_rpcUnregisterPort', args: [0] },
    reportExit: { method: '_rpcReportExit', args: ['pid', 0, 1] },
    routeLoopback: { method: '_rpcRouteLoopback', args: [0, 1] },
    transform: { method: '_rpcTransform', args: [0, 1] },
    cpSpawn: { method: '_rpcCpSpawn', args: [0] },
    cpStdinWrite: { method: '_rpcCpStdinWrite', args: [0, 1] },
    cpStdinEnd: { method: '_rpcCpStdinEnd', args: [0] },
    cpReadStdin: { method: '_rpcCpReadStdin', args: [0, 1] },
    cpReadOutput: { method: '_rpcCpReadOutput', args: [0, 1, 2, 3] },
    cpDrainOutput: { method: '_rpcCpDrainOutput', args: [0] },
    cpKill: { method: '_rpcCpKill', args: [0, 1] },
    cpWait: { method: '_rpcCpWait', args: [0, 1] },
    cpDispatchInline: { method: '_rpcCpDispatchInline', args: [0, 1] },
    innerDoFetch: { method: '_rpcInnerDoFetch', args: [0] },
    fanoutExecute: { method: '_rpcFanoutExecute', args: [0, 1, 2] },
    processHostProbe: { method: '_rpcProcessHostProbe', args: [] },
    hostProcess: { method: '_rpcHostProcess', args: [0, 1] },
    awaitHostedOpen: { method: '_rpcAwaitHostedOpen', args: [0] },
    awaitHostedBoot: { method: '_rpcAwaitHostedBoot', args: [0] },
    routeHostedHttp: { method: '_rpcRouteHostedHttp', args: [0, 1] },
    cancelHostProcess: { method: '_rpcCancelHostProcess', args: [0] },
    hmrRelay: { method: '_rpcHmrRelay', args: [0, 1] },
};
/**
 * The ops `createSupervisorOpHandler` serves natively — one pid-keyed
 * filesystem bridge, plus the output stream. A session's `extend` overrides
 * never cover these by accident: `sessionSupervisorOps` builds its delegate
 * set from this name list, not a hand-copied table.
 */
export const SUPERVISOR_NATIVE_OPS = new Set([
    'readFile', 'readFileBytes', 'stat', 'lstat', 'exists', 'readdir',
    'readlink', 'fsReadRange', 'fsReadRangeUncached', 'fsRevision',
    'hasLegacySymlinkUnder', 'writeFile', 'mkdir', 'rmdir', 'unlink',
    'rename', 'symlink', 'chmod', 'utimes', 'fsTruncate',
    'writeBatchStream', 'stdout', 'stderr',
]);
/**
 * Exported so the session's `supervisorBridge` — used by RPC bodies the
 * envelope delegates back to (fsOpen, fsAppend, writeBatch, …) — is the
 * same cache the handler's native ops serve from, never a second one.
 */
export function createSupervisorBridgeStore(deps) {
    const bridges = new Map();
    return {
        bridge: (pid, cred) => {
            if (pid === undefined && cred !== undefined) {
                return new SqliteRuntimeFsBridge(deps.vfs.as(credFor(deps, pid, cred)), deps.vfs);
            }
            const key = pid ?? 0;
            const credentialed = deps.vfs.as(credFor(deps, pid, cred));
            const held = bridges.get(key);
            if (held) {
                held.updateCredential(credentialed);
                return held;
            }
            const built = new SqliteRuntimeFsBridge(credentialed, deps.vfs);
            bridges.set(key, built);
            return built;
        },
        forget: (pid) => { bridges.delete(pid); },
    };
}
/** One dispatch method lets any host serve its workspace to process facets. */
export function createSupervisorOpHandler(deps) {
    const bridgeFor = deps.bridge?.bridge ?? createSupervisorBridgeStore(deps).bridge;
    const tools = {
        bridge: bridgeFor,
        vfs: deps.vfs,
        cred: (pid, cred) => credFor(deps, pid, cred),
        output: deps.output,
    };
    const fs = (e) => bridgeFor(e.pid, e.cred);
    const ops = {
        readFile: async (e) => {
            const bytes = await fs(e).readFile(stringArg(e, 0));
            return bytes === null ? null : new TextDecoder().decode(bytes);
        },
        readFileBytes: (e) => fs(e).readFile(stringArg(e, 0)),
        stat: (e) => fs(e).stat(stringArg(e, 0)),
        lstat: (e) => fs(e).stat(stringArg(e, 0), { followSymlinks: false }),
        exists: async (e) => (await fs(e).stat(stringArg(e, 0))) !== null,
        readdir: (e) => fs(e).readdir(stringArg(e, 0)),
        readlink: (e) => fs(e).readlink(stringArg(e, 0)),
        fsReadRange: (e) => fs(e).readRange(stringArg(e, 0), numberArg(e, 1), numberArg(e, 2)),
        fsReadRangeUncached: (e) => fs(e).readRange(stringArg(e, 0), numberArg(e, 1), numberArg(e, 2), { cached: false }),
        fsRevision: (e) => fs(e).revision(e.args?.[0] === undefined ? undefined : stringArg(e, 0)),
        hasLegacySymlinkUnder: (e) => getSymlinkRegistry(deps.vfs).hasAtOrBelow(stringArg(e, 0)),
        writeFile: (e) => fs(e).writeFile(stringArg(e, 0), contentArg(e, 1)),
        mkdir: (e) => fs(e).mkdir(stringArg(e, 0), { recursive: true }),
        rmdir: (e) => fs(e).rmdir(stringArg(e, 0)),
        unlink: (e) => fs(e).unlink(stringArg(e, 0)),
        rename: (e) => fs(e).rename(stringArg(e, 0), stringArg(e, 1)),
        symlink: (e) => fs(e).symlink(stringArg(e, 0), stringArg(e, 1)),
        chmod: (e) => fs(e).chmod(stringArg(e, 0), numberArg(e, 1)),
        utimes: (e) => fs(e).utimes(stringArg(e, 0), numberArg(e, 1), numberArg(e, 2)),
        fsTruncate: (e) => fs(e).truncate(stringArg(e, 0), numberArg(e, 1)),
        writeBatchStream: (e) => {
            if (!e.stream)
                throw new Error('supervisor op writeBatchStream: no stream');
            return deps.vfs.as(credFor(deps, e.pid, e.cred)).writeStream(e.stream, { mutationOwner: e.mutationOwner });
        },
        stdout: (e) => { deps.output?.('stdout', e.pid ?? 0, stringArg(e, 0)); },
        stderr: (e) => { deps.output?.('stderr', e.pid ?? 0, stringArg(e, 0)); },
    };
    const extend = deps.extend ?? {};
    return async (envelope) => {
        if (!envelope || typeof envelope.op !== 'string') {
            throw new Error('supervisor op: envelope names no operation');
        }
        // Priority: the embedder's own handler → the native filesystem op → the
        // canonical route table onto the host's _rpc* methods. An op in none of
        // these is not served by this host.
        const handler = Object.hasOwn(extend, envelope.op) ? extend[envelope.op]
            : Object.hasOwn(ops, envelope.op) ? ops[envelope.op] : undefined;
        if (handler)
            return handler(envelope, tools);
        const route = Object.hasOwn(SUPERVISOR_OP_ROUTES, envelope.op)
            ? SUPERVISOR_OP_ROUTES[envelope.op] : undefined;
        if (!route)
            throw new Error(`supervisor op: '${envelope.op}' is not served by this host`);
        const host = deps.host;
        if (!host)
            throw new Error(`supervisor op: '${envelope.op}' needs a host that this workspace does not have`);
        const method = host[route.method];
        if (typeof method !== 'function')
            throw new Error(`supervisor op: missing host method ${route.method}`);
        const args = route.args.map((slot) => typeof slot === 'number' ? envelope.args?.[slot] : envelope[slot]);
        return Reflect.apply(method, host, args);
    };
}
