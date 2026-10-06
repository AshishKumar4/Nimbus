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

/** The bridge methods a supervisor answers: every one but the capabilities that stay in their isolate. */
type BridgeMethod = Exclude<keyof RuntimeFsBridge, 'synchronous' | 'subscribe' | 'gateLaunch' | 'writeFileFrom'>;

export const FILESYSTEM_METHODS = {
  stat: { rpc: 'stat', answer: 'value' },
  readFile: { rpc: 'readFileBytes', answer: 'bytes' },
  writeFile: { rpc: 'writeFile', answer: 'value' },
  readRange: { rpc: 'fsReadRange', answer: 'bytes' },
  writeRange: { rpc: 'fsWriteRange', answer: 'value' },
  truncate: { rpc: 'fsTruncate', answer: 'value' },
  utimes: { rpc: 'utimes', answer: 'value' },
  chmod: { rpc: 'chmod', answer: 'value' },
  access: { rpc: 'access', answer: 'value' },
  chown: { rpc: 'chown', answer: 'value' },
  open: { rpc: 'fsOpen', answer: 'value' },
  read: { rpc: 'fsRead', answer: 'bytes' },
  write: { rpc: 'fsWrite', answer: 'value' },
  close: { rpc: 'fsClose', answer: 'value' },
  readdir: { rpc: 'readdir', answer: 'value' },
  mkdir: { rpc: 'mkdir', answer: 'value' },
  unlink: { rpc: 'unlink', answer: 'value' },
  rmdir: { rpc: 'rmdir', answer: 'value' },
  rename: { rpc: 'rename', answer: 'value' },
  readlink: { rpc: 'readlink', answer: 'value' },
  linkLeadsTo: { rpc: 'fsLinkLeadsTo', answer: 'value' },
  symlink: { rpc: 'symlink', answer: 'value' },
  fsync: { rpc: 'fsSync', answer: 'value' },
  revision: { rpc: 'fsRevision', answer: 'value' },
  acquire: { rpc: 'fsAcquire', answer: 'value' },
  list: { rpc: 'fsList', answer: 'value' },
  realpath: { rpc: 'fsRealpath', answer: 'value' },
  remove: { rpc: 'fsRemove', answer: 'value' },
  copyFile: { rpc: 'fsCopyFile', answer: 'value' },
  copyTree: { rpc: 'fsCopyTree', answer: 'value' },
  fstat: { rpc: 'fsFstat', answer: 'value' },
  dup: { rpc: 'fsDup', answer: 'value' },
  seek: { rpc: 'fsSeek', answer: 'value' },
  setStatus: { rpc: 'fsSetStatus', answer: 'value' },
  readdirHandle: { rpc: 'fsReaddirHandle', answer: 'value' },
  ftruncate: { rpc: 'fsFtruncate', answer: 'value' },
  fchmod: { rpc: 'fsFchmod', answer: 'value' },
  fchown: { rpc: 'fsFchown', answer: 'value' },
  futimes: { rpc: 'fsFutimes', answer: 'value' },
  appendOnce: { rpc: 'fsAppend', answer: 'value' },
  acknowledgeAppend: { rpc: 'fsAppendAck', answer: 'value' },
  writeBatch: { rpc: 'writeBatch', answer: 'value' },
  writeStream: { rpc: 'writeBatchStream', answer: 'stream' },
  acquireExclusiveMutation: { rpc: 'fsAcquireExclusiveMutation', answer: 'value' },
  releaseExclusiveMutation: { rpc: 'fsReleaseExclusiveMutation', answer: 'value' },
  awaitRecall: { rpc: 'fsAwaitRecall', answer: 'value' },
  recalled: { rpc: 'fsRecalled', answer: 'value' },
} as const satisfies Record<BridgeMethod, { readonly rpc: string; readonly answer: FilesystemAnswer }>;

export type FilesystemMethod = keyof typeof FILESYSTEM_METHODS;

/** The supervisor RPC capability's filesystem: each bridge method under its RPC name, with its type. */
export type FilesystemSupervisor = {
  [K in FilesystemMethod as typeof FILESYSTEM_METHODS[K]['rpc']]: RuntimeFsBridge[K];
} & { readonly synchronous?: RuntimeSynchronousFs };

// ── Answers across a hop ─────────────────────────────────────────────────
//
// A workerd RPC hop hands bytes back as an ArrayBuffer; the boundary makes
// them a Uint8Array again before the codec looks. An error needs no repair:
// both ends run with `enhanced_error_serialization` (the host refuses to
// compose without it, @nimbus-sh/platform composition.ts), so the `code` the
// authority set arrives as its own property. A same-isolate supervisor
// answers synchronously and is handed back as is: a guest that cannot park
// reads the value straight off the import. What the stub returns is a
// thenable of its own class, not a Promise, so the test is for `then` and the
// result handed on is a real Promise.

function pending(result: unknown): result is PromiseLike<unknown> {
  // workerd's RPC promise is a callable proxy (pipelined calls), so its type is 'function'.
  return (typeof result === 'object' || typeof result === 'function') && result !== null
    && typeof (result as PromiseLike<unknown>).then === 'function';
}

/** A `value` answer. */
export function answerValue<T>(result: Promise<T> | T): Promise<T> | T {
  return pending(result) ? Promise.resolve(result) : result;
}

/** A `bytes` answer. */
export function answerBytes<T extends Uint8Array | null>(
  result: Promise<T | ArrayBuffer> | T | ArrayBuffer,
): Promise<T | Uint8Array> | T | Uint8Array {
  return pending(result) ? Promise.resolve(result).then(asBytes) : asBytes(result);
}

/** A `stream` answer: always a Promise. */
export function answerStream<T>(result: Promise<T> | T): Promise<T> {
  return Promise.resolve(result);
}

function asBytes<T extends Uint8Array | null>(value: T | ArrayBuffer): T | Uint8Array {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}
