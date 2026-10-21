/**
 * The /proc every workspace has, but its trust store: each file's generator
 * and whether it is volatile (made at each read: the heap, the clock, the
 * network). One source for the session's /proc (proc-vfs.ts standardProc)
 * and for a process's resident filesystem, which makes a volatile file
 * itself at each read rather than ask the session for bytes that are stale
 * once they arrive.
 */
import type { VfsCred } from './vfs.js';
/**
 * A /proc file's content, for the credential of the process reading it (null:
 * the embedder's view): text made when read, or bytes made once and shared,
 * which a whole-file read copies and a stat or ranged read does not.
 */
export type ProcGenerator = (cred: VfsCred | null) => string | Uint8Array;
/** Where the kernel mounts /proc. */
export declare const PROC_MOUNT_POINT = "/proc";
export declare const PROC_FILES: Readonly<Record<string, {
    readonly generate: ProcGenerator;
    readonly volatile: boolean;
}>>;
/** The generator of /proc/<name> where it is volatile: made by whoever reads it, at each read. */
export declare function volatileProcFile(name: string): ProcGenerator | undefined;
//# sourceMappingURL=proc-files.d.ts.map