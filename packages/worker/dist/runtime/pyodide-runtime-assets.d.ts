import type { RuntimeManifest } from './runtime-catalog.js';
import type { CredentialedVfs } from '../vfs/sqlite-vfs.js';
export interface PyodideRuntimeAssetPaths {
    asmWasmVfs: string | null;
    asmJsVfs: string | null;
    stdlibVfs: string | null;
    lockfileVfs: string | null;
    manifest: RuntimeManifest;
    vfs: CredentialedVfs;
}
export interface PyodideRuntimeFiles {
    asmWasmBytes: Uint8Array;
    asmJsSrc: string;
    stdlibB64: string;
    lockfileText: string;
}
export declare function readPyodideRuntimeFiles(args: PyodideRuntimeAssetPaths): PyodideRuntimeFiles;
export declare function uint8ToBase64(u8: Uint8Array): string;
//# sourceMappingURL=pyodide-runtime-assets.d.ts.map