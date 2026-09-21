import type { RuntimeFsBridge, RuntimeSynchronousFs } from './os-contracts.js';
import type { WasiSupervisorStub } from './wasi/types.js';
/** Names on the existing supervisor RPC capability; this table owns no state. */
export declare const FILESYSTEM_RPC_METHODS: {
    readonly stat: "stat";
    readonly readFile: "readFileBytes";
    readonly writeFile: "writeFile";
    readonly readRange: "fsReadRange";
    readonly writeRange: "fsWriteRange";
    readonly truncate: "fsTruncate";
    readonly utimes: "utimes";
    readonly chmod: "chmod";
    readonly access: "access";
    readonly chown: "chown";
    readonly open: "fsOpen";
    readonly read: "fsRead";
    readonly write: "fsWrite";
    readonly close: "fsClose";
    readonly readdir: "readdir";
    readonly mkdir: "mkdir";
    readonly unlink: "unlink";
    readonly rmdir: "rmdir";
    readonly rename: "rename";
    readonly readlink: "readlink";
    readonly symlink: "symlink";
    readonly fsync: "fsSync";
    readonly revision: "fsRevision";
    readonly acquire: "fsAcquire";
    readonly list: "fsList";
    readonly realpath: "fsRealpath";
    readonly remove: "fsRemove";
    readonly copyFile: "fsCopyFile";
    readonly fstat: "fsFstat";
    readonly dup: "fsDup";
    readonly seek: "fsSeek";
    readonly setStatus: "fsSetStatus";
    readonly readdirHandle: "fsReaddirHandle";
    readonly ftruncate: "fsFtruncate";
    readonly fchmod: "fsFchmod";
    readonly fchown: "fsFchown";
    readonly futimes: "fsFutimes";
    readonly appendOnce: "fsAppend";
    readonly acknowledgeAppend: "fsAppendAck";
    readonly writeBatch: "writeBatch";
    readonly writeStream: "writeBatchStream";
    readonly acquireExclusiveMutation: "fsAcquireExclusiveMutation";
    readonly releaseExclusiveMutation: "fsReleaseExclusiveMutation";
};
type Method = keyof typeof FILESYSTEM_RPC_METHODS;
export type FilesystemSupervisor = {
    [K in Method as typeof FILESYSTEM_RPC_METHODS[K]]: RuntimeFsBridge[K];
} & {
    readonly synchronous?: RuntimeSynchronousFs;
};
/** Local facets retain the process-bound bridge and its synchronous capability. */
export declare function vfsSupervisor(fs: RuntimeFsBridge): FilesystemSupervisor;
/**
 * Remote facets use the same typed supervisor RPC methods. A synchronous view
 * is a same-isolate capability: an RPC stub answers every property with a
 * callable, so it is never read from the stub, only carried by a local
 * supervisor whose view really is in this isolate.
 */
export declare function supervisorFilesystem(supervisor: WasiSupervisorStub, local?: RuntimeSynchronousFs): RuntimeFsBridge;
export {};
//# sourceMappingURL=vfs-supervisor.d.ts.map