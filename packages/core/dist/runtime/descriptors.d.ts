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
import type { RuntimeFileHandle, RuntimeOpenedFile, RuntimeOpenFlags, RuntimeVfsDirEntry, RuntimeVfsStat } from './os-contracts.js';
import type { FsTime } from '@nimbus-sh/platform/w7-frame.js';
/** The engine's description of a file on SQLite (SqliteVFS.openDescription): every answer at once. */
export type EngineDescription = VfsOpenDescription & {
    readonly mounted?: undefined;
    readonly awaits?: undefined;
};
/**
 * Who may act through a binding now: throws when it may not (EBADF once its
 * binding has ended or its scope closed; its caller's abort reason once that
 * aborts). Asked right before a backend is, after every await: by the
 * descriptor table (Descriptors) for each description's call, by the
 * namespace (CompositeVFS.scoped) for each of its calls, by the engine's
 * bridge for each synchronous one.
 */
export type Authority = () => void;
/**
 * A mounted file's description (vfs/mounted-description.ts): its answers
 * await where its mount does (`awaits`), and its stat is the mount's, which
 * never moves the SQLite clock.
 */
export interface MountedFileDescription {
    readonly mounted: true;
    /** Its operations are an asynchronous mount's: only a caller that can wait reaches them. */
    readonly awaits: boolean;
    /** When it was opened, among every description: a process's held writes on one file apply in this order (VFS-PF-001). */
    readonly order: number;
    readonly ino: number;
    path(): string;
    /** Which file it is (HeldFile.key): what its held writes overlay. */
    key(): string;
    /** `admit`, on each: the current operation's own admission (its Authority among it), run right before its backend is asked. */
    stat(admit?: () => void): Awaitable<RuntimeVfsStat>;
    read(offset: number, length: number, admit?: () => void): Awaitable<Uint8Array>;
    write(offset: number, bytes: Uint8Array, admit?: () => void): Awaitable<number>;
    /** An O_APPEND write: at the end of the file as it is then; answers that end after it. */
    append(bytes: Uint8Array, admit?: () => void): Awaitable<number>;
    truncate(size: number, admit?: () => void): Awaitable<void>;
    readdir(admit?: () => void): Awaitable<RuntimeVfsDirEntry[]>;
    chmod(mode: number, admit?: () => void): Awaitable<void>;
    chown(uid: number | null, gid: number | null, admit?: () => void): Awaitable<void>;
    utimes(atime: FsTime, mtime: FsTime, admit?: () => void): Awaitable<void>;
    /** Writes what it holds; throws what that, or an earlier settle of it, failed with. */
    flush(admit?: () => void): Awaitable<void>;
    /** Writes what it holds, unasked (settleHeld): a failure is kept for its next fsync or close. */
    settle(): void;
    close(admit?: () => void): Awaitable<void>;
    /** Closes its file without writing what it holds (a killed process's): those bytes are lost. */
    discard(): Awaitable<void>;
    /**
     * A description whose mount cannot write in place holds its writes until a
     * flush (fsync, the last close, the process's release, or a cut of its
     * file the process makes, settleHeld): `pendingBytes` is what a
     * process killed now would lose, and `applyPending` lays them over `file`,
     * as the flush will.
     */
    pendingBytes(): number;
    applyPending(file: Uint8Array): Uint8Array;
}
/** An open file description: what a process's descriptors (dups included) share. */
export type Description = EngineDescription | MountedFileDescription;
interface Opened {
    handle: RuntimeFileHandle;
    node: Description;
    refs: number;
}
export interface DescriptorScope {
    nextId: number;
    handles: Map<number, Opened>;
    /** The descriptions that hold writes now (a mount that cannot write in place): settled before the process changes anything else. */
    held: Set<MountedFileDescription>;
    /** The process's open descriptions its waves name (W7Call description), by the id it chose: descriptors of its own. */
    waveDescriptions: Map<string, number>;
    closed: boolean;
    /**
     * Aborted when the scope closes; cancels in-flight stream commits. Made by
     * the first that asks for it (scopeSignal): a scope nothing streamed on
     * makes none, and its close aborts nothing.
     */
    abort: AbortController | null;
    subscriptions: Set<() => void>;
    /** The exclusive leases the process took itself (not delegations), by owner: each one's release, among the subscriptions. */
    leases: Map<string, () => void>;
}
/** An open's flags as its descriptor keeps them: neither access asked is O_RDONLY. */
export declare function openFlags(flags: RuntimeOpenFlags): RuntimeFileHandle['flags'];
/** A description on an asynchronous mount, asked of a caller that cannot wait: its mount's refusal (isAsyncMountRefusal). */
export declare function awaitsRefusal(path: string): Error;
export declare function createDescriptorScope(): DescriptorScope;
/** What acts through `scope` with no binding of its own: anything, while the scope is open (EBADF once closed). */
export declare function scopeAccess(scope: DescriptorScope): {
    authority: Authority;
    owned: Authority;
};
/** The signal `scope`'s close aborts, made on first ask: already aborted once it has closed. */
export declare function scopeSignal(scope: DescriptorScope): AbortSignal;
/** `scope` closes: what asked for its signal hears of it. */
export declare function closeScopeSignal(scope: DescriptorScope): void;
/**
 * This process's held writes on the file `key` names, written, in open
 * order: before the process cuts that file (a truncate, an O_TRUNC open, a
 * whole-file write), so the cut is ordered after them, as the page cache
 * orders them (VFS-PF-001), and nothing brings back what it cut. A
 * description holds writes only where its mount answers at once, so this is
 * done in the caller's turn. One that fails keeps its failure for its next
 * fsync or close, and the cut goes on.
 */
export declare function settleHeld(scope: DescriptorScope, key: string | null): void;
/** settleHeld of the file `file` finds (a path's, CompositeVFS.pin), looked up only while the process holds writes; a lookup that fails settles nothing (the cut's own lookup says why). */
export declare function settleHeldAt(scope: DescriptorScope, file: () => Awaitable<{
    key(): Awaitable<string | null>;
}>): Awaitable<void>;
/**
 * Closes every description `scope` holds, each whatever another's flush
 * answers, and empties it at once. The closes that failed (lastClose's
 * errors) are answered once every one has (an awaiting description's backend
 * close awaits), for the caller to report once the rest of its teardown is
 * done (reportLost): a teardown that stopped at the first one would keep the
 * scope, and everything it revokes, open.
 */
export declare function closeDescriptions(scope: DescriptorScope): Awaitable<unknown[]>;
/** Reports closeDescriptions' failures: the one, or EIO over them all. */
export declare function reportLost(lost: readonly unknown[]): void;
/** A file as a path read finds it (PinnedName), or as a description holds it (HeldFile): which file, and its content. */
interface Viewed {
    key(): Awaitable<string | null>;
    readAll(): Awaitable<Uint8Array>;
}
/**
 * A mounted file as this process sees it while it holds writes to it
 * (VFS-PF-001 viewAs, page-cache semantics): `file`'s content with each of
 * this process's descriptions of that same file (HeldFile.key) applied, in
 * open order. Undefined when it holds none for it: then the file's own
 * content is the answer. Another process's held writes are never in it, nor
 * a file that only shares its name. `file` is asked only once some
 * description holds writes.
 */
export declare function processView(scope: DescriptorScope, file: () => Awaitable<Viewed>): Awaitable<Uint8Array | undefined>;
/** The descriptor operations, over a scope: answered in the caller's turn unless the description awaits. */
export declare class Descriptors {
    private readonly scope;
    /** The SQLite clock: the revision an fstat of a description on SQLite reports. */
    private readonly clock;
    /**
     * Its binding's: asked as each call reaches its description, and passed
     * to a mount's description to ask right before the mount is.
     */
    private readonly authority;
    /**
     * Its binding's own standing, its caller's abort aside: what a close (and
     * the table's own bookkeeping, dup) asks, so a caller that gave up still
     * closes what it opened, and an ended binding closes nothing.
     */
    private readonly owned;
    /** A synchronous face's: a description that awaits refuses its operations (awaitsRefusal), as its mount does; every other answers at once. */
    private readonly synchronous;
    constructor(scope: DescriptorScope, 
    /** The SQLite clock: the revision an fstat of a description on SQLite reports. */
    clock: () => number, 
    /**
     * Its binding's: asked as each call reaches its description, and passed
     * to a mount's description to ask right before the mount is.
     */
    authority: Authority, 
    /**
     * Its binding's own standing, its caller's abort aside: what a close (and
     * the table's own bookkeeping, dup) asks, so a caller that gave up still
     * closes what it opened, and an ended binding closes nothing.
     */
    owned: Authority, 
    /** A synchronous face's: a description that awaits refuses its operations (awaitsRefusal), as its mount does; every other answers at once. */
    synchronous?: boolean);
    /** A descriptor for `node`, new, at offset 0, opened at `path` (the description's own name for its file unless the opener has it). */
    issue(node: Description, flags: RuntimeFileHandle['flags'], path?: string): RuntimeFileHandle;
    /**
     * issue's descriptor as an open answers it: with its file's stat, as fstat
     * answers it, its revision `revision` where the open went by a name (the
     * name's).
     */
    open(node: Description, flags: RuntimeFileHandle['flags'], path?: string, revision?: number): Awaitable<RuntimeOpenedFile>;
    /** The description `id` names, to answer from (EBADF when none, or once the scope is closed). */
    description(id: number): Description;
    private opened;
    /** Descriptor `id`, for an operation that answers: refused on a synchronous face where its description awaits. */
    private answering;
    read(id: number, offset: number | null, length: number): Awaitable<Uint8Array>;
    write(id: number, offset: number | null, bytes: Uint8Array): Awaitable<number>;
    private writeAt;
    /** The last close of a description answers what it failed with (lastClose); an earlier one closes only the descriptor. */
    close(id: number): Awaitable<void>;
    /**
     * Writes what the description's file has held: a buffered mount handle's
     * writes, the appends SqliteVFS holds (appendThrough). Any other write was
     * in the store before its call returned.
     */
    fsync(id?: number): Awaitable<void>;
    /** The absolute path a descriptor was opened at. */
    path(id: number): string;
    /** Whether descriptor `id`'s description is a mount's (its path its own name for it, not a SQLite name), however it answers. */
    mounted(id: number): boolean;
    /** The name descriptor `id` was opened by: what its errors name, its file having none now perhaps. */
    openedAs(id: number): string;
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
    fchown(id: number, uid: number | null, gid: number | null): Awaitable<void>;
    futimes(id: number, atime: FsTime, mtime: FsTime): Awaitable<void>;
}
export {};
//# sourceMappingURL=descriptors.d.ts.map