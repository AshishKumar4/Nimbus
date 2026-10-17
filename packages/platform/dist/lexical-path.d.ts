/**
 * The names of `path` once it is resolved lexically, after the names of
 * `base` (taken as they are, not reduced again): empty names and `.`
 * dropped, each `..` taking back the name before it, and a `..` at the root
 * staying at the root, as POSIX resolves `/..`. The one root-clamped lexical
 * reduction; whether the path was absolute or ended in `/` is its caller's to
 * keep. Lexical only: a `..` after a symlink is not the link's parent, so a
 * walk that follows links resolves it as it goes.
 */
export declare function rootClampedSegments(path: string, base?: readonly string[]): string[];
//# sourceMappingURL=lexical-path.d.ts.map