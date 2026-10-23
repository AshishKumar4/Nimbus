/**
 * A WASI process as a delegation's holder (spike/delegation/MEMO.md, P4a):
 * inside the subtrees it holds, the process decides its creates, writes,
 * mkdirs, unlinks, renames and attribute changes itself, against what its
 * resident store knows and what it decided, with no round trip, and logs
 * them as calls into the process's filesystem client (process-fs-client.ts,
 * P4b), which takes the subtrees, numbers the log and sends it, in order:
 * at each point where what it wrote could be observed (a socket send, an
 * fsync, the end of its run) and when the session recalls a subtree.
 *
 * What it decides is the session's answer, kept exactly:
 *   - A subtree is held once the process has mutated in it often enough to
 *     be worth it (the client's policy): the deepest existing directory
 *     holding the name it changes, a bounded number of them. Never the
 *     whole filesystem, a home directory itself, or the session's stores
 *     (the session refuses those), and never a subtree with a default ACL
 *     in it (its inheritance is the session's to apply): there, the process
 *     writes through as before.
 *   - Refusals are the walk's own (resolve), and the cases decided here are
 *     the plain ones: a create where the parent is a writable directory, a
 *     mkdir, an unlink of a file or link, a rename of a file, or of a
 *     directory to a free name outside itself, within one held subtree. Any
 *     other mutation in a held subtree sends the log first and is the
 *     session's, as before.
 *   - A name made here is numbered from the grant's reserved inode range and
 *     keeps that number in the session; it is owned as the session makes a
 *     holder's names (the process's, a setgid directory's group), its mode
 *     the asked mode less the umask.
 *   - The log keeps program order: each decision is logged as it is made,
 *     and a file's bytes, which change write by write, are logged whole (its
 *     latest) before the next decision is, or at the flush.
 *
 * A recall is answered by a loop per grant on the host side of the process:
 * a guest that waits in a syscall lets it run; one computing does not
 * (the documented limit, answered by the session's recall timeout).
 */
import type { RuntimeFileHandle, RuntimeOpenFlags, RuntimeVfsDirEntry } from '../os-contracts.js';
import type { ResidentEntry } from './resident-filesystem.js';
import { type Provisional } from './provisional.js';
import type { W7Attrs } from '@nimbus-sh/platform/w7-frame.js';
import { type ProcessFsClient, type ProcessFsClientOptions, type ProcessFsJournal, type ProcessFsSession } from '../../_shared/process-fs-client.js';
import type { WaveTimers } from '@nimbus-sh/platform/wave-writer.js';
/** What the holder reads of the process's resident store (its own decisions aside). */
export interface HolderStore {
    readonly device: number;
    readonly cred: {
        uid: number;
        gid: number;
        groups: readonly number[];
    };
    /** As ResidentNamespace.entry: undefined when the store does not know. */
    entry(key: string): ResidentEntry | null | undefined;
    /** As ResidentNamespace.children. */
    children(key: string): RuntimeVfsDirEntry[] | undefined;
    /** As ResidentNamespace.content: the store's bytes of `key` at `revision`, where it holds them. */
    content?(key: string, revision: number): Uint8Array | undefined;
    /** As ResidentNamespace.reserve and release: what a provisional decision keeps takes of the process's budget (no grant reserved it). */
    reserve?(bytes: number): boolean;
    release?(bytes: number): void;
}
export interface HolderOptions {
    /** The session the process's filesystem client sends to and takes its grants from. */
    readonly session: ProcessFsSession;
    readonly store: HolderStore;
    /** Every engine key that is a home directory (`home/<name>`): never held itself. */
    readonly isHomeRoot?: (key: string) => boolean;
    /** Told when what the holder decided changed the namespace the store shows (the barrier is owed after a send). */
    readonly sent?: () => void;
    /** The clock files are stamped with, and its client runs on. */
    readonly now?: () => number;
    /** The timers its client lingers and retries on (ProcessFsClientOptions.timers). */
    readonly timers?: WaveTimers;
    /** Mutations in a subtree before it is taken (the client's GRANT_AFTER). */
    readonly grantAfter?: number;
    /** Inode numbers a first grant reserves (the client's GRANT_INOS). */
    readonly grantInos?: number;
    /** Where the client logs what it sends until the session answers: the process's own store, where it has one (process-fs-journal.ts). */
    readonly journal?: ProcessFsJournal;
    /**
     * Whether the caller deciding now cannot wait (ResidentFilesystem.synchronous):
     * what no held subtree decides is then its provisional decisions' (provisional.ts),
     * and a change is counted toward taking a subtree only once one makes it.
     */
    readonly cannotWait?: () => boolean;
    /**
     * The process's live umask: for what it makes provisionally (a held
     * subtree's grant carries the session's), and stamped by its client on
     * each call logged that makes a name and does not name one.
     */
    readonly umask?: () => number;
    /** Told of each change its client logs (ProcessFsClientOptions.logged). */
    readonly logged?: ProcessFsClientOptions['logged'];
}
/** The decisions the process made in a held subtree, not yet sent. */
export interface DelegationHolder {
    /** The process's filesystem client: what the holder decided is logged into it. */
    readonly client: ProcessFsClient;
    /** What a caller that cannot wait decides where no held subtree does: its descriptors are the holder's too (owns). */
    readonly provisional: Provisional;
    /** What the process decided is at `key`: an entry, null (removed), or undefined (nothing decided). */
    entry(key: string): ResidentEntry | null | undefined;
    /** What the process sees at `key`: what it decided (entry), else the store's; undefined where neither knows. */
    row(key: string): ResidentEntry | null | undefined;
    /** The names in `key`, as `base` lists them with what the process decided there. */
    children(key: string, base: RuntimeVfsDirEntry[] | undefined): RuntimeVfsDirEntry[] | undefined;
    /** The bytes of a file made or rewritten here. */
    content(entry: ResidentEntry): Uint8Array | undefined;
    /** Whether `handleId` is one of the holder's own descriptors. */
    owns(handleId: number): boolean;
    /**
     * Everything logged so far answered, what the session refused kept for the
     * next sync (flush) to report: what goes before a call to the session.
     */
    send(): Promise<void>;
    /** A refusal the session has made of what this process logged, thrown now (with its errno), not waiting for anything: what a close reports. */
    reportRecorded(): void;
    /**
     * The process is about to change a name or an access at or above `keys`
     * (anywhere, when absent) by a route not decided here (a call of the
     * session's, or a change by name the client logs): no grant decides a
     * file it holds open there from now on (Provisional.unhold), its
     * descriptions opened at the session first.
     */
    changing(keys?: readonly string[]): void;
    /** fcntl(F_SETFL) of one of the holder's descriptors: O_APPEND is its writes' to keep. */
    setStatus(handleId: number, status: {
        append?: boolean;
    }): void;
    /**
     * Decide an open that creates or empties a file at `key` (resolved, its
     * parent known): a descriptor of the holder's, or undefined when the
     * session is to decide it.
     */
    open(key: string, path: string, flags: RuntimeOpenFlags, initial?: number): RuntimeFileHandle | undefined;
    /**
     * A whole file written by name (an open of `flags`, a write and a close),
     * decided here as `open` decides: its revision, or undefined when the
     * session must write it. Its bytes' room is drawn before anything is
     * decided, so no name is made for bytes that do not fit.
     */
    writeFile(key: string, path: string, bytes: Uint8Array, flags: RuntimeOpenFlags): number | undefined;
    /** Undefined where its bytes are the store's and it does not hold them (a provisional descriptor's: Provisional.inodeOf). */
    read(handleId: number, offset: number | null, length: number): Uint8Array | undefined;
    write(handleId: number, offset: number | null, bytes: Uint8Array): number;
    seek(handleId: number, offset: number, whence: 'set' | 'current' | 'end'): number;
    ftruncate(handleId: number, size: number): void;
    /** Its file's attributes, by its identity: undefined where the view can say nothing of it now (Provisional.fstat). */
    fstat(handleId: number): ResidentEntry | undefined;
    close(handleId: number): void;
    /** The name a descriptor of the holder's writes, now. */
    keyOf(handleId: number): string;
    /** Another descriptor of the same open file (its position shared). */
    dup(handleId: number): RuntimeFileHandle;
    /**
     * A new open of the file a descriptor of the holder's is on (an open of
     * /proc/self/fd/N), its offset its own, when decided here: a file whose
     * bytes are here, opened without O_APPEND. Undefined when the session is
     * to decide it (by the file's identity, once what was decided is sent).
     */
    reopen(handleId: number, flags: {
        read?: boolean;
        write?: boolean;
        append?: boolean;
        create?: boolean;
        exclusive?: boolean;
        truncate?: boolean;
    }): RuntimeFileHandle | undefined;
    /**
     * Decide a copy of the file at `from` to `to` (both resolved): true when
     * decided here, its bytes `bytes` where they are not the holder's own
     * (what the store read of it under the grant). Its mode as the session's
     * copy leaves it: cp(1)'s (a new file the source's permission bits less
     * the umask, one there its own), or with `keepMode` copyfile's
     * (copyfileMode). Logged as the copy is made, through one description:
     * the destination opened (O_CREAT|O_TRUNC; with `keepMode` its fchmod,
     * part of the open, as libuv's copyfile makes it), the bytes written
     * through it, and its close.
     */
    copyFile(from: string, to: string, path: string, bytes: Uint8Array | undefined, keepMode: boolean): boolean;
    /**
     * Log every decided file's unlogged bytes now, into the process's own log
     * and with no session round trip: what its facet keeps of it when the
     * session ends it (a resident's settle, before its facet goes). The log is
     * the session's drain's from then on (ProcessFsClient.seal).
     */
    logHeld(): void;
    /** Decide a mkdir at `key`: true when decided here (and done), false when the session is to. */
    mkdir(key: string, path: string, mode: number, umask?: number): boolean;
    /** Decide an unlink of `key` (a file or link): true when decided here. */
    unlink(key: string, path: string): boolean;
    /** Decide a rename of `from` to `to` (both resolved): true when decided here. */
    rename(from: string, to: string, path: string): boolean;
    /** Decide an attribute change of `key`: true when decided here. */
    setattr(key: string, attrs: W7Attrs): boolean;
    /**
     * An attribute change of the file `handleId` opened (fchmod, fchown,
     * futimes): decided here where the file's grant decides it (or it lost its
     * name: it is this process's alone), its times resolved as it is decided;
     * true then. False where the provisional decisions logged it, through its
     * description: the session's to apply (a caller that may wait waits for it).
     */
    fsetattr(handleId: number, change: W7Attrs): boolean;
    /**
     * The session changed `key`'s attributes itself, after everything the
     * holder had was sent (one it holds but did not decide): what was decided
     * of it is the session's now, and the store answers it after its barrier.
     */
    undecided(key: string): void;
    /** The session moved or removed the name `key` (OwnNames.superseded). */
    superseded(key: string): void;
    /** Whether a mutation at `key` would be decided here (a held subtree holds it). */
    holds(key: string): boolean;
    /** A barrier begins: its number, which `retire` takes once it lands. */
    barrierBegun(): number;
    /**
     * Barrier `begun` landed: what this process changed by name and the
     * session answered before it began is the view's now. Its own record of
     * each such name retires, outside a held subtree (a held one keeps its
     * decisions while it holds it).
     */
    retire(begun: number): void;
    /** Whether anything decided here is not sent yet. */
    pending(): boolean;
    /** Send everything decided, in order. A refusal is thrown (the run fails, naming it). */
    flush(): Promise<void>;
    /** The end of the run: send everything, and give every subtree back. */
    settle(): Promise<void>;
    /** Waves sent, recalls answered, and grants taken. */
    stats(): {
        waves: number;
        ops: number;
        recalls: number;
        grants: number;
        widened: number;
    };
}
export declare function delegationHolder(options: HolderOptions): DelegationHolder;
//# sourceMappingURL=delegation-holder.d.ts.map