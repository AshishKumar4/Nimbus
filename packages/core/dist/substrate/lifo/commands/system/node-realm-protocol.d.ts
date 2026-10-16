/**
 * The inline `node`'s realm protocol (node-realm.ts): what the guest
 * (node-guest.ts) and this side send each other, and the guards each narrows
 * what it receives with. The guest loads this and not the host's half.
 */
import type { RuntimeVfsDirEntry, RuntimeVfsStat } from '../../../../runtime/os-contracts.js';
import type { NodeFilesystem } from '../../node-compat/filesystem.js';
import type { OutputSource } from '../../node-compat/standard-streams.js';
import type { VfsEvent } from '../../../../vfs/events.js';
import { type EgressGuestEvent, type EgressHostEvent } from '../../../../runtime/realm-egress.js';
import type { NodeProgram } from './node-program.js';
import type { RealmError } from '../../../../runtime/realm.js';
import type { VirtualRequest } from '../../kernel/index.js';
/** The filesystem methods a call names: NodeFilesystem's, but its watch (a call of its own). */
export type FsMethod = Exclude<keyof NodeFilesystem, 'watch'>;
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
}
/** Watch `path` as watch `id` (NodeFilesystem.watch); a null path stops it. */
 | {
    readonly op: 'watch';
    readonly id: number;
    readonly path: string | null;
}
/** umask(2): the mask the program creates with from now on (its own copy: the shell's is not changed). */
 | {
    readonly op: 'umask';
    readonly mask: number;
}
/** Whether standard descriptor `fd` is the terminal, a pipe, or neither. */
 | {
    readonly op: 'fdKind';
    readonly fd: number;
}
/** The terminal's raw mode, on or off (tty.ReadStream.setRawMode). */
 | {
    readonly op: 'rawMode';
    readonly on: boolean;
}
/**
 * Answered once output writes up to number `upTo` are made, with those
 * after number `after` that failed (since `round`'s settle-mark): the
 * writes a program's 'beforeExit' listeners made in that round, made before
 * its loop is asked again, as Node's writes to a pipe or a file are.
 */
 | {
    readonly op: 'settle';
    readonly round: number;
    readonly after: number;
    readonly upTo: number;
};
/** What a standard descriptor is, as libuv tells a stream it can make from it. */
export type FdKind = 'terminal' | 'pipe' | 'other';
/**
 * A failed write: its number (`seq`, as the host numbers writes), its
 * descriptor, its error, and what made it (its source, and which of the
 * program's writers of `fd`: 0 is process.stdout or process.stderr, and its
 * console).
 */
export interface OutputFailure {
    readonly seq: number;
    readonly fd: 1 | 2;
    readonly code: string;
    readonly pipe: boolean;
    readonly source: OutputSource;
    readonly writer: number;
}
/** A response to a request that stayed on the box, as data, either way across. */
export interface RealmResponse {
    readonly status: number;
    /** Its reason phrase, when its server named one. */
    readonly statusText?: string;
    readonly headers: Record<string, string>;
    readonly body: string | Uint8Array;
}
/** What the guest posts on `events`. */
export type GuestEvent = 
/** An output write, through `source`: the host numbers them, both outputs together, in the order they come (a settle's numbers). */
{
    readonly type: 'output';
    readonly fd: 1 | 2;
    readonly source: OutputSource;
    readonly writer: number;
    readonly data: string | Uint8Array;
}
/** The program's loop ran empty, and it would hear of a failed write: tell it once writes up to number `upTo` are made (output-settled). */
 | {
    readonly type: 'settle';
    readonly upTo: number;
}
/**
 * The program's 'beforeExit' is about to be emitted (its round number
 * `round`, counting from 1) with writes up to number `after` posted: the
 * failures of those after it are the answer of the round's settle call,
 * and no output-failed of theirs is posted. Rounds are told apart by
 * number: two can start at the same write number.
 */
 | {
    readonly type: 'settle-mark';
    readonly round: number;
    readonly after: number;
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
}
/** Its status; `ended`, it ended itself (process.exit, a fatal error): a write that fails later is no one's. */
 | {
    readonly type: 'exit';
    readonly code: number;
    readonly ended: boolean;
}
/** The guest took a failure of output `fd`'s writer `writer` (output-failed), or the writer closed: whatever the program makes of its failures, they are the guest's. */
 | {
    readonly type: 'heard';
    readonly fd: 1 | 2;
    readonly writer: number;
}
/** fd 0's next piece, wanted as read `id` (process.stdin). */
 | {
    readonly type: 'stdin-read';
    readonly id: number;
}
/** Read `id` is withdrawn: what has not arrived stays on fd 0. */
 | {
    readonly type: 'stdin-cancel';
    readonly id: number;
} | EgressGuestEvent;
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
}
/** A change watch `id` was told. */
 | {
    readonly type: 'changed';
    readonly id: number;
    readonly event: VfsEvent;
}
/** A write failed: the stream's, its error; the console's, heard only by a listener on the stream, as Node's console ignores it. */
 | ({
    readonly type: 'output-failed';
} & OutputFailure)
/** Every output write up to number `seq` is made or failed (a failure told first): told once asked (settle). */
 | {
    readonly type: 'output-settled';
    readonly seq: number;
}
/** Read `id`'s answer, once: its piece of fd 0 (null at its end), its error, or that it was withdrawn before anything arrived. */
 | {
    readonly type: 'stdin';
    readonly id: number;
    readonly data: Uint8Array | null;
} | {
    readonly type: 'stdin';
    readonly id: number;
    readonly error: RealmError;
} | {
    readonly type: 'stdin';
    readonly id: number;
    readonly withdrawn: true;
} | EgressHostEvent;
/**
 * What the realm starts with: the program, the kernel's /etc/hosts its
 * dns.lookup answers from, and whether its network goes through an egress.
 */
export interface NodeRealmPayload {
    readonly program: NodeProgram;
    readonly hosts?: string;
    /**
     * The workspace's network goes through its host's egress: every request
     * the program makes off the box crosses here (`egress`) and leaves through
     * it; a WebSocket, which cannot cross, is refused by name.
     */
    readonly egress: boolean;
}
export declare const record: (value: unknown) => value is Record<string, unknown>;
export declare function isGuestEvent(value: unknown): value is GuestEvent;
export declare function isOutputFailures(value: unknown): value is readonly OutputFailure[];
export declare function isHostEvent(value: unknown): value is HostEvent;
export declare function isNodeRealmPayload(value: unknown): value is NodeRealmPayload;
export declare function isStat(value: unknown): value is RuntimeVfsStat;
export declare function isDirEntries(value: unknown): value is RuntimeVfsDirEntry[];
//# sourceMappingURL=node-realm-protocol.d.ts.map