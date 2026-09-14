/**
 * npm/semver.ts — the one semver implementation the npm resolver picks
 * versions with.
 *
 * The resolver facet (npm/resolve-one-facet.ts) runs inside a dynamic worker
 * whose only module scope is the preamble string in
 * loaders/npm-resolve-preamble.ts. That preamble embeds THESE functions by
 * `fn.toString()`, so the facet's version pick is this module's by
 * construction — there is no second copy to drift, and
 * tests/unit/npm-semver.mjs asserts the embedded functions answer exactly
 * as the exported ones do.
 *
 * Every function here is self-contained on purpose: no closures over module
 * constants, no imports, only calls to the other functions in this file by
 * name. `toString()` reproduces exactly that, and nothing else.
 *
 * What is implemented is the subset of node-semver that npm dependency
 * ranges use: exact versions, `^`, `~`, comparators, hyphen ranges, `||`,
 * X-ranges (`1`, `1.2`, `1.x`, `*`), and — the part the previous helper
 * lacked — prerelease identifiers. Ignoring them meant every `1.0.0-*`
 * compared equal, so `json-server@1.0.0-beta.15` resolved to whichever
 * `1.0.0-*` the packument listed first (`1.0.0-alpha.1`) and
 * `^1.0.0-next.24` picked `1.0.0-next.0`. Measured against the live registry
 * lists before this rewrite.
 */
/** `[major, minor, patch, prerelease]` — prerelease is `[]` for a release. */
export type ParsedSemver = [number, number, number, Array<string | number>];
/** Parse `v1.2.3-beta.4+build` → `[1, 2, 3, ['beta', 4]]`; null for a non-version. */
export declare function parseSemver(v: string): ParsedSemver | null;
/**
 * Total order. A release sorts above every prerelease of the same triple;
 * prerelease identifiers compare left to right, numeric before alphanumeric,
 * numeric by value, alphanumeric lexically, and a longer list sorts above
 * its prefix (semver.org §11).
 */
export declare function compareSemver(a: ParsedSemver, b: ParsedSemver): number;
/**
 * One comparator set (the space-separated part of a range) as
 * `>=lower <upper` bounds. Every range shape npm uses normalises to at
 * most two bounds, so a set is a list of `[op, version]` pairs.
 */
export declare function semverComparators(part: string): Array<[string, ParsedSemver]> | null;
/**
 * node-semver's prerelease rule: a prerelease version satisfies a comparator
 * set only when some comparator in that set names a prerelease of the same
 * `major.minor.patch`. `^1.0.0-next.24` admits `1.0.0-next.29` and `1.0.0`,
 * never `1.1.0-rc.1`; `^1.0.0` admits no prerelease at all.
 */
export declare function satisfiesRange(version: string, range: string): boolean;
/** The highest version satisfying `range`, or null; `latest`/`*` are the caller's dist-tag lookup. */
export declare function resolveVersion(versions: readonly string[], range: string): string | null;
//# sourceMappingURL=semver.d.ts.map