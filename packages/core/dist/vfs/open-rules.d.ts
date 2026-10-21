/**
 * open(2)'s rules of its flags, one for every caller: the session's opens
 * (SQLite's and a mount's) and the refusals a process's resident filesystem
 * answers in their place.
 */
import type { RuntimeFileHandle } from '../runtime/os-contracts.js';
import type { VfsErrorCode } from './vfs-error.js';
/**
 * Where an open looks its name up (CompositeVFS.pin): through a link at it,
 * unless it declines to (O_NOFOLLOW) or answers for the name itself
 * (O_CREAT|O_EXCL).
 */
export declare function openFollows(flags: RuntimeFileHandle['flags']): boolean;
/**
 * The refusals open(2) makes of its flags alone, before any name is looked
 * up: O_CREAT|O_DIRECTORY is EINVAL (Linux's build_open_flags). Null when
 * there is none. Every open asks it first, on SQLite as on a mount.
 */
export declare function flagsRefusal(flags: RuntimeFileHandle['flags']): VfsErrorCode | null;
/**
 * The access an open asks of a file that is there (VFS.access's mode), as
 * Linux's open asks it: read for reading, write for writing or O_TRUNC
 * (whatever rights the descriptor itself has). A description's write rights
 * on a directory are a capability, not an access (a WASI guest asks a
 * capability set); a wave's open is to write.
 */
export declare function openAccess(flags: RuntimeFileHandle['flags'], directory: boolean, describes?: boolean): number;
/**
 * Whether an open of a directory with `flags` is refused (EISDIR): it would
 * make it (O_CREAT), change its content (O_TRUNC, O_APPEND), or, keeping no
 * description (`describes` false, a wave's open to write), write it.
 * O_DIRECTORY changes none of these. Any other open of a directory opens.
 */
export declare function refusesDirectory(flags: {
    readonly create?: boolean;
    readonly truncate?: boolean;
    readonly append?: boolean;
    readonly write?: boolean;
}, describes?: boolean): boolean;
//# sourceMappingURL=open-rules.d.ts.map