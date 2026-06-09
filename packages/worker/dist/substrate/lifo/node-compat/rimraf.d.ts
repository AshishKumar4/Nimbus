/**
 * `rimraf` npm package shim for Lifo.
 *
 * Provides the rimraf(path, [opts], cb) callback API, rimraf.sync(path),
 * and the modern rimraf v4+ promise-based API, all backed by the VFS
 * fs shim's recursive rmdir.
 */
import type { VFS } from '../kernel/vfs/index.js';
export interface RimrafOptions {
    glob?: boolean | object;
    maxRetries?: number;
    retryDelay?: number;
    filter?: (path: string) => boolean;
}
export declare function createRimraf(vfs: VFS, cwd: string): {
    (p: string, optsOrCb?: RimrafOptions | ((err: Error | null) => void), cb?: (err: Error | null) => void): void;
    sync: (p: string) => void;
    rimraf: (p: string) => Promise<void>;
    rimrafSync: (p: string) => void;
    native: (p: string) => Promise<void>;
    nativeSync: (p: string) => void;
    manual: (p: string) => Promise<void>;
    manualSync: (p: string) => void;
    windows: (p: string) => Promise<void>;
    windowsSync: (p: string) => void;
    moveRemove: (p: string) => Promise<void>;
    moveRemoveSync: (p: string) => void;
    default: /*elided*/ any;
};
//# sourceMappingURL=rimraf.d.ts.map