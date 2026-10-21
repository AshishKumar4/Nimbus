import type { FilesFace, NodeFaces } from './faces.js';
/** One file call an operation makes: answered now, or later; its syscall and path name it in an EAGAIN. */
export interface Step {
    readonly syscall: string;
    readonly path: string | undefined;
    now(files: FilesFace<'sync'>): void;
    later(files: FilesFace<'async'>): Promise<void>;
}
/** An operation: the steps it makes, and what it answers. */
export type Op<T> = Generator<Step, T, void>;
/**
 * `call`, made on whichever face the driver has: the face's methods take
 * the same arguments and differ only in answering now or with a promise.
 * Its answer is kept here and read back after the step.
 */
export declare function step<T>(syscall: string, path: string | undefined, call: (files: FilesFace<'sync'> | FilesFace<'async'>) => T | Promise<T>): Op<T>;
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