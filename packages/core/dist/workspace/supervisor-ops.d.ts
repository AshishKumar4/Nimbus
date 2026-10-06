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
 *   Nor are the descriptor read `fsRead` (it advances the position and
 *   answers bytes a receipt would have to hold) or `fsAppend`/`fsAppendAck`
 *   (the append ledger's writer/module/operation identity makes them
 *   repeatable).
 * - 'joined': a filesystem read the supervisor may send more than once (it
 *   re-sends a dropped one and hedges an unanswered one), each attempt under
 *   the one read id it minted; a repeat that reaches the host while the read
 *   is served joins it (SupervisorDeliveries.joinRead).
 * - null: sent once (the process, socket, port and storage-grant ops).
 */
export declare const SUPERVISOR_OP_TABLE: {
    readonly readFile: "joined";
    readonly readFileBytes: "joined";
    readonly writeFile: "once";
    readonly writeFileStat: "once";
    readonly stat: "joined";
    readonly lstat: "joined";
    readonly hasLegacySymlinkUnder: "joined";
    readonly utimes: "once";
    readonly chmod: "once";
    readonly access: "joined";
    readonly chown: "once";
    readonly setUmask: null;
    readonly readdir: "joined";
    readonly exists: "joined";
    readonly mkdir: "once";
    readonly rmdir: "once";
    readonly rename: "once";
    readonly unlink: "once";
    readonly readlink: "joined";
    readonly fsLinkLeadsTo: "joined";
    readonly symlink: "once";
    readonly fsAcquire: "joined";
    readonly fsAcquired: "joined";
    readonly fsRevision: "joined";
    readonly fsList: "joined";
    readonly fsStorageGrant: null;
    readonly wsOpen: null;
    readonly wsPoll: null;
    readonly wsSend: null;
    readonly wsClose: null;
    readonly fsOpen: "once";
    readonly fsRead: null;
    readonly fsWrite: "once";
    readonly fsClose: "once";
    readonly fsReadRange: "joined";
    readonly fsReadRangeUncached: "joined";
    readonly fsReadBatch: "joined";
    readonly fsWriteRange: "once";
    readonly fsAppend: null;
    readonly fsAppendAck: null;
    readonly fsTruncate: "once";
    readonly writeBatch: "once";
    readonly writeBatchStream: null;
    readonly openWaveWriter: null;
    readonly putRegistryEntries: null;
    readonly stdout: null;
    readonly stderr: null;
    readonly prefetch: null;
    readonly registerPort: null;
    readonly allocatePort: null;
    readonly unregisterPort: null;
    readonly reportExit: null;
    readonly routeLoopback: null;
    readonly transform: null;
    readonly cpSpawn: null;
    readonly reportRuntimeCode: null;
    readonly cpStdinWrite: null;
    readonly cpStdinEnd: null;
    readonly cpReadStdin: null;
    readonly cpReadOutput: null;
    readonly cpDrainOutput: null;
    readonly cpKill: null;
    readonly cpWait: null;
    readonly cpBlocked: null;
    readonly fsFstat: "joined";
    readonly fsDup: "once";
    readonly fsSeek: "once";
    readonly fsSetStatus: "once";
    readonly fsReaddirHandle: "joined";
    readonly fsFtruncate: "once";
    readonly fsFchmod: "once";
    readonly fsFchown: "once";
    readonly fsFutimes: "once";
    readonly fsSync: "once";
    readonly fsRealpath: "joined";
    readonly fsRemove: "once";
    readonly fsCopyFile: "once";
    readonly fsCopyTree: "once";
    readonly fsAcquireExclusiveMutation: "once";
    readonly fsReleaseExclusiveMutation: "once";
    readonly innerDoFetch: null;
    readonly innerDoCall: null;
    readonly fanoutExecute: null;
    readonly processHostProbe: null;
    readonly hostProcess: null;
    readonly awaitHostedOpen: null;
    readonly awaitHostedBoot: null;
    readonly routeHostedHttp: null;
    readonly cancelHostProcess: null;
    readonly hmrRelay: null;
    readonly hmrNextEvent: null;
    readonly replayBoundary: null;
    readonly netTls: null;
    readonly outbound: null;
    readonly stdinFileRead: null;
    readonly stdinPrepared: null;
    readonly getCachedTarball: null;
    readonly putCachedTarball: null;
    readonly getPackument: null;
    readonly cacheResult: null;
};
export type SupervisorOpName = keyof typeof SUPERVISOR_OP_TABLE;
/** The ops resent as `R` says (SUPERVISOR_OP_TABLE). */
type OpsResent<R> = {
    [K in SupervisorOpName]: (typeof SUPERVISOR_OP_TABLE)[K] extends R ? K : never;
}[SupervisorOpName];
export type SupervisorDeliveredOpName = OpsResent<'once'>;
export type SupervisorJoinedReadOpName = OpsResent<'joined'>;
export declare const SUPERVISOR_OPS: readonly SupervisorOpName[];
export declare const SUPERVISOR_DELIVERED_OPS: readonly SupervisorDeliveredOpName[];
export declare const SUPERVISOR_JOINED_READ_OPS: readonly SupervisorJoinedReadOpName[];
export {};
//# sourceMappingURL=supervisor-ops.d.ts.map