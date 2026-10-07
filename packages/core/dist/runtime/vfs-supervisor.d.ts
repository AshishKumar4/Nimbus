import type { RuntimeFsBridge, RuntimeSynchronousFs } from './os-contracts.js';
import type { WasiSupervisorStub } from './wasi/types.js';
import { FILESYSTEM_ANSWERED_RPC_METHODS } from './filesystem-mirrors.generated.js';
export { FILESYSTEM_RPC_METHODS, vfsSupervisor } from './filesystem-mirrors.generated.js';
export type { FilesystemSupervisor } from './filesystem-methods.js';
/** The calls node's shims make that the bridge does not name. */
declare const NODE_SHIM_RPC_METHODS: readonly ["readFile", "writeFileStat", "lstat", "exists", "hasLegacySymlinkUnder", "setUmask", "fsAcquired", "fsStorageGrant", "fsReadRangeUncached", "fsReadBatch"];
/**
 * The SupervisorRPC methods `answer` runs: the filesystem surface, every
 * table entry but a streamed one (a stream does not travel inside
 * `answer`'s argument list), and the node shims' own calls. The worker checks
 * each is a method of its SupervisorRPC.
 */
export type SupervisorAnsweredMethod = typeof FILESYSTEM_ANSWERED_RPC_METHODS[number] | typeof NODE_SHIM_RPC_METHODS[number];
export declare const SUPERVISOR_ANSWERED_METHODS: readonly SupervisorAnsweredMethod[];
export declare function isSupervisorAnsweredMethod(name: unknown): name is SupervisorAnsweredMethod;
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
//# sourceMappingURL=vfs-supervisor.d.ts.map