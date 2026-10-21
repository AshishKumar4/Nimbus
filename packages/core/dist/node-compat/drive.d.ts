import type { FilesFace, NodeFaces } from './faces.js';
/** A path a call names: as the face takes it (absolute), and as its caller gave it, which its errors name, as Node's do. */
export interface Named {
    readonly abs: string;
    readonly given: string;
}
/** One file call an operation waits for; its syscall and path name it in an EAGAIN. */
export interface Step {
    readonly syscall: string;
    readonly path: Named | undefined;
    later(files: FilesFace<'async'>): Promise<void>;
}
/** An operation: the steps it makes, and what it answers. */
export type Op<T> = Generator<Step, T, void>;
/** What a body's `yield*` of a step takes: its answer, now, or the step it waits for. */
export type Stepping<T> = Iterable<Step, T, void>;
/**
 * `call`, made on whichever face the driver has: the face's methods take
 * the same arguments and differ only in answering now or with a promise.
 * Answered now, it is called where it stands; answered later, its answer is
 * kept here and read back after the step.
 */
export declare function step<T>(syscall: string, path: Named | undefined, call: (files: FilesFace<'sync'> | FilesFace<'async'>) => T | Promise<T>, dest?: Named): Stepping<T>;
/** ENOSYS: the filesystem has no `syscall`. */
export declare function lacks(syscall: string, path?: string): Error;
/**
 * `op` as its `*Sync` form runs it (`name`, Node's name of that form). With
 * no synchronous face its first step throws EAGAIN, naming the step's
 * syscall and path, and the form that can wait; nothing has been called.
 */
export declare function runSync<T>(faces: NodeFaces, name: string, op: Op<T>): T;
/** `op` awaited over the asynchronous face, or answered now from the synchronous one when there is none. */
export declare function runAsync<T>(faces: NodeFaces, op: Op<T>): Promise<T>;
//# sourceMappingURL=drive.d.ts.map