import type { RuntimeFsBridge } from '../../../runtime/os-contracts.js';
import { type VFS } from '../kernel/vfs/index.js';
export type NodeFilesystem = Pick<VFS, 'readFile' | 'readFileString' | 'writeFile' | 'appendFile' | 'exists' | 'stat' | 'mkdir' | 'readdir' | 'unlink' | 'rmdir' | 'rmdirRecursive' | 'rename' | 'copyFile' | 'chmod' | 'onChange' | 'isFile' | 'isDirectory'>;
/**
 * The in-process Node interpreter runs `require` synchronously, so it demands
 * the authority's synchronous capability. The demand is made on first use:
 * a program that never touches fs runs on a host without one.
 */
export declare function synchronousFilesystem(view: {
    local: VFS | null;
    authority: RuntimeFsBridge;
}): () => NodeFilesystem;
//# sourceMappingURL=filesystem.d.ts.map