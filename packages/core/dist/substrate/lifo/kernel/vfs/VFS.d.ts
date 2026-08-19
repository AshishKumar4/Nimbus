import { INode, Stat, Dirent, VirtualProvider, MountProvider } from './types.js';
import type { VFSWatchListener } from './types.js';
import { ContentStore } from '../storage/ContentStore.js';
import type { VfsCred } from '../../../../runtime/os-contracts.js';
export declare class VFS {
    private root;
    /**
     * Mount table -- kept sorted longest-prefix-first so that the first match
     * during lookup is always the most specific.
     */
    private mounts;
    private emitter;
    onChange?: () => void;
    /** Content store for chunked large files. Optional -- without it all data stays inline. */
    readonly contentStore: ContentStore;
    private cred?;
    constructor(contentStore?: ContentStore);
    as(cred: VfsCred): VFS;
    watch(listener: VFSWatchListener): () => void;
    watch(path: string, listener: VFSWatchListener): () => void;
    private notify;
    /**
     * Mount a provider at an arbitrary path.
     * The path is normalised to an absolute path (e.g. "/mnt/project").
     */
    mount(path: string, provider: VirtualProvider | MountProvider): void;
    /**
     * Unmount the provider at the given path.
     */
    unmount(path: string): void;
    /**
     * Backward-compatible alias for `mount`.
     * Previously the only way to register a VirtualProvider at a root-level prefix.
     */
    registerProvider(prefix: string, provider: VirtualProvider): void;
    getRoot(): INode;
    loadFromSerialized(root: INode): void;
    /**
     * `provider` is derived per call — a credentialed VFS hands back a fresh
     * `as(cred)` view every time — so it is never a stable identity. `entry` is
     * the mount itself and is what "are these two paths on the same filesystem"
     * has to compare.
     */
    private getProvider;
    private createNode;
    private resolveNode;
    private resolveParent;
    private toAbsolute;
    readFile(path: string): Uint8Array;
    readFileString(path: string): string;
    writeFile(path: string, content: string | Uint8Array): void;
    /**
     * Store file content -- inline for small files, chunked for large files.
     */
    private applyFileContent;
    /**
     * Read at most `length` bytes at `offset`. Short reads are legal; an empty
     * result means EOF. Streams (`/dev/*`) and chunked backing stores serve the
     * slice directly, so bounded readers never materialise a whole file.
     */
    readRange(path: string, offset: number, length: number): Uint8Array;
    /**
     * Write `bytes` at `offset`, growing the file (zero-filling any gap) as
     * needed. This is the single write primitive behind sequential writers —
     * shell redirections, `dd`, and appends all advance an offset through it
     * instead of rewriting the file per chunk.
     */
    writeRange(path: string, offset: number, bytes: Uint8Array): void;
    /** Shrink or zero-extend a file to exactly `size` bytes. */
    truncate(path: string, size: number): void;
    private mountProvider;
    /**
     * Replace a file's bytes with `transform(current)`. The read-modify-write
     * shape is what a backing store without positional writes forces; providers
     * that do have them never reach here.
     */
    private rewriteFile;
    appendFile(path: string, content: string | Uint8Array): void;
    exists(path: string): boolean;
    /**
     * Type probes, mount-aware through {@link stat}.
     *
     * `CredentialedVfs` declares these and the durable coreutils call them on
     * whatever `ctx.vfs` is, so a view that omitted them was not merely missing
     * a convenience: `touch` on an existing file died with
     * `targetVfs.isDirectory is not a function`, because `&&` short-circuited
     * past the call whenever the file was absent — which is why creating a file
     * worked and touching one did not.
     *
     * A structural miss answers false, the way `fs.existsSync` does. A denial
     * still throws: traverse-x enforcement must not be maskable into a quiet
     * false, which is the rule `SqliteVFS.probeInode` already follows.
     */
    isDirectory(path: string): boolean;
    isFile(path: string): boolean;
    private probeType;
    access(path: string, mode: number): void;
    stat(path: string): Stat;
    unlink(path: string): void;
    rename(oldPath: string, newPath: string): void;
    copyFile(src: string, dest: string): void;
    chmod(path: string, mode: number): void;
    chown(path: string, uid: number | null, gid: number | null): void;
    touch(path: string): void;
    mkdir(path: string, options?: {
        recursive?: boolean;
    }): void;
    rmdir(path: string): void;
    readdir(path: string): Dirent[];
    readdirStat(path: string): Array<Dirent & Stat>;
    /**
     * Recursively remove a directory and all its contents.
     */
    rmdirRecursive(path: string): void;
}
//# sourceMappingURL=VFS.d.ts.map