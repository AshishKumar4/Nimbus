import type { RuntimeFsBridge } from '../../../runtime/os-contracts.js';
import type { NodeFilesystem } from '../../../node-compat/faces.js';
export type { NodeFilesystem, NodeWatch } from '../../../node-compat/faces.js';
/**
 * The in-process Node interpreter runs `require` synchronously, so it demands
 * the authority's synchronous capability. The demand is made on first use:
 * a program that never touches fs runs on a host without one. What it
 * creates is made with `umask()`, the program's own mask (process.umask).
 */
export declare function synchronousFilesystem(view: {
    process: RuntimeFsBridge;
}, umask: () => number): () => NodeFilesystem;
//# sourceMappingURL=filesystem.d.ts.map