/**
 * object-store.ts — the files a KV or R2 binding's objects live in, for both
 * emulators:
 *
 *   <root>/.nimbus/<kind>/<binding>/<key>        — body (raw bytes)
 *   <root>/.nimbus/<kind>/<binding>/<key>.meta   — sidecar JSON
 *
 * A key is stored URL-encoded, so any key is one path segment of its
 * binding's own directory, and so is the binding's name; a name that does
 * not decode is no key's (an upload being written). Each emulator keeps
 * its own sidecar schema and policies: KV's expiry, R2's conditionals,
 * ranges and delimiters. Both list keys in UTF-8 byte order and page with
 * Cloudflare's local cursor, the last key listed in base64.
 */
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
/** The directory a binding's objects live in, under the project `root`. */
export declare function objectStoreDir(root: string, kind: 'kv' | 'r2', binding: string): string;
/**
 * The file a key's body is stored in; its sidecar is the same name plus
 * `.meta`. URL-encoding leaves dots as they are, so the dots of `.` and
 * `..` (the directory and its parent) are encoded, and so is the last dot
 * of a key ending `.meta` (another key's sidecar).
 */
export declare function objectFileName(key: string): string;
/** A file a body is written to before it replaces its key's: no key's name, as it does not decode. */
export declare function uploadFileName(): string;
/** Remove a key's body and its sidecar, each where it exists. */
export declare function removeObjectFiles(vfs: Pick<CredentialedVfs, 'exists' | 'unlink'>, dir: string, fileName: string): void;
/** -1, 0 or 1 as `a` sorts before, with or after `b` in UTF-8 byte order (SQLite's BINARY collation). */
export declare function utf8Order(a: string, b: string): number;
/** The keys under `dir` that start with `prefix`, each with its file name, in key order. */
export declare function listObjectFiles(vfs: Pick<CredentialedVfs, 'readdir'>, dir: string, prefix: string): Array<{
    key: string;
    fileName: string;
}>;
/** The cursor of a page whose last key is `key`: the key, base64 of its UTF-8. */
export declare function cursorAfter(key: string): string;
/** The key a cursor's page ended at, which the next page starts after. */
export declare function cursorKey(cursor: string): string;
//# sourceMappingURL=object-store.d.ts.map