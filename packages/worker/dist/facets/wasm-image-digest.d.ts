/**
 * wasm-image-digest.ts — the content key of a wasm image file, read where it
 * lies (wasm-image-key.ts is the key itself).
 */
import type { RuntimeFsBridge } from '@nimbus-sh/core/runtime/os-contracts.js';
/**
 * `wasmImageDigest` of a file, read one slice at a time: the coordinator
 * digests a closure's images while the launch's module map is resident, and
 * a 15 MiB image read whole beside it was enough to reset the isolate. Null
 * when the file cannot be read.
 */
export declare function streamedWasmImageDigest(fs: Pick<RuntimeFsBridge, 'stat' | 'readRange'>, path: string): Promise<string | null>;
/** One wasm image a launch registers: where the program reads it, and its content key. */
export interface WasmImageRecord {
    /** Absolute VFS path (leading slash). */
    vfsPath: string;
    digest: string;
}
//# sourceMappingURL=wasm-image-digest.d.ts.map