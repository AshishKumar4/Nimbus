/**
 * The names of `path` once it is resolved lexically: empty names and `.`
 * dropped, each `..` taking back the name before it, and a `..` at the root
 * staying at the root, as POSIX resolves `/..`. The one root-clamped lexical
 * reduction; whether the path was absolute, ended in `/`, or is joined to a
 * base is its caller's to keep. Lexical only: a `..` after a symlink is not
 * the link's parent, so a walk that follows links resolves it as it goes.
 */
export declare function rootClampedSegments(path: string): string[];
//# sourceMappingURL=lexical-path.d.ts.map