import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import type { RuntimeFsBridge, RuntimeSynchronousFs } from './os-contracts.js';
import type { WasiSupervisorStub } from './wasi/types.js';

/** Names on the existing supervisor RPC capability; this table owns no state. */
export const FILESYSTEM_RPC_METHODS = {
  stat: 'stat', readFile: 'readFileBytes', writeFile: 'writeFile', readRange: 'fsReadRange',
  writeRange: 'fsWriteRange', truncate: 'fsTruncate', utimes: 'utimes', chmod: 'chmod',
  access: 'access', chown: 'chown', open: 'fsOpen', read: 'fsRead', write: 'fsWrite',
  close: 'fsClose', readdir: 'readdir', mkdir: 'mkdir', unlink: 'unlink', rmdir: 'rmdir',
  rename: 'rename', readlink: 'readlink', linkLeadsTo: 'fsLinkLeadsTo', symlink: 'symlink', fsync: 'fsSync', revision: 'fsRevision',
  acquire: 'fsAcquire', list: 'fsList', realpath: 'fsRealpath', remove: 'fsRemove', copyFile: 'fsCopyFile', copyTree: 'fsCopyTree',
  fstat: 'fsFstat', dup: 'fsDup', seek: 'fsSeek', setStatus: 'fsSetStatus', readdirHandle: 'fsReaddirHandle',
  ftruncate: 'fsFtruncate', fchmod: 'fsFchmod', fchown: 'fsFchown', futimes: 'fsFutimes',
  appendOnce: 'fsAppend', acknowledgeAppend: 'fsAppendAck', writeBatch: 'writeBatch',
  writeStream: 'writeBatchStream', acquireExclusiveMutation: 'fsAcquireExclusiveMutation',
  releaseExclusiveMutation: 'fsReleaseExclusiveMutation',
} as const satisfies Record<Exclude<keyof RuntimeFsBridge, 'synchronous' | 'subscribe' | 'gateLaunch' | 'writeFileFrom'>, string>;

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
    fsLinkLeadsTo: (...args) => fs.linkLeadsTo(...args),
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
function pending(result: unknown): result is PromiseLike<unknown> {
  // workerd's RPC promise is a callable proxy (pipelined calls), so its type is 'function'.
  return (typeof result === 'object' || typeof result === 'function') && result !== null
    && typeof (result as PromiseLike<unknown>).then === 'function';
}
function hop<T>(result: Promise<T> | T): Promise<T> | T {
  return pending(result) ? Promise.resolve(result) : result;
}
function bytes<T extends Uint8Array | null>(result: Promise<T | ArrayBuffer> | T | ArrayBuffer): Promise<T | Uint8Array> | T | Uint8Array {
  return pending(result) ? Promise.resolve(result).then(asBytes) : asBytes(result);
}
function asBytes<T extends Uint8Array | null>(value: T | ArrayBuffer): T | Uint8Array {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

// ── Refusals as answers ─────────────────────────────────────────────────
//
// A filesystem call the host refuses (ENOENT, ENOTDIR, EEXIST: an error with a
// code) is an answer, as bytes are. Thrown from SupervisorRPC, it crossed the
// entrypoint as an exception, and the platform recorded every such invocation
// with outcome "exception" and "The Workers runtime canceled this request
// because it detected that your Worker's code had hung" although its caller
// was answered at once (Kinu, 2026-10-02: 6 of 6 refused stats; the answered
// ones "canceled"). So a facet calls the filesystem through SupervisorRPC's
// `answer(method, args)`, which returns a refusal as a value, and rethrows it
// here as the error the throw would have delivered. Anything without a code
// (a dropped connection, a bug) still throws.

type BridgeRpcMethod = typeof FILESYSTEM_RPC_METHODS[Method];

/** The calls node's shims make that the bridge does not name. */
const NODE_SHIM_RPC_METHODS = [
  'readFile', 'writeFileStat', 'lstat', 'exists', 'hasLegacySymlinkUnder', 'setUmask', 'fsAcquired',
  'fsStorageGrant', 'fsReadRangeUncached', 'fsReadBatch',
] as const;

/**
 * The SupervisorRPC methods `answer` runs: the filesystem surface, every
 * table entry above but the streamed write (a stream does not travel inside
 * `answer`'s argument list), and the node shims' own calls. The worker checks
 * each is a method of its SupervisorRPC.
 */
export type SupervisorAnsweredMethod =
  | Exclude<BridgeRpcMethod, typeof FILESYSTEM_RPC_METHODS.writeStream>
  | typeof NODE_SHIM_RPC_METHODS[number];

export const SUPERVISOR_ANSWERED_METHODS: readonly SupervisorAnsweredMethod[] = [
  ...Object.values(FILESYSTEM_RPC_METHODS).filter(
    (name): name is Exclude<BridgeRpcMethod, typeof FILESYSTEM_RPC_METHODS.writeStream> => name !== FILESYSTEM_RPC_METHODS.writeStream,
  ),
  ...NODE_SHIM_RPC_METHODS,
];

const ANSWERED = new Set<string>(SUPERVISOR_ANSWERED_METHODS);

export function isSupervisorAnsweredMethod(name: unknown): name is SupervisorAnsweredMethod {
  return typeof name === 'string' && ANSWERED.has(name);
}

/**
 * A refusal as it crosses the hop: what workerd's enhanced_error_serialization
 * carries of a thrown error, as data. `properties` are the error's own ones
 * but `message` and `stack`: `code`, `errno`, `syscall`, `path`, `dest`,
 * `detail`, whatever the host set (`name` too, when it is its own). An error
 * among them (a `cause`) is in `errors`, as data of the same shape: inside
 * a returned value it would cross as a structured clone, which keeps only
 * its message.
 */
export interface SupervisorRefusal {
  readonly name: string;
  readonly message: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly errors: Readonly<Record<string, SupervisorRefusal>>;
}

/** What `answer` resolves with: the call's own value, or the refusal it was. */
export type SupervisorAnswer = { readonly value: unknown } | { readonly refusal: SupervisorRefusal };

/** The refusal `error` is, or undefined when it is not one (no string `code`) and must still throw. */
export function supervisorRefusal(error: unknown): SupervisorRefusal | undefined {
  if (!(error instanceof Error) || typeof Reflect.get(error, 'code') !== 'string') return undefined;
  return errorData(error);
}

function errorData(error: Error): SupervisorRefusal {
  const properties: Record<string, unknown> = {};
  const errors: Record<string, SupervisorRefusal> = {};
  for (const key of Object.getOwnPropertyNames(error)) {
    if (key === 'message' || key === 'stack') continue;
    const value: unknown = Reflect.get(error, key);
    if (value instanceof Error) errors[key] = errorData(value);
    else properties[key] = value;
  }
  return { name: error.name, message: error.message, properties, errors };
}

/**
 * `call`'s outcome as `answer` resolves it: its value, or its refusal. A
 * failure without a code is thrown. SupervisorRPC.answer runs its method
 * through this, and so does any double of it.
 */
export async function supervisorAnswer(call: () => unknown): Promise<SupervisorAnswer> {
  try {
    return { value: await call() };
  } catch (error) {
    const refusal = supervisorRefusal(error);
    if (refusal === undefined) throw error;
    return { refusal };
  }
}

/** Standard constructors the receiver of a thrown error rebuilds it with; any other is an Error bearing its name. */
const STANDARD_ERRORS: Readonly<Record<string, ErrorConstructor>> = {
  EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError,
};

/**
 * The error `refusal` was, as the facet received it when SupervisorRPC threw
 * it: a new error of the thrower's type, its message, its own properties, and
 * no stack of the thrower's (src/workerd/jsg/ser.c++, with
 * preserveStackInErrors off).
 */
export function supervisorRefusalError(refusal: SupervisorRefusal): Error {
  const Standard = Object.hasOwn(STANDARD_ERRORS, refusal.name) ? STANDARD_ERRORS[refusal.name] : undefined;
  const error = new (Standard ?? Error)(refusal.message);
  if (!Standard && refusal.name !== 'Error') {
    Object.defineProperty(error, 'name', { value: refusal.name, configurable: true, writable: true });
  }
  for (const [key, value] of Object.entries(refusal.properties)) {
    Object.defineProperty(error, key, { value, configurable: true, enumerable: true, writable: true });
  }
  for (const [key, value] of Object.entries(refusal.errors)) {
    Object.defineProperty(error, key, { value: supervisorRefusalError(value), configurable: true, enumerable: true, writable: true });
  }
  return error;
}

interface AnsweringStub {
  answer(method: SupervisorAnsweredMethod, args: unknown[]): Promise<SupervisorAnswer>;
}

/** Only an RPC stub has `answer` (it has every name); a same-isolate supervisor (vfsSupervisor) has none of it. */
function isAnsweringStub(supervisor: object): supervisor is AnsweringStub {
  return typeof Reflect.get(supervisor, 'answer') === 'function';
}

/**
 * `supervisor`, with its filesystem calls made through `answer` and each
 * refusal rethrown as the error it is; every other name is the stub's own.
 * A same-isolate supervisor is handed back as is: its refusals are thrown in
 * this isolate and cross nothing. The call's value is handed on and its
 * envelope released.
 */
export function answeringSupervisor<T extends object>(supervisor: T): T {
  if (!isAnsweringStub(supervisor)) return supervisor;
  const stub = supervisor;
  return new Proxy(supervisor, {
    get(target, name) {
      if (!isSupervisorAnsweredMethod(name)) return Reflect.get(target, name);
      return async (...args: unknown[]) => {
        const answer = await stub.answer(name, args);
        try {
          if ('refusal' in answer) throw supervisorRefusalError(answer.refusal);
          return answer.value;
        } finally {
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
export function installAnsweringSupervisor(): void {
  Reflect.set(globalThis, '__nimbusAnsweringSupervisor', answeringSupervisor);
}

/**
 * Remote facets use the same typed supervisor RPC methods. A synchronous view
 * is a same-isolate capability: an RPC stub answers every property with a
 * callable, so it is never read from the stub, only carried by a local
 * supervisor whose view really is in this isolate. A remote supervisor's
 * refusals arrive as answers (answeringSupervisor).
 */
export function supervisorFilesystem(remote: WasiSupervisorStub, local?: RuntimeSynchronousFs): RuntimeFsBridge {
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
    linkLeadsTo: (...args) => hop(supervisor.fsLinkLeadsTo(...args)),
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

