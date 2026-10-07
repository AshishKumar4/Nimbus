/**
 * Every op a process's supervisor sends its host, and how a resend of it is
 * met: the one table of them. supervisor-op.ts routes them,
 * supervisor-delivery.ts keeps the receipts; both read it here, which
 * neither imports from the other.
 *
 * - 'once': a filesystem mutation the host applies exactly once
 *   (SupervisorDeliveries; it travels as SUPERVISOR_DELIVER_OP).
 *   `writeBatchStream` is not one: its stream is consumed by the first
 *   delivery, and its writer re-sends a lost wave re-encoded, under a newer
 *   fence in an epoch the host issued (SupervisorDeliveries.admitWave).
 *   Nor is the descriptor read `fsRead` (it advances the position and
 *   answers bytes a receipt would have to hold).
 * - 'joined': a filesystem read the supervisor may send more than once (it
 *   re-sends a dropped one and hedges an unanswered one), each attempt under
 *   the one read id it minted; a repeat that reaches the host while the read
 *   is served joins it (SupervisorDeliveries.joinRead).
 * - null: sent once (the process, socket, port and storage-grant ops).
 */
export const SUPERVISOR_OP_TABLE = {
    readFile: 'joined',
    readFileBytes: 'joined',
    writeFile: 'once',
    writeFileStat: 'once',
    stat: 'joined',
    lstat: 'joined',
    hasLegacySymlinkUnder: 'joined',
    utimes: 'once',
    chmod: 'once',
    access: 'joined',
    chown: 'once',
    setUmask: null,
    readdir: 'joined',
    exists: 'joined',
    mkdir: 'once',
    rmdir: 'once',
    rename: 'once',
    unlink: 'once',
    readlink: 'joined',
    fsLinkLeadsTo: 'joined',
    symlink: 'once',
    fsAcquire: 'joined',
    fsAcquired: 'joined',
    fsRevision: 'joined',
    fsList: 'joined',
    fsStorageGrant: null,
    wsOpen: null,
    wsPoll: null,
    wsSend: null,
    wsClose: null,
    fsOpen: 'once',
    fsRead: null,
    fsWrite: 'once',
    fsClose: 'once',
    fsReadRange: 'joined',
    fsReadRangeUncached: 'joined',
    fsReadBatch: 'joined',
    fsWriteRange: 'once',
    fsTruncate: 'once',
    writeBatch: 'once',
    writeBatchStream: null,
    openWaveWriter: null,
    retireWaveWriter: null,
    putRegistryEntries: null,
    stdout: null,
    stderr: null,
    prefetch: null,
    registerPort: null,
    allocatePort: null,
    unregisterPort: null,
    reportExit: null,
    routeLoopback: null,
    transform: null,
    cpSpawn: null,
    reportRuntimeCode: null,
    cpStdinWrite: null,
    cpStdinEnd: null,
    cpReadStdin: null,
    cpReadOutput: null,
    cpDrainOutput: null,
    cpKill: null,
    cpWait: null,
    cpBlocked: null,
    fsFstat: 'joined',
    fsDup: 'once',
    fsSeek: 'once',
    fsSetStatus: 'once',
    fsReaddirHandle: 'joined',
    fsFtruncate: 'once',
    fsFchmod: 'once',
    fsFchown: 'once',
    fsFutimes: 'once',
    fsSync: 'once',
    fsRealpath: 'joined',
    fsRemove: 'once',
    fsCopyFile: 'once',
    fsCopyTree: 'once',
    fsAcquireExclusiveMutation: 'once',
    fsReleaseExclusiveMutation: 'once',
    fsAwaitRecall: null,
    fsRecalled: 'once',
    innerDoFetch: null,
    innerDoCall: null,
    fanoutExecute: null,
    processHostProbe: null,
    hostProcess: null,
    awaitHostedOpen: null,
    awaitHostedBoot: null,
    routeHostedHttp: null,
    cancelHostProcess: null,
    hmrRelay: null,
    hmrNextEvent: null,
    replayBoundary: null,
    netTls: null,
    outbound: null,
    stdinFileRead: null,
    stdinPrepared: null,
    getCachedTarball: null,
    putCachedTarball: null,
    getPackument: null,
    cacheResult: null,
};
export const SUPERVISOR_OPS = Object.keys(SUPERVISOR_OP_TABLE);
export const SUPERVISOR_DELIVERED_OPS = SUPERVISOR_OPS
    .filter((op) => SUPERVISOR_OP_TABLE[op] === 'once');
export const SUPERVISOR_JOINED_READ_OPS = SUPERVISOR_OPS
    .filter((op) => SUPERVISOR_OP_TABLE[op] === 'joined');
