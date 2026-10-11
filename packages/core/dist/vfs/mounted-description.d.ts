/**
 * A file on a mount, opened: open(2) as the namespace decides it for every
 * caller (a process's synchronous and asynchronous faces, a wave's open),
 * and the description its descriptors share. The open is decided through
 * `files`, the namespace as the caller sees it: its synchronous face
 * (CompositeVFS.sync), which refuses an asynchronous mount at the first
 * lookup, before anything has changed; or the namespace itself. The
 * description holds the file where that lookup landed (CompositeVFS.pin).
 */
import { type Description, type DescriptorScope } from '../runtime/descriptors.js';
import type { RuntimeFileHandle } from '../runtime/os-contracts.js';
import { type PinnedFile } from './composite.js';
import { type Awaitable, type VFS, type VfsStat } from './vfs.js';
/** What one description holds unwritten before EFBIG: a whole-file rewrite at flush, kept off the heap's edge. */
export declare const BUFFERED_WRITE_BYTES: number;
/** How the caller names a refusal: `code`, for its call `syscall` (open, write, ftruncate, …). */
export type Refuse = (code: string, syscall: string) => Error;
export interface MountedOpen {
    files: VFS;
    /** The name opened, in the namespace. */
    name: string;
    flags: RuntimeFileHandle['flags'];
    refuse: Refuse;
    /** The mode a file this open makes is made with. */
    mode?: number;
}
/**
 * open(2) of `name`, one rule for every caller, Linux's where Linux and
 * POSIX differ: O_CREAT|O_EXCL is EEXIST on the name itself, a link
 * included; O_NOFOLLOW of a link is ELOOP; an absent name without O_CREAT is
 * ENOENT, and with O_DIRECTORY EINVAL; O_DIRECTORY of anything else is
 * ENOTDIR; a directory refuses O_TRUNC and O_APPEND (EISDIR); and only
 * then is the file made, or truncated. Answers the file's stat. Who may
 * open a file for what is the mount's own policy, as for every operation on
 * it (VFS.access, which `authorize` asks of a file that is there, before
 * anything changes): a backend that takes a caller's credential enforces
 * modes; a backend of one identity has none. `describes`: whether the open
 * keeps a description, whose write rights a directory may carry (a WASI
 * guest asks a capability set); an open that keeps none (a wave's) is an
 * open to write, which a directory refuses. `settled` runs right before the
 * answer, or the change.
 */
export declare function openOnMount(open: MountedOpen, describes: boolean, hooks: {
    authorize(there: VfsStat): Awaitable<void>;
    settled?(): Awaitable<void>;
}): Awaitable<VfsStat>;
/** The access an open asks of a file that is there (VFS.access's mode): a directory's write rights are a capability, not an access. */
export declare function openAccess(flags: RuntimeFileHandle['flags'], there: VfsStat): number;
export interface MountedDescriptionOptions extends MountedOpen {
    /** The descriptors' scope: whose pending writes this process reads (processView). */
    scope: DescriptorScope;
    /** The file the opened name leads to now (CompositeVFS.pin): what the description holds, whatever later moves at the name. */
    pin(name: string): Awaitable<PinnedFile>;
    /** `files` answers only by awaiting (the namespace itself, for an asynchronous mount). */
    awaits: boolean;
    /** O_SYNC: each write in the mount before it returns. */
    sync: boolean;
    /** What a description holds unwritten before a write is EFBIG. */
    bufferedWriteBytes: number;
}
/** open(2) of a mounted file, and the description its descriptors share. */
export declare function openMounted(options: MountedDescriptionOptions): Awaitable<Description>;
//# sourceMappingURL=mounted-description.d.ts.map