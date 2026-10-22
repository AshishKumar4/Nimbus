/**
 * The /proc every workspace has, but its trust store: each file's generator,
 * a pure function of the isolate reading it (its CPUs, heap, clock,
 * network, runtime). Every one is made at each read, its stat size 0, as
 * Linux procfs says. One source for the session's /proc (proc-vfs.ts
 * standardProc) and for a process's filesystem (the resident filesystem,
 * Node's shims), which makes each itself at each read: a call that cannot
 * wait answers it, and nothing is fetched that is stale once it arrives.
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
}>>;
/** The generator of /proc/<name>, made by whoever reads it, at each read; undefined for a file only the session makes (/proc/mounts, the trust store). */
export declare function procFileGenerator(name: string): ProcGenerator | undefined;
//# sourceMappingURL=proc-files.d.ts.map