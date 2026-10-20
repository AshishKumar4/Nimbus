/** A plain lookup key, or null when components must be walked before normalization. */
export declare function plainVfsPath(path: string): string | null;
export declare function normalizeVfsPath(p: string): string;
export declare function normalizeVfsLookupPath(path: string): string | null;
/** Resolve a user path against a VFS cwd and return a canonical VFS key. */
export declare function resolveVfsPath(path: string, cwd: string): string;
/** Whether one engine key is the other or under it: '' (the root) overlaps every key. */
export declare function pathsOverlap(left: string, right: string): boolean;
/** The directory a storage key (already normalized) is under: '' at the root. */
export declare function parentKey(key: string): string;
/** The directory a path is in, by its last '/': '/' for a path directly under the root (or none). */
export declare function parentOf(path: string): string;
export declare function parentVfsPath(path: string): string;
/** Strip leading slashes only — does not touch internal segments. */
export declare function stripLeadingSlashes(p: string): string;
/**
 * The basename's extension including its leading dot, or an empty string when
 * there is none. A dot that opens the basename belongs to the name (`.bashrc`)
 * rather than to an extension, matching Node's `path.extname`.
 *
 * `endsWith` and `split('.').pop()` are not substitutes for callers deciding
 * how to PARSE a file: neither can say "this path has no extension", and the
 * latter answers `js/bin/tsc` for `home/user.js/bin/tsc`. Extensionless files
 * are the shape of nearly every npm `bin` script, so that answer is
 * load-bearing rather than an edge case.
 */
export declare function vfsPathExtension(path: string): string;
/**
 * Whether `path` is a sibling of directory `key` whose name extends `key`'s
 * with a character below '/' (`key-x`, `key.x`): it sorts between `key` and
 * `key/`, so a walk of `key` from the cursor `key/` (which names `key`) meets
 * it first, and its own subtree, before `key`'s entries.
 */
export declare function beforeSubtree(path: string, key: string): boolean;
//# sourceMappingURL=path.d.ts.map