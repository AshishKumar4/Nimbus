/**
 * filesystem-methods.ts — the one table of the filesystem bridge's methods a
 * supervisor answers: each method's name on the supervisor RPC capability,
 * and how its answer crosses a supervisor hop.
 *
 * Core's build writes the two mirrors of the table from it
 * (scripts/generate-filesystem-mirrors.mjs → filesystem-mirrors.generated.ts):
 * the supervisor a bridge serves (vfsSupervisor) and the bridge over a
 * supervisor (bridgeOverSupervisor), one typed arrow per method, so the
 * compiler checks each method's arguments and answer against both sides.
 * A method added here and not regenerated fails the typecheck.
 *
 * Imports nothing at run time: the generator bundles this module to read
 * the table.
 */
import type { RuntimeFsBridge, RuntimeSynchronousFs } from './os-contracts.js';
/**
 * How a method's answer crosses a supervisor hop: `value` as the hop hands
 * it; `bytes` an ArrayBuffer after the hop, made a Uint8Array again; `stream`
 * a W7 stream, which travels as the call's own result, never inside
 * `answer`'s argument list.
 */
export type FilesystemAnswer = 'value' | 'bytes' | 'stream';
export declare const FILESYSTEM_METHODS: {
    readonly stat: {
        readonly rpc: "stat";
        readonly answer: "value";
    };
    readonly readFile: {
        readonly rpc: "readFileBytes";
        readonly answer: "bytes";
    };
    readonly writeFile: {
        readonly rpc: "writeFile";
        readonly answer: "value";
    };
    readonly readRange: {
        readonly rpc: "fsReadRange";
        readonly answer: "bytes";
    };
    readonly writeRange: {
        readonly rpc: "fsWriteRange";
        readonly answer: "value";
    };
    readonly truncate: {
        readonly rpc: "fsTruncate";
        readonly answer: "value";
    };
    readonly utimes: {
        readonly rpc: "utimes";
        readonly answer: "value";
    };
    readonly chmod: {
        readonly rpc: "chmod";
        readonly answer: "value";
    };
    readonly access: {
        readonly rpc: "access";
        readonly answer: "value";
    };
    readonly chown: {
        readonly rpc: "chown";
        readonly answer: "value";
    };
    readonly open: {
        readonly rpc: "fsOpen";
        readonly answer: "value";
    };
    readonly read: {
        readonly rpc: "fsRead";
        readonly answer: "bytes";
    };
    readonly write: {
        readonly rpc: "fsWrite";
        readonly answer: "value";
    };
    readonly close: {
        readonly rpc: "fsClose";
        readonly answer: "value";
    };
    readonly readdir: {
        readonly rpc: "readdir";
        readonly answer: "value";
    };
    readonly mkdir: {
        readonly rpc: "mkdir";
        readonly answer: "value";
    };
    readonly unlink: {
        readonly rpc: "unlink";
        readonly answer: "value";
    };
    readonly rmdir: {
        readonly rpc: "rmdir";
        readonly answer: "value";
    };
    readonly rename: {
        readonly rpc: "rename";
        readonly answer: "value";
    };
    readonly readlink: {
        readonly rpc: "readlink";
        readonly answer: "value";
    };
    readonly linkLeadsTo: {
        readonly rpc: "fsLinkLeadsTo";
        readonly answer: "value";
    };
    readonly symlink: {
        readonly rpc: "symlink";
        readonly answer: "value";
    };
    readonly fsync: {
        readonly rpc: "fsSync";
        readonly answer: "value";
    };
    readonly revision: {
        readonly rpc: "fsRevision";
        readonly answer: "value";
    };
    readonly acquire: {
        readonly rpc: "fsAcquire";
        readonly answer: "value";
    };
    readonly list: {
        readonly rpc: "fsList";
        readonly answer: "value";
    };
    readonly realpath: {
        readonly rpc: "fsRealpath";
        readonly answer: "value";
    };
    readonly remove: {
        readonly rpc: "fsRemove";
        readonly answer: "value";
    };
    readonly copyFile: {
        readonly rpc: "fsCopyFile";
        readonly answer: "value";
    };
    readonly copyTree: {
        readonly rpc: "fsCopyTree";
        readonly answer: "value";
    };
    readonly fstat: {
        readonly rpc: "fsFstat";
        readonly answer: "value";
    };
    readonly dup: {
        readonly rpc: "fsDup";
        readonly answer: "value";
    };
    readonly seek: {
        readonly rpc: "fsSeek";
        readonly answer: "value";
    };
    readonly setStatus: {
        readonly rpc: "fsSetStatus";
        readonly answer: "value";
    };
    readonly readdirHandle: {
        readonly rpc: "fsReaddirHandle";
        readonly answer: "value";
    };
    readonly ftruncate: {
        readonly rpc: "fsFtruncate";
        readonly answer: "value";
    };
    readonly fchmod: {
        readonly rpc: "fsFchmod";
        readonly answer: "value";
    };
    readonly fchown: {
        readonly rpc: "fsFchown";
        readonly answer: "value";
    };
    readonly futimes: {
        readonly rpc: "fsFutimes";
        readonly answer: "value";
    };
    readonly writeBatch: {
        readonly rpc: "writeBatch";
        readonly answer: "value";
    };
    readonly writeStream: {
        readonly rpc: "writeBatchStream";
        readonly answer: "stream";
    };
    readonly acquireExclusiveMutation: {
        readonly rpc: "fsAcquireExclusiveMutation";
        readonly answer: "value";
    };
    readonly releaseExclusiveMutation: {
        readonly rpc: "fsReleaseExclusiveMutation";
        readonly answer: "value";
    };
    readonly awaitRecall: {
        readonly rpc: "fsAwaitRecall";
        readonly answer: "value";
    };
    readonly recalled: {
        readonly rpc: "fsRecalled";
        readonly answer: "value";
    };
};
export type FilesystemMethod = keyof typeof FILESYSTEM_METHODS;
/** The supervisor RPC capability's filesystem: each bridge method under its RPC name, with its type. */
export type FilesystemSupervisor = {
    [K in FilesystemMethod as typeof FILESYSTEM_METHODS[K]['rpc']]: RuntimeFsBridge[K];
} & {
    readonly synchronous?: RuntimeSynchronousFs;
};
/** A `value` answer. */
export declare function answerValue<T>(result: Promise<T> | T): Promise<T> | T;
/** A `bytes` answer. */
export declare function answerBytes<T extends Uint8Array | null>(result: Promise<T | ArrayBuffer> | T | ArrayBuffer): Promise<T | Uint8Array> | T | Uint8Array;
/** A `stream` answer: always a Promise. */
export declare function answerStream<T>(result: Promise<T> | T): Promise<T>;
//# sourceMappingURL=filesystem-methods.d.ts.map