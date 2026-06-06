/**
 * vfs-path.ts — Canonical VFS path normalization.
 *
 * Replaces three near-duplicate implementations that lived in
 * git-commands.ts, esbuild-service.ts, and require-resolver.ts. The
 * git-commands version had a defensive bounds check (`out.length > 0`
 * before pop) that the others lacked — that safer behavior is the one
 * preserved here.
 *
 * Facet-isolate code-string copies (for example git-network-facet,
 * pre-bundle-facet, and node-shims generated/runtime strings) cannot import
 * this module and must keep their inline implementations; those copies are
 * documented as justified.
 *
 * Semantics:
 *   - Strip empty segments (collapses `//` runs)
 *   - Drop `.` segments
 *   - Pop on `..`, but only if there's something to pop (won't escape root)
 *   - Returns slash-joined string with NO leading/trailing slash, suitable
 *     for direct VFS lookup keys
 *
 * Examples:
 *   normalizeVfsPath('/foo/./bar/../baz') -> 'foo/baz'
 *   normalizeVfsPath('/foo//bar/')         -> 'foo/bar'
 *   normalizeVfsPath('../escape')          -> 'escape'  (bounded; doesn't go negative)
 */
export declare function normalizeVfsPath(p: string): string;
/** Resolve a user path against a VFS cwd and return a canonical VFS key. */
export declare function resolveVfsPath(path: string, cwd: string): string;
/** Return the canonical VFS parent key, or an empty string for root-level paths. */
export declare function parentVfsPath(path: string): string;
/** Strip leading slashes only — does not touch internal segments. */
export declare function stripLeadingSlashes(p: string): string;
//# sourceMappingURL=path.d.ts.map