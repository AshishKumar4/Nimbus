/**
 * A file on a mount, opened: open(2) as the namespace decides it for every
 * caller (a process's synchronous and asynchronous faces, a wave's open),
 * and the description its descriptors share. The open is decided on the
 * name its lookup found (CompositeVFS.pin, PinnedName), and the description
 * holds the file there (PinnedName.hold, HeldFile).
 *
 * What a mount does not give, a description on it does not promise: an
 * O_APPEND write is the end as it is read, then a write there (two writers
 * on an awaiting mount can meet at one end); O_CREAT|O_EXCL is a stat, then a
 * create (two awaiting opens can both create). A file on a backend that
 * keeps no open files (VFS.openFile) is held by its name, and a description
 * of it refuses (ESTALE) once that name holds another file. The writes a
 * description holds are its process's: written before that process cuts
 * their file (settleHeld), never before another process's change.
 */
import { type DescriptorScope, type MountedFileDescription } from '../runtime/descriptors.js';
import type { RuntimeFileHandle } from '../runtime/os-contracts.js';
import type { HeldFile, PinnedName } from './composite.js';
import { type Awaitable, type VfsStat } from './vfs.js';
import { type VfsErrorCode } from './vfs-error.js';
/** What one description holds unwritten before EFBIG: a whole-file rewrite at flush, kept off the heap's edge. */
export declare const BUFFERED_WRITE_BYTES: number;
/** How the caller names a refusal: `code`, for its call `syscall` (open, write, ftruncate, …). */
export type Refuse = (code: VfsErrorCode, syscall: string) => Error;
export interface MountedOpen {
    flags: RuntimeFileHandle['flags'];
    refuse: Refuse;
    /** The mode a file this open makes is made with. */
    mode?: number;
}
/**
 * open(2) of the name `file` found (pinned where the lookup landed,
 * openFollows), one rule for every caller, Linux's (do_open) where Linux and
 * POSIX differ, in its order:
 * - O_CREAT|O_EXCL of a name that is there, a link included: EEXIST;
 * - O_DIRECTORY of a link not followed: ENOTDIR; O_NOFOLLOW of a link: ELOOP;
 * - an absent name without O_CREAT: ENOENT;
 * - O_DIRECTORY of anything but a directory: ENOTDIR;
 * - a directory refuses O_CREAT, O_TRUNC and O_APPEND (EISDIR), and an open
 *   that keeps no description (`describes` false, a wave's open to write)
 *   any write (refusesDirectory);
 * - the access asked (openAccess), by the backend's own policy (VFS.access):
 *   a backend that takes a caller's credential enforces modes, one of one
 *   identity has none;
 * - only then is the file made, or truncated, there.
 * Answers the file's stat. `admit` runs right before the backend is asked to
 * change anything, after every await.
 */
export declare function openOnMount(file: PinnedName, open: MountedOpen, describes: boolean, admit?: () => void): Awaitable<VfsStat>;
/** What a mounted description is held with, whatever opened it. */
export interface MountedDescriptionContext {
    /** The descriptors' scope: its held writes are this process's (processView, settleHeld). */
    scope: DescriptorScope;
    /** Its opener's own abort (a caller's signal): the description's calls are refused once it comes, its buffered writes lost. */
    signal?: AbortSignal;
    refuse: Refuse;
    /** O_SYNC: each write in the mount before it returns. */
    sync: boolean;
    /** What a description holds unwritten before a write is EFBIG. */
    bufferedWriteBytes: number;
}
export interface MountedDescriptionOptions extends MountedOpen, MountedDescriptionContext {
    /** The name opened, in the namespace. */
    name: string;
    /** The name `name` leads to now (CompositeVFS.pin): what the open decides on, and its description holds. */
    pin(name: string, follow: boolean): Awaitable<PinnedName>;
}
/** open(2) of a mounted file, and the description its descriptors share: one pin, for both. */
export declare function openMounted(options: MountedDescriptionOptions): Awaitable<MountedFileDescription>;
/**
 * A new description of the file `description` is on (Linux's open of
 * /proc/self/fd/N), on its mount: the file at the name it is held by, so
 * long as that name still holds it (ESTALE once it holds another, as a
 * description held by its name refuses), with `options.flags`' access and an
 * offset of its own. O_TRUNC cuts it only once it is known to be that file.
 */
export declare function reopenMounted(description: MountedFileDescription, options: Omit<MountedDescriptionOptions, 'name'>): Awaitable<MountedFileDescription>;
/**
 * The description of `file`, opened already (openOnMount), its number `ino`:
 * what its descriptors share, with the rights its open asked. A read or a
 * write it was not opened for is EBADF, as through the engine's own
 * description (SqliteVFS.describeInode), whoever asks: a descriptor, or a
 * wave's call that names it.
 */
export declare function describeMounted(context: MountedDescriptionContext, file: HeldFile, ino: number, rights: {
    read: boolean;
    write: boolean;
}): MountedFileDescription;
//# sourceMappingURL=mounted-description.d.ts.map