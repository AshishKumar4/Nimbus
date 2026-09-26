/**
 * /proc: files generated when read, for the principal reading them.
 *
 * Synchronous and read-only. A file is a generator from the reading
 * principal's credential to text; `register` adds or replaces one, and
 * `name` may be nested (`net/info`), which makes its directories. Nothing
 * here is stored, so nothing here has a revision: a cache never holds it.
 */
import type { SyncVFS, VFS, VfsCred, VfsDirent, VfsStat } from './vfs.js';
/** A /proc file's content, for the credential of the process reading it (null: the embedder's view). */
export type ProcGenerator = (cred: VfsCred | null) => string;
export declare class ProcVFS implements VFS {
    private readonly cred;
    private readonly files;
    readonly sync: SyncVFS;
    constructor(files?: Map<string, ProcGenerator>, cred?: VfsCred | null);
    /** Add or replace `/proc/<name>`. */
    register(name: string, generator: ProcGenerator): void;
    /** The same files, generated for `cred`. */
    as(cred: VfsCred): ProcVFS;
    private isDir;
    private generate;
    stat(path: string): VfsStat | null;
    readFile(path: string): Uint8Array;
    readRange(path: string, offset: number, length: number): Uint8Array;
    readdir(path: string): VfsDirent[];
    private readOnly;
    writeFile(path: string): void;
    mkdir(path: string): void;
    unlink(path: string): void;
    rmdir(path: string): void;
    describe(): {
        source: string;
        type: string;
        options: readonly ["ro"];
    };
}
/**
 * The /proc every workspace has: cpuinfo, meminfo, uptime, version and
 * net/info. ProcessFiles adds `mounts`, and a host adds its own with
 * `register`.
 */
export declare function standardProc(): ProcVFS;
//# sourceMappingURL=proc-vfs.d.ts.map