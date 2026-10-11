/**
 * A package's `bin` field as npm installs it (npm-normalize-package-bin).
 *
 * A `bin` map comes from a registry, an installed package.json or a bin
 * manifest: files and answers anyone may write. Every name a command is
 * linked, written, listed or removed under, and every target it runs, goes
 * through here, so no `bin` map reaches a file outside the bin directory or
 * runs one outside its package.
 */
/**
 * The name a `bin` key links under: its last path component, with `\` and
 * `:` read as separators. Null for a key that names nothing ('', '.', '..').
 */
export declare function npmBinName(key: string): string | null;
/**
 * Name -> target relative to the package. A string `bin` links under the
 * package's own name (none without one), each key under {@link npmBinName}, and each target is
 * a path inside the package, `..` stopping at its root (`\\` read as `/`).
 * A plain relative path, such as a staged-artifact sentinel, is unchanged.
 */
export declare function npmBinMap(packageName: string, bin: unknown): Map<string, string>;
/**
 * A package.json's `bin` as npm writes it back (@npmcli/package-json 6.2.0
 * normalizePackageBin, which `npm init` and `npm pkg fix` run), in place on
 * `pkg`: a string under the package's name, an array's entries under their
 * base names, then each entry under {@link npmBinName}'s name for its key
 * (moved to the end when that renames it, as npm's delete and set do) and a
 * target inside the package, `\` and `:` read as `/`. An entry that is not
 * a string, or names nothing, is dropped, and a `bin` left empty, or of no
 * kind npm reads, is deleted.
 */
export declare function normalizePackageJsonBin(pkg: Record<string, unknown>): void;
//# sourceMappingURL=npm-bin-map.d.ts.map