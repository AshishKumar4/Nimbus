/**
 * The inline `node`'s realm: each run is a realm of its own (runtime/realm.ts).
 *
 * The program used to be evaluated with `new Function` in the host's realm,
 * so its globals and intrinsics were the host's: a program that rebound
 * `Array` or installed fake timers changed them for the host (in Kinu's CLI, a
 * rebound `globalThis.Array` broke the host's sqlite-vfs).
 *
 * The guest (node-guest.ts) runs node-program.ts's runNodeProgram. What it
 * reaches outside its realm crosses here (its messages: node-realm-protocol.ts):
 *
 *   - synchronous calls ({@link NodeCall}: the filesystem `require` and `fs`
 *     read, fd 0, the session's ports). A call this side answers
 *     asynchronously (fd 0, read to its end) holds the guest exactly as a
 *     blocking read holds a Node program;
 *   - events: its output, the requests its loopback clients make, the
 *     requests this side forwards to its servers, its exit, and under an
 *     egress the requests it makes off the box, whose responses cross back
 *     as they arrive (runtime/realm-egress.ts).
 *
 * Everything the program sends is untrusted: this side answers only the calls
 * it names below, with arguments of their kind, and never lets a message, an
 * answer that cannot cross, or a failed request end the host.
 *
 * workerd has no worker threads; its sessions run their own `node` (worker
 * hosted/commands.ts).
 */
import { type RealmOutcome } from '../../../../runtime/realm.js';
import type { CommandContext } from '../types.js';
import type { Kernel } from '../../kernel/index.js';
import type { NodeFilesystem } from '../../node-compat/filesystem.js';
import type { NodeProgram } from './node-program.js';
import { type FdKind, type OutputFailure } from './node-realm-protocol.js';
/** The session services a run reaches: the kernel's ports and loopback, where the host has them. */
export type NodeRealmKernel = Pick<Kernel, 'portRegistry'> & Partial<Pick<Kernel, 'routeLoopback' | 'dns' | 'network'>>;
/** What a run's calls are answered from. */
export interface RealmServices {
    filesystem(): NodeFilesystem;
    /** fd 0, read to its end, once; empty after. */
    stdin(): Promise<Uint8Array>;
    /** What standard descriptor `fd` is. */
    fdKind(fd: number): FdKind;
    /** The terminal's raw mode, on or off. */
    setRawMode(on: boolean): void;
    listen(port: number): void;
    unlisten(port: number): void;
    /** Watch `path` as watch `id`, or stop it (null). */
    watch(id: number, path: string | null): void;
    /** umask(2): the mask the program creates with from now on. */
    setUmask(mask: number): void;
    /** Once writes up to number `upTo` are made: those after number `after` that failed (`round`'s settle-mark). */
    settle(round: number, after: number, upTo: number): Promise<readonly OutputFailure[]>;
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