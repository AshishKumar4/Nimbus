/**
 * dev-provider.ts — virtual /dev provider.
 *
 * shell compatibility (2026-05-11): pre-fix `cmd > /dev/null` and
 * `cmd 2>/dev/null` returned `ENOENT: '/dev': no such file or
 * directory` because /dev wasn't mounted. Standard Unix idioms
 * (`make 2>/dev/null`, `cmd > /dev/null 2>&1`, scripts piping
 * to /dev/null) all failed.
 *
 * This provider implements the standard device-file subset:
 *
 *   /dev/null    — write: discard; read: EOF (empty)
 *   /dev/zero    — write: discard; read: infinite zeros (capped per read)
 *   /dev/random  — write: discard; read: crypto.getRandomValues()
 *   /dev/urandom — alias of /dev/random
 *   /dev/stdin   — passthrough placeholder (not really useful here)
 *   /dev/stdout  — passthrough placeholder
 *   /dev/stderr  — passthrough placeholder
 *   /dev/full    — write: ENOSPC; read: infinite zeros
 *
 * The provider is mounted at `/dev` (no leading slash for Kernel
 * convention which already does that). All entries are virtual:
 * stat returns synthesized FileType-shaped objects. The MountProvider
 * surface the vendored MountProvider expects (readFile/writeFile/exists/stat/readdir/
 * unlink/mkdir/rmdir/rename/copyFile) is fully implemented — reads
 * from non-existent dev nodes return ENOENT, writes to read-only
 * nodes silently succeed (Unix /dev/null/zero/random semantics).
 */
/**
 * MountProvider impl for /dev. The vendored Kernel routes any path
 * under /dev/* through these methods.
 */
export declare class DevProvider {
    private nodes;
    constructor();
    /** Normalize "/foo" or "foo" to "foo". Kernel passes either shape
     *  depending on call site; defensive normalization. */
    private norm;
    readFile(sub: string): Uint8Array;
    readFileString(sub: string): string;
    writeFile(sub: string, content: string | Uint8Array): void;
    exists(sub: string): boolean;
    stat(sub: string): {
        type: string;
        size: number;
        mtime: number;
        ctime: number;
        mode: number;
    };
    readdir(sub: string): {
        name: string;
        type: string;
    }[];
    unlink(sub: string): void;
    mkdir(_sub: string, _opts?: {
        recursive?: boolean;
    }): void;
    rmdir(_sub: string): void;
    rename(_o: string, _n: string): void;
    copyFile(_s: string, _d: string): void;
    appendFile(_sub: string, _content: string | Uint8Array): void;
    isDirectory(sub: string): boolean;
}
//# sourceMappingURL=dev-provider.d.ts.map