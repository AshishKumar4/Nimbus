import type { RuntimeFsBridge, RuntimeSynchronousFs } from './os-contracts.js';
import type { ProcessFsSession } from '../_shared/process-fs-client.js';
import type { WasiSupervisorStub } from './wasi/types.js';
import { FILESYSTEM_ANSWERED_RPC_METHODS } from './filesystem-mirrors.generated.js';
import { type SupervisorRefusal } from './filesystem-methods.js';
export { FILESYSTEM_RPC_METHODS, vfsSupervisor } from './filesystem-mirrors.generated.js';
export type { FilesystemSupervisor } from './filesystem-methods.js';
/** The calls node's shims make that the bridge does not name. */
declare const NODE_SHIM_RPC_METHODS: readonly ['readFile', 'writeFileStat', 'lstat', 'exists', 'setUmask', 'fsAcquired', 'fsStorageGrant', 'fsReadRangeUncached', 'fsReadBatch', 'fsListTree', 'fsReadDirectories'];
/**
 * The SupervisorRPC methods `answer` runs: the filesystem surface, every
 * table entry but a streamed one (a stream does not travel inside
 * `answer`'s argument list), and the node shims' own calls. The worker checks
 * each is a method of its SupervisorRPC.
 */
export type SupervisorAnsweredMethod = typeof FILESYSTEM_ANSWERED_RPC_METHODS[number] | typeof NODE_SHIM_RPC_METHODS[number];
export declare const SUPERVISOR_ANSWERED_METHODS: readonly SupervisorAnsweredMethod[];
export declare function isSupervisorAnsweredMethod(name: unknown): name is SupervisorAnsweredMethod;
/** What `answer` resolves with: the call's own value, or the refusal it was. */
export type SupervisorAnswer = {
    readonly value: unknown;
} | {
    readonly refusal: SupervisorRefusal;
};
/** The refusal `error` is, or undefined when it is not one (no string `code`) and must still throw. */
export declare function supervisorRefusal(error: unknown): SupervisorRefusal | undefined;
/**
 * `call`'s outcome as `answer` resolves it: its value, or its refusal. A
 * failure without a code is thrown. SupervisorRPC.answer runs its method
 * through this, and so does any double of it.
 */
export declare function supervisorAnswer(call: () => unknown): Promise<SupervisorAnswer>;
/**
 * `supervisor`, with its filesystem calls made through `answer` and each
 * refusal rethrown as the error it is; every other name is the stub's own.
 * A same-isolate supervisor is handed back as is: its refusals are thrown in
 * this isolate and cross nothing. The call's value is handed on and its
 * envelope released.
 *
 * `live` is told of each filesystem call as it is made, with the call in
 * flight: a program's liveness counts it as work it waits on, whoever made
 * it, its own fs or the filesystem that answers for it (a store's fills,
 * listings and grants), until the session answers. A call that waits on the
 * session for as long as it likes is not told: a grant's recall poll (the
 * table's `waits`); stdin and a socket's poll are not filesystem calls.
 */
export declare function answeringSupervisor<T extends object>(supervisor: T, live?: (call: Promise<unknown>) => unknown): T;
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
 * refusals arrive as answers (answeringSupervisor), each call told to
 * `live` as it is made.
 */
export declare function supervisorFilesystem(remote: WasiSupervisorStub, local?: RuntimeSynchronousFs, live?: (call: Promise<unknown>) => unknown): RuntimeFsBridge;
/**
 * The session a process's filesystem client sends its waves to and takes its
 * grants from, over `stub`: waves on the stub, grants through `authority`
 * (supervisorFilesystem over the same stub). Each wave call is told to `live`
 * as it is made, as the authority tells its own.
 */
export declare function supervisorSession(stub: WasiSupervisorStub, authority: RuntimeFsBridge, live?: (call: Promise<unknown>) => unknown): ProcessFsSession;
//# sourceMappingURL=vfs-supervisor.d.ts.map