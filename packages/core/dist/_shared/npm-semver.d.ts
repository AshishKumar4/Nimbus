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
/** The highest version satisfying `range`, or null; an open range is the caller's dist-tag lookup. */
export declare function resolveVersion(versions: readonly string[], range: string): string | null;
//# sourceMappingURL=npm-semver.d.ts.map