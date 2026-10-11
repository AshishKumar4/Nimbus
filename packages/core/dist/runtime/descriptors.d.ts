/**
 * A process's open file descriptions and the descriptors that name them:
 * one numbering per process (DescriptorScope), shared by its synchronous
 * and asynchronous faces, whatever filesystem each description is on. A
 * description on SQLite is the engine's (SqliteVFS.openDescription); one on
 * a mount is the namespace's (vfs/mounted-description.ts), and answers by
 * awaiting when its mount does (`awaits`): the synchronous face refuses
 * that one as it refuses its mount, before anything is done.
 */
import { type Awaitable } from '../vfs/vfs.js';
import type { VfsOpenDescription } from '../vfs/sqlite-vfs.js';
import type { RuntimeFileHandle, RuntimeOpenFlags, RuntimeVfsDirEntry, RuntimeVfsStat } from './os-contracts.js';
type Answering<F> = F extends (...args: infer A) => infer R ? (...args: A) => Awaitable<R> : F;
/** An open file description: what a process's descriptors (dups included) share. Its name is known at once. */
export type Description = {
    [K in Exclude<keyof VfsOpenDescription, 'path'>]: Answering<VfsOpenDescription[K]>;
} & {
    path(): string;
    /** Its operations are an asynchronous mount's: only a caller that can wait reaches them. */
    readonly awaits?: true;
    /** A mounted file's: its stat is the mount's, which never moves the SQLite clock. */
    readonly mounted?: true;
    /** An O_APPEND write: at the end of the file as it is then; answers that end after it. */
    append?(bytes: Uint8Array): Awaitable<number>;
    /**
     * A description whose mount cannot write in place holds its writes until a
     * flush (fsync, the last close, the process's release): `pendingBytes` is
     * what a process killed now would lose, and `applyPending` lays them over
     * `file`, as the flush will.
     */
    pendingBytes?(): number;
    applyPending?(file: Uint8Array): Uint8Array;
};
interface Opened {
    handle: RuntimeFileHandle;
    node: Description;
    refs: number;
}
export interface DescriptorScope {
    nextId: number;
    handles: Map<number, Opened>;
    /** The process's open descriptions its waves name (W7Call description), by the id it chose: descriptors of its own. */
    waveDescriptions: Map<string, number>;
    closed: boolean;
    /** Aborted when the scope closes; cancels in-flight stream commits. */
    abort: AbortController;
    subscriptions: Set<() => void>;
    /** The exclusive leases the process took itself (not delegations), by owner: each one's release, among the subscriptions. */
    leases: Map<string, () => void>;
}
/** An open's flags as its descriptor keeps them: neither access asked is O_RDONLY. */
export declare function openFlags(flags: RuntimeOpenFlags): RuntimeFileHandle['flags'];
/** A description on an asynchronous mount, asked of a caller that cannot wait: its mount's refusal (isAsyncMountRefusal). */
export declare function awaitsRefusal(path: string): Error;
export declare function createDescriptorScope(): DescriptorScope;
/**
 * Closes every description `scope` holds, each whatever another's flush
 * answers, and empties it. The flushes that failed (lastClose's errors) are
 * returned, for the caller to report once the rest of its teardown is done
 * (reportLost): a teardown that stopped at the first one would keep the
 * scope, and everything it revokes, open.
 */
export declare function closeDescriptions(scope: DescriptorScope): unknown[];
/** Reports closeDescriptions' failures: the one, or EIO over them all. */
export declare function reportLost(lost: readonly unknown[]): void;
/**
 * A mounted file as this process sees it while it holds buffered writes to
 * it (VFS-PF-001 viewAs, page-cache semantics): the mount's file with each
 * of this process's descriptions of it applied, in open order. Undefined
 * when it holds none pending: then the mount's own file is the answer.
 * Another process's pending writes are never in it.
 */
export declare function processView(scope: DescriptorScope, read: () => Uint8Array | null, name: string): Uint8Array | undefined;
/** The descriptor operations, over a scope: answered in the caller's turn unless the description awaits. */
export declare class Descriptors {
    private readonly scope;
    /** The SQLite clock: the revision an fstat of a description on SQLite reports. */
    private readonly clock;
    constructor(scope: DescriptorScope, 
    /** The SQLite clock: the revision an fstat of a description on SQLite reports. */
    clock: () => number);
    /** A descriptor for `node`, new, at `position`. */
    issue(node: Description, flags: RuntimeFileHandle['flags'], position?: number): RuntimeFileHandle;
    /** The description `id` names (EBADF when none, or once the scope is closed). */
    description(id: number): Description;
    private opened;
    read(id: number, offset: number | null, length: number): Awaitable<Uint8Array>;
    write(id: number, offset: number | null, bytes: Uint8Array): Awaitable<number>;
    close(id: number): void;
    /**
     * Writes what the description's file has held: a buffered mount handle's
     * writes, the appends SqliteVFS holds (appendThrough). Any other write was
     * in the store before its call returned.
     */
    fsync(id?: number): Awaitable<void>;
    /** The absolute path a descriptor was opened at. */
    path(id: number): string;
    fstat(id: number): Awaitable<RuntimeVfsStat>;
    dup(id: number): RuntimeFileHandle;
    seek(id: number, offset: number, whence: 'set' | 'current' | 'end'): Awaitable<number>;
    setStatus(id: number, status: {
        append?: boolean;
    }): void;
    readdir(id: number): Awaitable<RuntimeVfsDirEntry[]>;
    /** ftruncate(2) of a descriptor not open for writing is EINVAL, as Linux answers it. */
    ftruncate(id: number, size: number): Awaitable<void>;
    fchmod(id: number, mode: number): Awaitable<void>;
    fchown(id: number, uid: number, gid: number): Awaitable<void>;
    futimes(id: number, atime: number, mtime: number): Awaitable<void>;
}
export {};
//# sourceMappingURL=descriptors.d.ts.map