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
//# sourceMappingURL=proc-vfs.d.ts.map