/**
 * object-store.ts — the files a KV or R2 binding's objects live in, for both
 * emulators:
 *
 *   <root>/.nimbus/<kind>/<binding>/<key>        — body (raw bytes)
 *   <root>/.nimbus/<kind>/<binding>/<key>.meta   — sidecar JSON
 *
 * A key is stored URL-encoded, so any key is one path segment. Each emulator
 * keeps its own sidecar schema and policies: KV's expiry, R2's conditionals,
 * ranges and delimiters.
 */
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
/** The directory a binding's objects live in, under the project `root`. */
export declare function objectStoreDir(root: string, kind: 'kv' | 'r2', binding: string): string;
/** The file a key's body is stored in; its sidecar is the same name plus `.meta`. */
export declare function objectFileName(key: string): string;
/** Remove a key's body and its sidecar, each where it exists. */
export declare function removeObjectFiles(vfs: Pick<CredentialedVfs, 'exists' | 'unlink'>, dir: string, fileName: string): void;
/** The keys under `dir` that start with `prefix`, each with its file name, in key order. */
export declare function listObjectFiles(vfs: Pick<CredentialedVfs, 'readdir'>, dir: string, prefix: string): Array<{
    key: string;
    fileName: string;
}>;
/**
 * One page of `entries`, from the offset `cursor` names (the first page
 * without one), and the cursor of the page after it while entries remain.
 * A cursor that does not decode starts from the first entry.
 */
export declare function cursorPage<T>(entries: T[], cursor: string | undefined, limit: number): {
    page: T[];
    next?: string;
};
//# sourceMappingURL=object-store.d.ts.map