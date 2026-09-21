import type { RuntimeFsBridge, RuntimeSynchronousFs } from './os-contracts.js';
import type { WasiSupervisorStub } from './wasi/types.js';

/** Names on the existing supervisor RPC capability; this table owns no state. */
export const FILESYSTEM_RPC_METHODS = {
  stat: 'stat', readFile: 'readFileBytes', writeFile: 'writeFile', readRange: 'fsReadRange',
  writeRange: 'fsWriteRange', truncate: 'fsTruncate', utimes: 'utimes', chmod: 'chmod',
  access: 'access', chown: 'chown', open: 'fsOpen', read: 'fsRead', write: 'fsWrite',
  close: 'fsClose', readdir: 'readdir', mkdir: 'mkdir', unlink: 'unlink', rmdir: 'rmdir',
  rename: 'rename', readlink: 'readlink', symlink: 'symlink', fsync: 'fsSync', revision: 'fsRevision',
  acquire: 'fsAcquire', list: 'fsList', realpath: 'fsRealpath', remove: 'fsRemove', copyFile: 'fsCopyFile',
  fstat: 'fsFstat', dup: 'fsDup', seek: 'fsSeek', setStatus: 'fsSetStatus', readdirHandle: 'fsReaddirHandle',
  ftruncate: 'fsFtruncate', fchmod: 'fsFchmod', fchown: 'fsFchown', futimes: 'fsFutimes',
  appendOnce: 'fsAppend', acknowledgeAppend: 'fsAppendAck', writeBatch: 'writeBatch',
  writeStream: 'writeBatchStream', acquireExclusiveMutation: 'fsAcquireExclusiveMutation',
  releaseExclusiveMutation: 'fsReleaseExclusiveMutation',
} as const satisfies Record<Exclude<keyof RuntimeFsBridge, 'synchronous' | 'subscribe'>, string>;

type Method = keyof typeof FILESYSTEM_RPC_METHODS;
export type FilesystemSupervisor = {
  [K in Method as typeof FILESYSTEM_RPC_METHODS[K]]: RuntimeFsBridge[K];
} & { readonly synchronous?: RuntimeSynchronousFs };

/** Local facets retain the process-bound bridge and its synchronous capability. */
export function vfsSupervisor(fs: RuntimeFsBridge): FilesystemSupervisor {
  return {
    synchronous: fs.synchronous,
    stat: (...args) => fs.stat(...args),
    readFileBytes: (...args) => fs.readFile(...args),
    writeFile: (...args) => fs.writeFile(...args),
    fsReadRange: (...args) => fs.readRange(...args),
    fsWriteRange: (...args) => fs.writeRange(...args),
    fsTruncate: (...args) => fs.truncate(...args),
    utimes: (...args) => fs.utimes(...args),
    chmod: (...args) => fs.chmod(...args),
    access: (...args) => fs.access(...args),
    chown: (...args) => fs.chown(...args),
    fsOpen: (...args) => fs.open(...args),
    fsRead: (...args) => fs.read(...args),
    fsWrite: (...args) => fs.write(...args),
    fsClose: (...args) => fs.close(...args),
    readdir: (...args) => fs.readdir(...args),
    mkdir: (...args) => fs.mkdir(...args),
    unlink: (...args) => fs.unlink(...args),
    rmdir: (...args) => fs.rmdir(...args),
    rename: (...args) => fs.rename(...args),
    readlink: (...args) => fs.readlink(...args),
    symlink: (...args) => fs.symlink(...args),
    fsSync: (...args) => fs.fsync(...args),
    fsRevision: (...args) => fs.revision(...args),
    fsAcquire: (...args) => fs.acquire(...args),
    fsList: (...args) => fs.list(...args),
    fsRealpath: (...args) => fs.realpath(...args),
    fsRemove: (...args) => fs.remove(...args),
    fsCopyFile: (...args) => fs.copyFile(...args),
    fsFstat: (...args) => fs.fstat(...args),
    fsDup: (...args) => fs.dup(...args),
    fsSeek: (...args) => fs.seek(...args),
    fsSetStatus: (...args) => fs.setStatus(...args),
    fsReaddirHandle: (...args) => fs.readdirHandle(...args),
    fsFtruncate: (...args) => fs.ftruncate(...args),
    fsFchmod: (...args) => fs.fchmod(...args),
    fsFchown: (...args) => fs.fchown(...args),
    fsFutimes: (...args) => fs.futimes(...args),
    fsAppend: (...args) => fs.appendOnce(...args),
    fsAppendAck: (...args) => fs.acknowledgeAppend(...args),
    writeBatch: (...args) => fs.writeBatch(...args),
    writeBatchStream: (...args) => fs.writeStream(...args),
    fsAcquireExclusiveMutation: (...args) => fs.acquireExclusiveMutation(...args),
    fsReleaseExclusiveMutation: (...args) => fs.releaseExclusiveMutation(...args),
  };
}

/**
 * A workerd RPC hop keeps an error's message but not its own properties, and
 * bytes come back as an ArrayBuffer. Every filesystem error names its code as
 * the message prefix, so the boundary restores both before the codec looks.
 * A same-isolate supervisor answers synchronously and is handed back as is: a
 * guest that cannot park reads the value straight off the import. What the
 * stub returns is a thenable of its own class, not a Promise, so the test is
 * for `then` and the repaired result is a real Promise.
 */
function pending(result: unknown): result is PromiseLike<unknown> {
  // workerd's RPC promise is a callable proxy (pipelined calls), so its type is 'function'.
  return (typeof result === 'object' || typeof result === 'function') && result !== null
    && typeof (result as PromiseLike<unknown>).then === 'function';
}
function hop<T>(result: Promise<T> | T): Promise<T> | T {
  return pending(result) ? Promise.resolve(result).catch(restoreCode) : result;
}
function bytes<T extends Uint8Array | null>(result: Promise<T | ArrayBuffer> | T | ArrayBuffer): Promise<T | Uint8Array> | T | Uint8Array {
  return pending(result) ? Promise.resolve(result).catch(restoreCode).then(asBytes) : asBytes(result);
}
function asBytes<T extends Uint8Array | null>(value: T | ArrayBuffer): T | Uint8Array {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}
function restoreCode(error: unknown): never {
  if (error instanceof Error && !('code' in error)) {
    const code = /^([A-Z]+):/.exec(error.message)?.[1];
    if (code) throw Object.assign(error, { code });
  }
  throw error;
}

/**
 * Remote facets use the same typed supervisor RPC methods. A synchronous view
 * is a same-isolate capability: an RPC stub answers every property with a
 * callable, so it is never read from the stub, only carried by a local
 * supervisor whose view really is in this isolate.
 */
export function supervisorFilesystem(supervisor: WasiSupervisorStub, local?: RuntimeSynchronousFs): RuntimeFsBridge {
  return {
    synchronous: local,
    stat: (...args) => hop(supervisor.stat(...args)),
    readFile: (...args) => bytes(supervisor.readFileBytes(...args)),
    writeFile: (...args) => hop(supervisor.writeFile(...args)),
    readRange: (...args) => bytes(supervisor.fsReadRange(...args)),
    writeRange: (...args) => hop(supervisor.fsWriteRange(...args)),
    truncate: (...args) => hop(supervisor.fsTruncate(...args)),
    utimes: (...args) => hop(supervisor.utimes(...args)),
    chmod: (...args) => hop(supervisor.chmod(...args)),
    access: (...args) => hop(supervisor.access(...args)),
    chown: (...args) => hop(supervisor.chown(...args)),
    open: (...args) => hop(supervisor.fsOpen(...args)),
    read: (...args) => bytes(supervisor.fsRead(...args)),
    write: (...args) => hop(supervisor.fsWrite(...args)),
    close: (...args) => hop(supervisor.fsClose(...args)),
    readdir: (...args) => hop(supervisor.readdir(...args)),
    mkdir: (...args) => hop(supervisor.mkdir(...args)),
    unlink: (...args) => hop(supervisor.unlink(...args)),
    rmdir: (...args) => hop(supervisor.rmdir(...args)),
    rename: (...args) => hop(supervisor.rename(...args)),
    readlink: (...args) => hop(supervisor.readlink(...args)),
    symlink: (...args) => hop(supervisor.symlink(...args)),
    fsync: (...args) => hop(supervisor.fsSync(...args)),
    revision: (...args) => hop(supervisor.fsRevision(...args)),
    acquire: (...args) => hop(supervisor.fsAcquire(...args)),
    list: (...args) => hop(supervisor.fsList(...args)),
    realpath: (...args) => hop(supervisor.fsRealpath(...args)),
    remove: (...args) => hop(supervisor.fsRemove(...args)),
    copyFile: (...args) => hop(supervisor.fsCopyFile(...args)),
    fstat: (...args) => hop(supervisor.fsFstat(...args)),
    dup: (...args) => hop(supervisor.fsDup(...args)),
    seek: (...args) => hop(supervisor.fsSeek(...args)),
    setStatus: (...args) => hop(supervisor.fsSetStatus(...args)),
    readdirHandle: (...args) => hop(supervisor.fsReaddirHandle(...args)),
    ftruncate: (...args) => hop(supervisor.fsFtruncate(...args)),
    fchmod: (...args) => hop(supervisor.fsFchmod(...args)),
    fchown: (...args) => hop(supervisor.fsFchown(...args)),
    futimes: (...args) => hop(supervisor.fsFutimes(...args)),
    appendOnce: (...args) => hop(supervisor.fsAppend(...args)),
    acknowledgeAppend: (...args) => hop(supervisor.fsAppendAck(...args)),
    writeBatch: (...args) => hop(supervisor.writeBatch(...args)),
    writeStream: (...args) => Promise.resolve(supervisor.writeBatchStream(...args)).catch(restoreCode),
    acquireExclusiveMutation: (...args) => hop(supervisor.fsAcquireExclusiveMutation(...args)),
    releaseExclusiveMutation: (...args) => hop(supervisor.fsReleaseExclusiveMutation(...args)),
  };
}

