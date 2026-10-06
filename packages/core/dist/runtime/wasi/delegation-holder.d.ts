/**
 * A WASI process as a delegation's holder (spike/delegation/MEMO.md, P4a):
 * inside the subtrees it holds, the process decides its creates, writes,
 * mkdirs, unlinks, renames and attribute changes itself, against what its
 * resident store knows and what it decided, with no round trip, and sends
 * them later as one ordered log (a W7 v4 wave under the delegation's lease):
 * at each point where what it wrote could be observed (a socket send, an
 * fsync, the end of its run) and when the session recalls the subtree.
 *
 * What it decides is the session's answer, kept exactly:
 *   - A subtree is held only where the process mutates: the deepest existing
 *     directory holding the name it changes, at most MAX_DELEGATIONS_PER_PROCESS
 *     of them; past that, two are widened to their common ancestor. Never the
 *     whole filesystem, a home directory itself, or the session's stores
 *     (the session refuses those), and never a subtree with a default ACL in
 *     it (its inheritance is the session's to apply): there, the process
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
 *   - The log keeps program order for whatever prefix of it lands: a file
 *     made here is logged where it is made (empty), and its bytes where it
 *     was last written, under the name it had then.
 *
 * A recall is answered by a loop per grant on the host side of the process:
 * a guest that waits in a syscall lets it run; one computing does not
 * (the documented limit, answered by the session's recall timeout).
 */
import type { ExclusiveMutationGrant, RecallKind, RuntimeFileHandle, RuntimeVfsDirEntry } from '../os-contracts.js';
import type { ResidentEntry } from './resident-filesystem.js';
import { type W7Attrs } from '@nimbus-sh/platform/w7-frame.js';
/** The most subtrees one process holds at once; past it, two are widened to their common ancestor. */
export declare const MAX_DELEGATIONS_PER_PROCESS = 8;
/** What the holder asks of the session. */
export interface HolderSession {
    /** Take the subtree at `path` as a delegation (fsAcquireExclusiveMutation with `delegate`). */
    acquire(path: string, delegate: {
        reads: boolean;
        inos: number;
        bytes: number;
    }): Promise<ExclusiveMutationGrant>;
    release(owner: string): Promise<void>;
    awaitRecall(owner: string, waitMs: number): Promise<RecallKind | null>;
    recalled(owner: string, kind: RecallKind): Promise<void>;
    /** Send one wave under `owner`'s lease; `ok` false with the session's refusal. */
    sendWave(stream: ReadableStream<Uint8Array>, owner: string): Promise<{
        ok: boolean;
        error?: {
            message: string;
        };
    }>;
}
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
}
export interface HolderOptions {
    readonly session: HolderSession;
    readonly store: HolderStore;
    /** Every engine key that is a home directory (`home/<name>`): never held itself. */
    readonly isHomeRoot?: (key: string) => boolean;
    /** Told when what the holder decided changed the namespace the store shows (the barrier is owed after a send). */
    readonly sent?: () => void;
    /** The clock files are stamped with. */
    readonly now?: () => number;
}
/** The decisions the process made in a held subtree, not yet sent. */
export interface DelegationHolder {
    /** What the process decided is at `key`: an entry, null (removed), or undefined (nothing decided). */
    entry(key: string): ResidentEntry | null | undefined;
    /** The names in `key`, as `base` lists them with what the process decided there. */
    children(key: string, base: RuntimeVfsDirEntry[] | undefined): RuntimeVfsDirEntry[] | undefined;
    /** The bytes of a file made or rewritten here. */
    content(entry: ResidentEntry): Uint8Array | undefined;
    /** Whether `handleId` is one of the holder's own descriptors. */
    owns(handleId: number): boolean;
    /**
     * Decide an open that creates or empties a file at `key` (resolved, its
     * parent known): a descriptor of the holder's, or undefined when the
     * session is to decide it.
     */
    open(key: string, path: string, flags: {
        read?: boolean;
        write?: boolean;
        append?: boolean;
        create?: boolean;
        truncate?: boolean;
        exclusive?: boolean;
        mode?: number;
    }): RuntimeFileHandle | undefined | Promise<RuntimeFileHandle | undefined>;
    read(handleId: number, offset: number | null, length: number): Uint8Array;
    write(handleId: number, offset: number | null, bytes: Uint8Array): number;
    seek(handleId: number, offset: number, whence: 'set' | 'current' | 'end'): number;
    ftruncate(handleId: number, size: number): void;
    fstat(handleId: number): ResidentEntry;
    close(handleId: number): void;
    /** The name a descriptor of the holder's writes, now. */
    keyOf(handleId: number): string;
    /** Another descriptor of the same open file (its position shared). */
    dup(handleId: number): RuntimeFileHandle;
    /** Decide a mkdir at `key`: true when decided here (and done), false when the session is to. */
    mkdir(key: string, path: string, mode: number): boolean | Promise<boolean>;
    /** Decide an unlink of `key` (a file or link): true when decided here. */
    unlink(key: string, path: string): boolean | Promise<boolean>;
    /** Decide a rename of `from` to `to` (both resolved): true when decided here. */
    rename(from: string, to: string, path: string): boolean | Promise<boolean>;
    /** Decide an attribute change of `key`: true when decided here. */
    setattr(key: string, attrs: W7Attrs): boolean | Promise<boolean>;
    /** Whether a mutation at `key` would be decided here (a held subtree holds it). */
    holds(key: string): boolean;
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