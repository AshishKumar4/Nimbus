import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
/** Names on the existing supervisor RPC capability; this table owns no state. */
export const FILESYSTEM_RPC_METHODS = {
    stat: 'stat', readFile: 'readFileBytes', writeFile: 'writeFile', readRange: 'fsReadRange',
    writeRange: 'fsWriteRange', truncate: 'fsTruncate', utimes: 'utimes', chmod: 'chmod',
    access: 'access', chown: 'chown', open: 'fsOpen', read: 'fsRead', write: 'fsWrite',
    close: 'fsClose', readdir: 'readdir', mkdir: 'mkdir', unlink: 'unlink', rmdir: 'rmdir',
    rename: 'rename', readlink: 'readlink', symlink: 'symlink', fsync: 'fsSync', revision: 'fsRevision',
    acquire: 'fsAcquire', list: 'fsList', realpath: 'fsRealpath', remove: 'fsRemove', copyFile: 'fsCopyFile', copyTree: 'fsCopyTree',
    fstat: 'fsFstat', dup: 'fsDup', seek: 'fsSeek', setStatus: 'fsSetStatus', readdirHandle: 'fsReaddirHandle',
    ftruncate: 'fsFtruncate', fchmod: 'fsFchmod', fchown: 'fsFchown', futimes: 'fsFutimes',
    appendOnce: 'fsAppend', acknowledgeAppend: 'fsAppendAck', writeBatch: 'writeBatch',
    writeStream: 'writeBatchStream', acquireExclusiveMutation: 'fsAcquireExclusiveMutation',
    releaseExclusiveMutation: 'fsReleaseExclusiveMutation',
};
/** Local facets retain the process-bound bridge and its synchronous capability. */
export function vfsSupervisor(fs) {
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
        fsCopyTree: (...args) => fs.copyTree(...args),
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
 * A workerd RPC hop hands bytes back as an ArrayBuffer; the boundary makes
 * them a Uint8Array again before the codec looks. An error needs no repair:
 * both ends run with `enhanced_error_serialization` (the host refuses to
 * compose without it, @nimbus-sh/platform composition.ts), so the `code` the
 * authority set arrives as its own property. A same-isolate supervisor
 * answers synchronously and is handed back as is: a guest that cannot park
 * reads the value straight off the import. What the stub returns is a
 * thenable of its own class, not a Promise, so the test is for `then` and the
 * result handed on is a real Promise.
 */
function pending(result) {
    // workerd's RPC promise is a callable proxy (pipelined calls), so its type is 'function'.
    return (typeof result === 'object' || typeof result === 'function') && result !== null
        && typeof result.then === 'function';
}
function hop(result) {
    return pending(result) ? Promise.resolve(result) : result;
}
function bytes(result) {
    return pending(result) ? Promise.resolve(result).then(asBytes) : asBytes(result);
}
function asBytes(value) {
    return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}
/** The calls node's shims make that the bridge does not name. */
const NODE_SHIM_RPC_METHODS = [
    'readFile', 'writeFileStat', 'lstat', 'exists', 'hasLegacySymlinkUnder', 'setUmask', 'fsAcquired',
    'fsStorageGrant', 'fsReadRangeUncached', 'fsReadBatch',
];
export const SUPERVISOR_ANSWERED_METHODS = [
    ...Object.values(FILESYSTEM_RPC_METHODS).filter((name) => name !== FILESYSTEM_RPC_METHODS.writeStream),
    ...NODE_SHIM_RPC_METHODS,
];
const ANSWERED = new Set(SUPERVISOR_ANSWERED_METHODS);
export function isSupervisorAnsweredMethod(name) {
    return typeof name === 'string' && ANSWERED.has(name);
}
/** The refusal `error` is, or undefined when it is not one (no string `code`) and must still throw. */
export function supervisorRefusal(error) {
    if (!(error instanceof Error) || typeof Reflect.get(error, 'code') !== 'string')
        return undefined;
    const properties = {};
    for (const key of Object.getOwnPropertyNames(error)) {
        if (key !== 'message' && key !== 'stack')
            properties[key] = Reflect.get(error, key);
    }
    return { name: error.name, message: error.message, properties };
}
/**
 * `call`'s outcome as `answer` resolves it: its value, or its refusal. A
 * failure without a code is thrown. SupervisorRPC.answer runs its method
 * through this, and so does any double of it.
 */
export async function supervisorAnswer(call) {
    try {
        return { value: await call() };
    }
    catch (error) {
        const refusal = supervisorRefusal(error);
        if (refusal === undefined)
            throw error;
        return { refusal };
    }
}
/** Standard constructors the receiver of a thrown error rebuilds it with; any other is an Error bearing its name. */
const STANDARD_ERRORS = {
    EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError,
};
/**
 * The error `refusal` was, as the facet received it when SupervisorRPC threw
 * it: a new error of the thrower's type, its message, its own properties, and
 * no stack of the thrower's (src/workerd/jsg/ser.c++, with
 * preserveStackInErrors off).
 */
export function supervisorRefusalError(refusal) {
    const Standard = Object.hasOwn(STANDARD_ERRORS, refusal.name) ? STANDARD_ERRORS[refusal.name] : undefined;
    const error = new (Standard ?? Error)(refusal.message);
    if (!Standard && refusal.name !== 'Error') {
        Object.defineProperty(error, 'name', { value: refusal.name, configurable: true, writable: true });
    }
    for (const [key, value] of Object.entries(refusal.properties)) {
        Object.defineProperty(error, key, { value, configurable: true, enumerable: true, writable: true });
    }
    return error;
}
/** Only an RPC stub has `answer` (it has every name); a same-isolate supervisor (vfsSupervisor) has none of it. */
function isAnsweringStub(supervisor) {
    return typeof Reflect.get(supervisor, 'answer') === 'function';
}
/**
 * `supervisor`, with its filesystem calls made through `answer` and each
 * refusal rethrown as the error it is; every other name is the stub's own.
 * A same-isolate supervisor is handed back as is: its refusals are thrown in
 * this isolate and cross nothing. The call's value is handed on and its
 * envelope released.
 */
export function answeringSupervisor(supervisor) {
    if (!isAnsweringStub(supervisor))
        return supervisor;
    const stub = supervisor;
    return new Proxy(supervisor, {
        get(target, name) {
            if (!isSupervisorAnsweredMethod(name))
                return Reflect.get(target, name);
            return async (...args) => {
                const answer = await stub.answer(name, args);
                try {
                    if ('refusal' in answer)
                        throw supervisorRefusalError(answer.refusal);
                    return answer.value;
                }
                finally {
                    disposeRpcResource(answer);
                }
            };
        },
    });
}
/**
 * Installs {@link answeringSupervisor} as `globalThis.__nimbusAnsweringSupervisor`,
 * for the facet bodies that are generated text and take it spliced in
 * (SUPERVISOR_ANSWERING_SRC).
 */
export function installAnsweringSupervisor() {
    Reflect.set(globalThis, '__nimbusAnsweringSupervisor', answeringSupervisor);
}
/**
 * Remote facets use the same typed supervisor RPC methods. A synchronous view
 * is a same-isolate capability: an RPC stub answers every property with a
 * callable, so it is never read from the stub, only carried by a local
 * supervisor whose view really is in this isolate. A remote supervisor's
 * refusals arrive as answers (answeringSupervisor).
 */
export function supervisorFilesystem(remote, local) {
    const supervisor = answeringSupervisor(remote);
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
        copyTree: (...args) => hop(supervisor.fsCopyTree(...args)),
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
        writeStream: (...args) => Promise.resolve(supervisor.writeBatchStream(...args)),
        // An iterable does not cross RPC. A program with a large file to write
        // sends it as a W7 stream (writeStream), which does.
        writeFileFrom: async (path) => {
            const name = typeof path === 'string' ? path : path.path;
            throw Object.assign(new Error(`ENOTSUP: a streamed whole-file write is a host operation, write '${name}' as a W7 stream`), { code: 'ENOTSUP' });
        },
        acquireExclusiveMutation: (...args) => hop(supervisor.fsAcquireExclusiveMutation(...args)),
        releaseExclusiveMutation: (...args) => hop(supervisor.fsReleaseExclusiveMutation(...args)),
    };
}
