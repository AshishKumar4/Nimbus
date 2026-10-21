import { type ProcGenerator } from './proc-files.js';
import type { SyncVFS, VFS, VfsChanges, VfsCred, VfsDirent, VfsStat } from './vfs.js';
/** What every view of one /proc shares: its files, which of them are volatile, and its tree's version and time. */
interface ProcTree {
    readonly files: Map<string, ProcGenerator>;
    readonly volatile: Set<string>;
    version: number;
    mtimeMs: number;
}
export declare class ProcVFS implements VFS {
    private readonly tree;
    private readonly cred;
    readonly sync: SyncVFS;
    readonly changes: VfsChanges;
    constructor(tree?: ProcTree, cred?: VfsCred | null);
    private get files();
    /** Add or replace `/proc/<name>`; `volatile`: its content is made at each read (size 0). */
    register(name: string, generator: ProcGenerator, volatile?: boolean): void;
    /** The same files, generated for `cred`. */
    as(cred: VfsCred): ProcVFS;
    private isDir;
    /** The file's content: text made for this read, or bytes shared with every read, which are not the caller's to change. */
    private generate;
    stat(path: string): VfsStat | null;
    readFile(path: string): Uint8Array;
    /** Its files are root's, 0444, its directories 0555: a credential asks them by their mode (the embedder's view is not judged). */
    access(path: string, mode: number): void;
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
 * The trust store: the TLS roots this build serves (Mozilla's, pinned by
 * scripts/update-ca-certificates.mjs). Generated here rather than kept in a
 * session, so every session trusts what the deployed Nimbus trusts, and a
 * root Mozilla distrusts leaves every session with the next deploy (a copy
 * staged in a session would keep it). CPython's and Ruby's OpenSSL read it
 * through SSL_CERT_FILE (interpreter-env.ts): their default paths are their
 * build machine's.
 */
export declare const CA_CERTIFICATES_FILE = "/proc/nimbus/ca-certificates.crt";
/**
 * The /proc every workspace has: cpuinfo, meminfo, uptime, version,
 * net/info and the trust store. ProcessFiles adds `mounts`, and a host adds
 * its own with `register`.
 */
export declare function standardProc(): ProcVFS;
export {};
//# sourceMappingURL=proc-vfs.d.ts.map