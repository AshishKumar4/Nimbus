/**
 * The inline `node`'s realm: each run is a worker thread of its own.
 *
 * The program used to be evaluated with `new Function` in the host's realm,
 * so its globals and intrinsics were the host's: a program that rebound
 * `Array` or installed fake timers changed them for the host (in Kinu's CLI, a
 * rebound `globalThis.Array` broke the host's sqlite-vfs). A worker thread is
 * a realm and an event loop of its own, which ends when its program does, and
 * `terminate()` ends even a loop that never yields. A `vm` context is a realm
 * too, but every host object handed into it (the fs bridge, Buffer, the
 * http module) carries the host's prototypes, a sync loop in it cannot be
 * stopped, and a blocking read could only block the host's own thread.
 *
 * The guest (node-guest.ts) runs node.ts's runNodeProgram. What it reaches
 * outside its realm crosses here:
 *
 *   - synchronous calls (the filesystem `require` and `fs` read, fd 0, the
 *     session's ports): the guest posts the call on `calls` and waits on
 *     `wake` (Atomics.wait); this side answers on `calls` and wakes it, and
 *     the guest takes the answer with receiveMessageOnPort. Only answers
 *     travel guest-bound on `calls`, so nothing else can be taken for one.
 *     A call this side answers asynchronously (fd 0, read to its end) holds
 *     the guest exactly as a blocking read holds a Node program;
 *   - asynchronous traffic, on `events`: its output, the requests its loopback
 *     clients make, the requests this side forwards to its servers, its exit.
 *
 * The program shares its realm with the guest, so everything it sends is
 * untrusted: the ports reach the guest by its first message, never through
 * `workerData` a program can import, and this side answers only the calls it
 * names below, with arguments of their kind, and never lets a message, an
 * answer that cannot cross, or a failed request end the host.
 *
 * Bun and Node both carry node:worker_threads, SharedArrayBuffer and
 * Atomics.wait in workers; workerd does not, and its sessions run their own
 * `node` (worker hosted/commands.ts).
 */
import type { MessagePort } from 'node:worker_threads';
import type { RuntimeVfsDirEntry, RuntimeVfsStat } from '../../../../runtime/os-contracts.js';
import type { CommandContext } from '../types.js';
import type { Kernel, VirtualRequest } from '../../kernel/index.js';
import type { NodeFilesystem } from '../../node-compat/filesystem.js';
import type { NodeProgram } from './node.js';
/** The session services a run reaches: the kernel's ports and loopback, where the host has them. */
export type NodeRealmKernel = Pick<Kernel, 'portRegistry'> & Partial<Pick<Kernel, 'routeLoopback'>>;
/** The filesystem methods a call names: NodeFilesystem's, but its change listener. */
export type FsMethod = Exclude<keyof NodeFilesystem, 'onChange'>;
/** A synchronous call the guest makes. */
export type RealmCall = {
    readonly op: 'fs';
    readonly method: FsMethod;
    readonly args: readonly unknown[];
} | {
    readonly op: 'stdin';
} | {
    readonly op: 'listen';
    readonly port: number;
} | {
    readonly op: 'unlisten';
    readonly port: number;
} | {
    readonly op: 'watch';
    readonly on: boolean;
};
/** A call's answer: its value, or the error it threw, as data. */
export type RealmAnswer = {
    readonly value: unknown;
} | {
    readonly error: RealmError;
};
export interface RealmError {
    readonly name: string;
    readonly message: string;
    readonly properties: Readonly<Record<string, string | number | boolean | null>>;
}
/** A response, as data, either way across. */
export interface RealmResponse {
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly body: string;
}
/** What the guest posts on `events`. */
export type GuestEvent = {
    readonly type: 'output';
    readonly fd: 1 | 2;
    readonly data: string | Uint8Array;
} | {
    readonly type: 'fetch';
    readonly id: number;
    readonly port: number;
    readonly url: string;
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string | null;
} | {
    readonly type: 'served';
    readonly id: number;
    readonly response: RealmResponse | null;
} | {
    readonly type: 'exit';
    readonly code: number;
};
/** What this side posts on `events`. */
export type HostEvent = {
    readonly type: 'fetched';
    readonly id: number;
    readonly response: RealmResponse | null;
} | {
    readonly type: 'serve';
    readonly id: number;
    readonly port: number;
    readonly request: VirtualRequest;
} | {
    readonly type: 'changed';
};
/** The guest's first message: its program and its ports. */
export interface RealmStart {
    readonly program: NodeProgram;
    readonly calls: MessagePort;
    readonly events: MessagePort;
    /** One Int32: set to 1 and notified when an answer is on `calls`. */
    readonly wake: SharedArrayBuffer;
}
export declare function isRealmAnswer(value: unknown): value is RealmAnswer;
export declare function isGuestEvent(value: unknown): value is GuestEvent;
export declare function isHostEvent(value: unknown): value is HostEvent;
export declare function isRealmStart(value: unknown): value is RealmStart;
export declare function isStat(value: unknown): value is RuntimeVfsStat;
export declare function isDirEntries(value: unknown): value is RuntimeVfsDirEntry[];
/** An error as data: its class name, message and own primitive properties (code, syscall, path, errno, dest, detail). */
export declare function realmError(error: unknown): RealmError;
/**
 * The error `error` was: a VfsError as a VfsError (node-compat's fs tells a
 * filesystem refusal by its class, as `rm(..., { force: true })` of a missing
 * path does), a standard class as itself, else an Error bearing its name; with
 * its message and own properties.
 */
export declare function fromRealmError(error: RealmError): Error;
/** What a run's calls are answered from. */
export interface RealmServices {
    filesystem(): NodeFilesystem;
    /** fd 0, read to its end, once; empty after. */
    stdin(): Promise<Uint8Array>;
    listen(port: number): void;
    unlisten(port: number): void;
    watch(on: boolean): void;
}
/**
 * The answer to `call`, whatever the guest sent: the value of one of the calls
 * above, or the error it raised; an error, too, for a call none answers and
 * for a value that cannot cross to the guest. Never rejects.
 */
export declare function serveRealmCall(call: unknown, services: RealmServices): Promise<RealmAnswer>;
/**
 * Run `program` in a worker of its own, serving what it reaches from `ctx` and
 * `kernel`. Resolves with its exit code once its realm has ended: its event
 * loop ran empty, or the caller's abort (kill, Ctrl-C) terminated it.
 */
export declare function runNodeInRealm(program: NodeProgram, ctx: CommandContext, kernel: NodeRealmKernel | undefined): Promise<number>;
//# sourceMappingURL=node-realm.d.ts.map