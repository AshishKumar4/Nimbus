/**
 * The inline `node`'s realm: each run is a realm of its own (runtime/realm.ts).
 *
 * The program used to be evaluated with `new Function` in the host's realm,
 * so its globals and intrinsics were the host's: a program that rebound
 * `Array` or installed fake timers changed them for the host (in Kinu's CLI, a
 * rebound `globalThis.Array` broke the host's sqlite-vfs).
 *
 * The guest (node-guest.ts) runs node.ts's runNodeProgram. What it reaches
 * outside its realm crosses here:
 *
 *   - synchronous calls ({@link NodeCall}: the filesystem `require` and `fs`
 *     read, fd 0, the session's ports). A call this side answers
 *     asynchronously (fd 0, read to its end) holds the guest exactly as a
 *     blocking read holds a Node program;
 *   - events: its output, the requests its loopback clients make, the
 *     requests this side forwards to its servers, its exit.
 *
 * Everything the program sends is untrusted: this side answers only the calls
 * it names below, with arguments of their kind, and never lets a message, an
 * answer that cannot cross, or a failed request end the host.
 *
 * workerd has no worker threads; its sessions run their own `node` (worker
 * hosted/commands.ts).
 */
import type { RuntimeVfsDirEntry, RuntimeVfsStat } from '../../../../runtime/os-contracts.js';
import { type RealmOutcome } from '../../../../runtime/realm.js';
import type { CommandContext } from '../types.js';
import type { Kernel, VirtualRequest } from '../../kernel/index.js';
import type { NodeFilesystem } from '../../node-compat/filesystem.js';
import type { NodeProgram } from './node.js';
/** The session services a run reaches: the kernel's ports and loopback, where the host has them. */
export type NodeRealmKernel = Pick<Kernel, 'portRegistry'> & Partial<Pick<Kernel, 'routeLoopback' | 'network'>>;
/** The port a guest's request names when it is not for a port of the box: it leaves through the workspace's network. */
export declare const EXTERNAL_PORT = -1;
/** The filesystem methods a call names: NodeFilesystem's, but its change listener. */
export type FsMethod = Exclude<keyof NodeFilesystem, 'onChange'>;
/** A synchronous call the guest makes. */
export type NodeCall = {
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
/** A response, as data, either way across (bytes for a request that left the box). */
export interface RealmResponse {
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly body: string | Uint8Array;
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
    readonly body: string | Uint8Array | null;
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
/** What the realm starts with: the program, and whether its network goes through an egress. */
export interface NodeRealmPayload {
    readonly program: NodeProgram;
    /**
     * The workspace's network goes through its host's egress: every request
     * the program makes off the box crosses here ({@link EXTERNAL_PORT}) and
     * leaves through it; a WebSocket, which cannot cross, is refused by name.
     */
    readonly egress: boolean;
}
export declare function isGuestEvent(value: unknown): value is GuestEvent;
export declare function isHostEvent(value: unknown): value is HostEvent;
export declare function isNodeRealmPayload(value: unknown): value is NodeRealmPayload;
export declare function isStat(value: unknown): value is RuntimeVfsStat;
export declare function isDirEntries(value: unknown): value is RuntimeVfsDirEntry[];
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
export declare function serveRealmCall(call: unknown, services: RealmServices): Promise<RealmOutcome>;
/**
 * Run `program` in a realm of its own, serving what it reaches from `ctx` and
 * `kernel`. Resolves with its exit code once its realm has ended: its event
 * loop ran empty, or the caller's abort (kill, Ctrl-C) terminated it.
 */
export declare function runNodeInRealm(program: NodeProgram, ctx: CommandContext, kernel: NodeRealmKernel | undefined): Promise<number>;
//# sourceMappingURL=node-realm.d.ts.map