/** `[major, minor, patch, prerelease]` — prerelease is `[]` for a release. */
export type ParsedSemver = [number, number, number, Array<string | number>];
/** Parse `v1.2.3-beta.4+build` → `[1, 2, 3, ['beta', 4]]`; null for a non-version. */
export declare function parseSemver(v: string): ParsedSemver | null;
/** semver's order of two parsed versions: negative, zero or positive. */
export declare function compareSemver(a: ParsedSemver, b: ParsedSemver): number;
/**
 * Whether `version` satisfies `range`, as semver answers (a prerelease only
 * for a comparator on its own `major.minor.patch`); an open range is `*`.
 */
export declare function satisfiesRange(version: string, range: string): boolean;
/** Whether `a` is a version at least `b`, loosely (an unparsable one is not). */
export declare function versionAtLeast(a: string, b: string): boolean;
/** Whether some version both ranges allow (semver.intersects, loose). */
export declare function rangesIntersect(a: string, b: string): boolean;
/** Whether every version `inner` allows, `outer` allows too (semver.subset, loose). */
export declare function rangeSubset(inner: string, outer: string): boolean;
/** Whether `spec` is one exact version (`1.2.3`), not a range or a tag. */
export declare function isExactVersion(spec: string): boolean;
/**
 * Whether `range` is a semver range at all (an open one included). False
 * for git:, github:, a URL, file:, a dist-tag, and other non-range specs,
 * where a version pin's presence is all a lockfile can answer.
 */
export declare function isSemverRange(range: string): boolean;
/**
 * The version a registry request for `range` installs, from a packument's
 * `versions` and `dist-tags`: an exact version it publishes; else the
 * highest satisfying a range; else the dist-tag `range` names; else, for an
 * open range or a spec that is neither a range nor a tag name (`github:…`,
 * a URL, `file:…`), `latest`. Null when none answers: a range nothing
 * satisfies, or a tag the package does not publish, as npm answers both
 * (ETARGET).
 */
export declare function pickPackumentVersion(versions: unknown, distTags: unknown, range: string | null | undefined): string | null;
/**
 * The version a request for a package Nimbus stages builds of installs
 * (`staged`: its staged versions, oldest first): the newest staged for an
 * open range, else the highest staged the range admits; null where it admits
 * none, and the request installs as any other (pickInstalledVersion).
 */
export declare function stagedBindingVersion(staged: readonly string[], range: string | null | undefined): string | null;
/**
 * The version a registry request installs, as every npm here installs it:
 * the staged version the range takes (stagedBindingVersion), where the
 * packument publishes it; else pickPackumentVersion's.
 */
export declare function pickInstalledVersion(versions: unknown, distTags: unknown, range: string | null | undefined, staged?: readonly string[]): string | null;
/** The highest version satisfying `range`, or null; an open range is the caller's dist-tag lookup. */
export declare function resolveVersion(versions: readonly string[], range: string): string | null;
//# sourceMappingURL=npm-semver.d.ts.map