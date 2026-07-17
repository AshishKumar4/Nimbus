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
    appendFile(path: string, content: string | Uint8Array): void;
    exists(path: string): boolean;
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