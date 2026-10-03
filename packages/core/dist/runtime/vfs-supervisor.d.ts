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
    readonly copyTree: "fsCopyTree";
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
 * The SupervisorRPC methods `answer` runs: the filesystem surface, every
 * table entry above but the streamed write, and the calls node's shims make
 * that the bridge does not name. The worker checks each is a method of its
 * SupervisorRPC.
 */
export declare const SUPERVISOR_ANSWERED_METHODS: readonly ["stat", "readFileBytes", "writeFile", "fsReadRange", "fsWriteRange", "fsTruncate", "utimes", "chmod", "access", "chown", "fsOpen", "fsRead", "fsWrite", "fsClose", "readdir", "mkdir", "unlink", "rmdir", "rename", "readlink", "symlink", "fsSync", "fsRevision", "fsAcquire", "fsList", "fsRealpath", "fsRemove", "fsCopyFile", "fsCopyTree", "fsFstat", "fsDup", "fsSeek", "fsSetStatus", "fsReaddirHandle", "fsFtruncate", "fsFchmod", "fsFchown", "fsFutimes", "fsAppend", "fsAppendAck", "writeBatch", "fsAcquireExclusiveMutation", "fsReleaseExclusiveMutation", "readFile", "writeFileStat", "lstat", "exists", "hasLegacySymlinkUnder", "setUmask", "fsAcquired", "fsStorageGrant", "fsReadRangeUncached", "fsReadBatch"];
export type SupervisorAnsweredMethod = typeof SUPERVISOR_ANSWERED_METHODS[number];
export declare function isSupervisorAnsweredMethod(name: unknown): name is SupervisorAnsweredMethod;
/**
 * A refusal as it crosses the hop: what workerd's enhanced_error_serialization
 * carries of a thrown error, as data. `properties` are the error's own ones
 * but `message` and `stack`: `code`, `errno`, `syscall`, `path`, `dest`,
 * `detail`, `cause`, whatever the host set (`name` too, when it is its own).
 */
export interface SupervisorRefusal {
    readonly name: string;
    readonly message: string;
    readonly properties: Readonly<Record<string, unknown>>;
}
/** What `answer` resolves with: the call's own value, or the refusal it was. */
export type SupervisorAnswer = {
    readonly value: unknown;
} | {
    readonly refusal: SupervisorRefusal;
};
/** The refusal `error` is, or undefined when it is not one (no string `code`) and must still throw. */
export declare function supervisorRefusal(error: unknown): SupervisorRefusal | undefined;
/**
 * The error `refusal` was, as the facet received it when SupervisorRPC threw
 * it: a new error of the thrower's type, its message, its own properties, and
 * no stack of the thrower's (src/workerd/jsg/ser.c++, with
 * preserveStackInErrors off).
 */
export declare function supervisorRefusalError(refusal: SupervisorRefusal): Error;
/**
 * `supervisor`, with its filesystem calls made through `answer` and each
 * refusal rethrown as the error it is; every other name is the stub's own.
 * A same-isolate supervisor is handed back as is: its refusals are thrown in
 * this isolate and cross nothing. The call's value is handed on and its
 * envelope released.
 */
export declare function answeringSupervisor<T extends object>(supervisor: T): T;
/**
 * Installs {@link answeringSupervisor} as `globalThis.__nimbusAnsweringSupervisor`,
 * for the facet bodies that are generated text and take it spliced in
 * (SUPERVISOR_ANSWERING_SRC).
 */
export declare function installAnsweringSupervisor(): void;
/**
 * Remote facets use the same typed supervisor RPC methods. A synchronous view
 * is a same-isolate capability: an RPC stub answers every property with a
 * callable, so it is never read from the stub, only carried by a local
 * supervisor whose view really is in this isolate. A remote supervisor's
 * refusals arrive as answers (answeringSupervisor).
 */
export declare function supervisorFilesystem(remote: WasiSupervisorStub, local?: RuntimeSynchronousFs): RuntimeFsBridge;
export {};
//# sourceMappingURL=vfs-supervisor.d.ts.map