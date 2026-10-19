/**
 * What a caller that cannot wait (ResidentFilesystem.synchronous) decides
 * where no subtree the process holds decides it (VFS-9 B stage 3, rev 5):
 * answered now from this process's view, logged as the operations it made,
 * and the session's to refuse.
 *
 * The log is the overlay. Every decision is a record in log order: a name
 * made, removed or moved, or an operation on an inode (write, append,
 * truncate, chmod, chown, utimes). What the process sees of a name or an
 * inode is its admitted baseline with its pending records folded over it
 * (inode-fold.ts). An answered record retires once a barrier begun after
 * its answer lands; a refused one leaves, and what it touched is folded
 * again from the baseline. A rename moves names, never records.
 *
 * One Inode per (dev, ino) this process has opened or changed here: every
 * descriptor's read, write, truncate, stat, seek, attribute change, reopen
 * and close goes through it. Its identity is checked against the row its
 * name leads to: a name that leads elsewhere leaves it what it retains, or
 * ESTALE, never another file's bytes or attributes. A descriptor that may
 * write is opened at the session as it was opened here, by a description of
 * its own, and writes by it.
 *
 * Every call plans what it will log and keep, judges all of it (refusals,
 * the client's synchronous cap on what it logs, the budget for what it
 * keeps), then commits: a refusal, or a call that cannot answer now, leaves
 * nothing. What is admitted is given back by the object that holds it.
 */
import type { RuntimeFileHandle, RuntimeOpenFlags, RuntimeVfsDirEntry } from '../os-contracts.js';
import type { ResidentEntry } from './resident-filesystem.js';
import type { W7Attrs } from '@nimbus-sh/platform/w7-frame.js';
import type { ProcessFsClient } from '../../_shared/process-fs-client.js';
import { type InodeOp, type InodeState } from './inode-fold.js';
/** What the provisional decisions read and log through: the holder's. */
export interface ProvisionalHost {
    readonly device: number;
    readonly cred: {
        uid: number;
        gid: number;
        groups: readonly number[];
    };
    /** The row at `key` this process's provisional decisions aside (a held subtree's included): undefined where the view does not know. */
    row(key: string): ResidentEntry | null | undefined;
    /** The listing of `key`, as `row` sees it. */
    children(key: string): RuntimeVfsDirEntry[] | undefined;
    /** The view's bytes of file `row` at `key`, where it holds them and they are the view's (DelegationHolder.bytes' last source). */
    content(key: string, row: ResidentEntry): Uint8Array | undefined;
    reserve(bytes: number): boolean;
    release(bytes: number): void;
    readonly client: ProcessFsClient;
    /** Log what a held subtree decided and has not logged yet: what is logged here comes after it. */
    drain(): void;
    /** What was logged here was answered: the view owes the session's version of it (a barrier). */
    sent(): void;
    /** Whether the process sees anything of its provisional decisions now: what reads by name and by number consult them only while it does. */
    active(on: boolean): void;
    /** Whether a held subtree holds `key`: its grant decides there, and its names wait for it. */
    held(key: string): boolean;
    /** Count a change at `key` toward taking a subtree there, as a decided one is: once it is made. */
    count(key: string): void;
    /** The process's live umask. */
    umask(): number;
    now(): number;
    /** The next descriptor id, from the holder's own range. */
    nextHandle(): number;
    /**
     * File (dev, ino), where a grant decides it alone (the holder's cell, no
     * Inode here): promoted, in one synchronous step, to an Inode of these
     * decisions (Provisional.adopt, then unhold), which it returns; undefined
     * where no grant holds it. The one way these decisions take a held file.
     */
    promote(dev: number, ino: number): Inode | undefined;
    /** File (dev, ino)'s Inode where a grant decides it alone (the holder's, outside the table): a borrow, to price a change before take promotes it. */
    heldFile(dev: number, ino: number): Inode | undefined;
    /** What the files a grant holds alone keep of the budget (their Inodes, outside the table). */
    heldCost(): number;
    /** Descriptor `handleId` where a grant holds its file alone (the holder's): a borrow, to judge and price a change before take promotes it. */
    heldHandle(handleId: number): Desc | undefined;
    /** The files a grant holds alone with a descriptor open, at or under `keys`: a borrow, as for heldFile. */
    heldOpen(keys: readonly string[]): readonly Inode[];
    /**
     * `work`, the commit of a change judged and admitted in full: nothing it
     * does is refused. The only place promote runs (§11).
     */
    commit<T>(work: () => T): T;
    /** The generation of a grant's decision at `key` (OwnNames.generation): undefined where none. */
    generation(key: string): number | undefined;
    /**
     * The view has what these decisions did at `key`, made over a grant's
     * decision there of `generation`: that decision answers no more, the
     * view's row does (OwnNames.settled); true where it did. One made since
     * is newer than the view's answer, and stays.
     */
    settled(key: string, generation: number | undefined): boolean;
    /**
     * A grant's decision of file `file` (by number) at `key`, made since these
     * decisions' records of it began (a move above it): newer than the view's
     * answer, it stays, and takes `file`'s size, mode, owner and times, what
     * their retired records made of it. The decision; undefined where `key`
     * has none of that file.
     */
    absorb(key: string, file: ResidentEntry): ResidentEntry | undefined;
}
/**
 * A file's content while a grant decides it (the holder's): its bytes here,
 * each change logged at the next decision, the flush or LINGER_MS, not
 * refused here. What the process's descriptors of the file read and write
 * while it is (Inode.cell).
 */
export interface HeldCell {
    bytes: Uint8Array;
    length: number;
    mode: number;
    /** Made here and not yet logged: its number, which its first logged write carries. */
    made?: number;
    /** The umask its mode was decided under, which its logged writeFile carries. */
    umask?: number;
    /**
     * How many of its bytes the log holds as they are now (a logged decision
     * of it), and the lowest offset written since: a file that only changed
     * past what was logged is logged from there, not whole.
     */
    logged?: number;
    changedFrom?: number;
    /**
     * Its name is gone (unlinked, or replaced by a rename) while descriptions
     * of it are open: they read and write its bytes, and no name is written
     * with them (POSIX: the file outlives its last name until its last close).
     * `detached` is its stat when it lost the name (nlink 0): what fstat of
     * those descriptions answers, never what a name leads to now.
     */
    detached?: ResidentEntry;
}
/** A file this process has open or changed: one per device and number, whatever decides its changes. */
export interface Inode {
    dev: number;
    ino: number;
    type: ResidentEntry['type'];
    /** The name it is reached by here (a rename here moves it). */
    key: string;
    /** The name it is reached by in the view, its retired renames included: where a replay of the pending ones starts it. */
    origin: string;
    /** The name the session last opened it by (an open's answer): where the view will have it, a peer's rename since included. */
    opened?: string;
    /** Merged into another (reconcile): every reference to it is to that one. */
    mergedInto?: Inode;
    /** Its row: the view's as last read while nothing of the process's is pending on it, or what this process made it. */
    row: ResidentEntry;
    /**
     * Its admitted baseline while records are pending on it: the view's row,
     * and its bytes where the view held them (null: not held), as they were
     * when the first was made, advanced over each answered in order.
     */
    base: InodeState | null;
    /** `base` with `records` folded over it: what the process sees. */
    state: InodeState | null;
    records: InodeRecord[];
    /** What `records` keep of the budget (recordCost each), kept as they come and go. */
    recordsCost: number;
    /** No name leads to it any more: its descriptors keep what it holds until the last closes. */
    unnamed: boolean;
    /** Made by this process and not yet numbered by the session (reconcile). */
    local: boolean;
    descs: number;
    /** An open description at the session whose descriptor closed while others of the file stay open, none of them with one: kept until the last closes (at most one), its anchor. */
    retained: string[];
    /** What it holds back of the budget for its pending opens' answers: an Inode another file may need (reconcile). */
    credit: number;
    /** The view's bytes of it at `revision` its descriptors last read: what they read once the view no longer has a name for it. */
    pin?: {
        readonly revision: number;
        readonly bytes: Uint8Array;
    };
    /** What it holds of the process's budget: cost(inode), its credit included, and never more but transiently. */
    reserved: number;
    /** While a grant decides it: its content, which every descriptor of it reads and writes. Its bytes are the grant's, not the budget's. */
    cell?: HeldCell;
    /**
     * Its content was decided under a grant now given back (Provisional.unhold):
     * the barriers begun when that grant's decisions were answered, Infinity
     * until they are. Its own content stands until a barrier begun after (retire).
     */
    heldAt?: number;
    /** The grant's decision of its name its records fold over (its baseline's row), by name and generation: settled once they retire. */
    over?: {
        readonly key: string;
        readonly generation: number;
    };
}
/** One of the process's operations on an inode, kept until the view has its outcome (retire). */
interface InodeRecord {
    /** Log order. */
    readonly id: number;
    /** Its change: a write the client folded into the same entry extends it (extended), as the session answers the entry once. */
    op: InodeOp;
    /** An extended write's bytes and their room, grown by doubling: op.data is the front of it. */
    room?: Uint8Array;
    /** The inode it is of: the one its op reached at the session, once an open's answer says which (reconcile). */
    owner: Inode;
    /** The description it was made through, where one was: what an open's answer moves with it. */
    readonly description?: string;
    answered: boolean;
    /** Barriers begun when it was answered: one begun after retires it. */
    answeredAt: number;
    /** Gone from its inode's records (refused, retired or moved): its answer says nothing more. */
    gone?: true;
}
/** A descriptor: of an Inode, with the rights, offset and session description of its open. */
export interface Desc {
    inode: Inode;
    read: boolean;
    write: boolean;
    append: boolean;
    position: number;
    path: string;
    /** Its open description at the session, where it may write: opened there as it was here. */
    description?: string;
    /** For a caller that waits for it: the session's answer to its open, which rejects with the open's refusal. */
    opening?: Promise<unknown>;
    /** Its last content change's record and the client's answer for its entry: a change folded into that entry extends the record. */
    lastRecord: InodeRecord | null;
    lastAnswer: Promise<unknown> | null;
}
export interface Provisional {
    /** What it keeps of the process's budget now, counted afresh from what it holds: what it has taken of it, where its accounting is right. */
    kept(): number;
    /** The Inode of file (dev, ino), where this process has one. */
    inode(dev: number, ino: number): Inode | undefined;
    /**
     * An Inode for a file a grant decides alone (`key` its name, `row` what it
     * is), outside the table, its cost reserved: undefined where the budget has
     * no room. The holder keeps it until it goes or is promoted (adopt).
     */
    shell(key: string, row: ResidentEntry): Inode | undefined;
    /** A shell's cost charged again as it is now (a rename changed its name): kept where the budget has room. */
    charge(inode: Inode): void;
    /**
     * `inode`, a shell, is these decisions' from now on, with its open
     * descriptions (`handles`: each fd's id and its description, a dup sharing
     * one), moved as they are: no copy. Then unhold makes its cell its content.
     */
    adopt(inode: Inode, handles: ReadonlyMap<number, Desc>): void;
    /** The descriptor `handleId`, where it is one of this process's. */
    descriptor(handleId: number): Desc | undefined;
    /** Every descriptor of `inode`, each open once (a dup shares its open). */
    descriptorsOf(inode: Inode): Desc[];
    /**
     * A rename a grant decided, `from` to `to`: every file of these decisions
     * reached beneath `from` (a descriptor's included) is reached at its name
     * beneath `to` from now on, the name the view will have it at too. The
     * holder moves the files a grant holds alone.
     */
    moved(from: string, to: string): void;
    /**
     * No grant decides `inode` any more: its cell's bytes are its content
     * from now on, known (Inode.heldAt: the session's once what was decided is
     * answered and a barrier begun after lands), `entry` what it is; its
     * descriptors read it here and write through their descriptions.
     */
    unhold(inode: Inode, entry: ResidentEntry): void;
    /** What was decided under `root` is answered (its grant given back): its files are the session's after the next barrier. */
    answeredHeld(root: string): void;
    /** Whether file (dev, ino)'s content and size are this process's here (a cell, its fold, or a name the view does not have it at yet), not what the view has at its name. */
    pending(dev: number, ino: number): boolean;
    /** The session descriptor of `handleId`'s own description, else its file's anchor. With `read`, only a description opened for reading. */
    sessionOf(handleId: number, access?: 'read'): number | undefined;
    /** Open description `description` was answered: `handle` is the session's descriptor of it. */
    anchored(description: string, handle: number | undefined, read: boolean): void;
    owns(handleId: number): boolean;
    /** Whether a decision of this process's at `key`, at the directory it is in, or at a name under it, is not yet the view's: a held subtree decides nothing there until it is. */
    touches(key: string): boolean;
    /** fcntl(F_SETFL) of a descriptor: O_APPEND is its writes' to keep. */
    setStatus(handleId: number, status: {
        append?: boolean;
    }): void;
    /** This process's provisional word on `key`: an entry, null (no name), or undefined (none). `row`: the host's row there (ProvisionalHost.row), where the caller has it. */
    entry(key: string, row?: ResidentEntry | null): ResidentEntry | null | undefined;
    children(key: string, base: RuntimeVfsDirEntry[] | undefined): RuntimeVfsDirEntry[] | undefined;
    /** An open of `key` (resolved; `row` what it names, null for nothing): a descriptor, undefined where it is not made here. */
    open(key: string, path: string, flags: RuntimeOpenFlags, row: ResidentEntry | null, awaited?: boolean): RuntimeFileHandle | undefined;
    /** A descriptor whose open the session refused (Desc.opening): gone, nothing of it logged. */
    abandon(handleId: number): void;
    /** A whole file written by name: its open, write and close, judged together. False where it is not made here. */
    writeFile(key: string, path: string, bytes: Uint8Array, row: ResidentEntry | null, umask: number | undefined): boolean;
    /** Undefined where its bytes are the store's and it does not hold them: inodeOf says what to fetch. */
    read(handleId: number, offset: number | null, length: number): Uint8Array | undefined;
    /** Logged as made: it needs none of the file's bytes (what it keeps is folded over them when they are held). */
    write(handleId: number, offset: number | null, bytes: Uint8Array): number;
    ftruncate(handleId: number, size: number): void;
    seek(handleId: number, offset: number, whence: 'set' | 'current' | 'end'): number;
    fstat(handleId: number): ResidentEntry;
    fsetattr(handleId: number, attrs: W7Attrs): void;
    close(handleId: number): void;
    dup(handleId: number): RuntimeFileHandle;
    reopen(handleId: number, flags: RuntimeOpenFlags): RuntimeFileHandle | undefined;
    /** What a descriptor's read needs fetched: the name its file is at and its row; undefined where no name leads to it. */
    inodeOf(handleId: number): {
        key: string;
        entry: ResidentEntry;
    } | undefined;
    keyOf(handleId: number): string;
    mkdir(key: string, path: string, mode: number, row: ResidentEntry | null | undefined, umask: number | undefined): boolean;
    unlink(key: string, path: string, row: ResidentEntry | null | undefined): boolean;
    rmdir(key: string, path: string, row: ResidentEntry | null | undefined): boolean;
    symlink(key: string, path: string, target: string, row: ResidentEntry | null | undefined): boolean;
    rename(from: string, to: string, path: string, source: ResidentEntry | null | undefined, target: ResidentEntry | null | undefined): boolean;
    setattr(key: string, path: string, attrs: W7Attrs, row: ResidentEntry | null | undefined): boolean;
    copyFile(to: string, path: string, source: ResidentEntry, bytes: Uint8Array | undefined, target: ResidentEntry | null, keepMode: boolean): boolean;
    /** The bytes of the file `entry` names, where this process's are its content. */
    content(entry: ResidentEntry): Uint8Array | undefined;
    barrierBegun(): number;
    /** A barrier that began as `begun` landed: what was answered before it, outside a held subtree, is the view's now. */
    retire(begun: number): void;
}
export declare function provisional(host: ProvisionalHost): Provisional;
export {};
//# sourceMappingURL=provisional.d.ts.map