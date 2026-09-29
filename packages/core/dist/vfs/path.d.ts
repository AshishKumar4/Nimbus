export declare function normalizeVfsPath(p: string): string;
/** Resolve a user path against a VFS cwd and return a canonical VFS key. */
export declare function resolveVfsPath(path: string, cwd: string): string;
/** Return the canonical VFS parent key, or an empty string for root-level paths. */
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
//# sourceMappingURL=path.d.ts.map