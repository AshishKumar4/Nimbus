/**
 * The session calls a process's store makes, as the session declares them
 * (session/supervisor-calls.ts): each optional, as a supervisor may lack one
 * (a test's) and the store then does without it, and each answer awaited
 * whether or not it is a promise. What an answer holds crossed an RPC, so the
 * store reads it field by field.
 */
import type { ProcessSupervisor } from '../../session/process-supervisor.js';
type ResidentCall = 'fsAcquire' | 'fsList' | 'fsListTree' | 'fsReadBatch' | 'readdir' | 'readlink' | 'fsStorageGrant';
/** A session call as the store makes it: its own arguments, its answer whether or not it is a promise. */
type Answered<F> = F extends (...args: infer A) => Promise<infer R> ? (...args: A) => R | PromiseLike<R> : never;
export type ResidentSupervisor = {
    readonly [K in ResidentCall]?: Answered<ProcessSupervisor[K]>;
};
export {};
//# sourceMappingURL=supervisor.d.ts.map