// Only named supervisor operations are callable; no RPC name comes from input.
const routes = {
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
    fsAppendAck: { method: '_rpcFsAppendAck', args: [0, 1, 2, 'pid'] },
    fsTruncate: { method: '_rpcFsTruncate', args: [0, 1, 'pid'] },
    writeBatch: { method: '_rpcWriteBatch', args: [0, 'pid'] },
    writeBatchStream: { method: '_rpcWriteBatchStream', args: ['stream', 'mutationOwner', 'pid'] },
    putRegistryEntries: { method: '_rpcPutRegistryEntries', args: [0] },
    stdout: { method: '_rpcStdout', args: ['pid', 0] },
    stderr: { method: '_rpcStderr', args: ['pid', 0] },
    reportExit: { method: '_rpcReportExit', args: ['pid', 0, 1] },
    prefetch: { method: '_rpcPrefetch', args: [0, 1] },
    registerPort: { method: '_rpcRegisterPort', args: ['pid', 0] },
    unregisterPort: { method: '_rpcUnregisterPort', args: [0] },
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
};
/** Preserve hosted accounting and lifecycle work behind the shared host seam. */
export async function sessionSupervisorOp(host, envelope) {
    if (!envelope || typeof envelope.op !== 'string' || !Object.hasOwn(routes, envelope.op)) {
        throw new Error(`supervisor op: '${envelope?.op}' is not served by this host`);
    }
    const route = routes[envelope.op];
    const args = route.args.map((slot) => typeof slot === 'number' ? envelope.args?.[slot] : envelope[slot]);
    const method = host[route.method];
    if (typeof method !== 'function')
        throw new Error(`supervisor op: missing host method ${route.method}`);
    return Reflect.apply(method, host, args);
}
