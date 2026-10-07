/**
 * npm-semver.ts — versions as every npm here reads them: npm's own semver,
 * loose as npm-pick-manifest calls it, behind the few adapters the worker's
 * installer and resolver facet and the shell's fallback npm use.
 *
 * The resolver facet (worker npm/resolve-one-facet.ts) runs inside a dynamic
 * worker whose only module scope is the preamble in worker
 * loaders/npm-resolve-preamble.ts. The build bundles this module, with
 * semver, into that preamble (worker scripts/bundle-facet-workers.mjs, npm
 * resolve libs), so the facet's version pick is this module's by
 * construction.
 *
 * Two policies are Nimbus's own, deliberately:
 *   - a range resolves to the HIGHEST version satisfying it, where
 *     npm-pick-manifest prefers the `latest` dist-tag when it satisfies the
 *     range (resolveVersion, pickPackumentVersion);
 *   - an open range (none, `*`, `x`, `latest`) answers no version from the
 *     list: the caller reads the dist-tag (resolveVersion's null), as the
 *     resolver's staged versions do.
 */
import semver from 'semver';
/** npm-pick-manifest's options for reading registry versions and ranges. */
const LOOSE = { loose: true };
/** The ranges that name no version: the dist-tag decides. */
const OPEN_RANGES = new Set(['', '*', 'x', 'X', 'latest']);
/** Parse `v1.2.3-beta.4+build` → `[1, 2, 3, ['beta', 4]]`; null for a non-version. */
export function parseSemver(v) {
    const parsed = semver.parse(String(v), LOOSE);
    return parsed === null ? null : [parsed.major, parsed.minor, parsed.patch, [...parsed.prerelease]];
}
/** semver's order of two parsed versions: negative, zero or positive. */
export function compareSemver(a, b) {
    return semver.compare(formatSemver(a), formatSemver(b), LOOSE);
}
function formatSemver([major, minor, patch, prerelease]) {
    return `${major}.${minor}.${patch}${prerelease.length > 0 ? `-${prerelease.join('.')}` : ''}`;
}
/**
 * Whether `version` satisfies `range`, as semver answers (a prerelease only
 * for a comparator on its own `major.minor.patch`); an open range is `*`.
 */
export function satisfiesRange(version, range) {
    const trimmed = String(range).trim();
    return semver.satisfies(String(version), OPEN_RANGES.has(trimmed) ? '*' : trimmed, LOOSE);
}
/**
 * Whether `range` is a semver range at all (an open one included). False
 * for git:, github:, a URL, file:, a dist-tag, and other non-range specs,
 * where a version pin's presence is all a lockfile can answer.
 */
export function isSemverRange(range) {
    const trimmed = String(range).trim();
    return OPEN_RANGES.has(trimmed) || semver.validRange(trimmed, LOOSE) !== null;
}
/**
 * The version a registry request for `range` installs, from a packument's
 * `versions` and `dist-tags`: an exact version it publishes; else the
 * highest satisfying a range; else the dist-tag `range` names; else, for an
 * open range or a spec that is neither a range nor a tag name (`github:…`,
 * a URL, `file:…`), `latest`. Null when none answers: a range nothing
 * satisfies, or a tag the package does not publish, as npm answers both
 * (ETARGET).
 */
export function pickPackumentVersion(versions, distTags, range) {
    // A packument is the registry's JSON: read only its own properties.
    const own = (record, key) => record !== null && typeof record === 'object' && Object.prototype.hasOwnProperty.call(record, key)
        ? Reflect.get(record, key)
        : undefined;
    const requested = range === null || range === undefined ? '' : String(range);
    if (requested && own(versions, requested) !== undefined)
        return requested;
    let picked = null;
    if (requested && requested !== 'latest' && versions !== null && typeof versions === 'object') {
        picked = resolveVersion(Object.keys(versions), requested);
    }
    if (picked === null) {
        const tagged = own(distTags, requested);
        if (typeof tagged === 'string')
            picked = tagged;
    }
    const open = OPEN_RANGES.has(requested.trim());
    // npm-package-arg's tag: no range, and nothing a URL would escape.
    const tagName = !isSemverRange(requested) && encodeURIComponent(requested) === requested;
    if (picked === null && (open || (!isSemverRange(requested) && !tagName))) {
        const latest = own(distTags, 'latest');
        if (typeof latest === 'string')
            picked = latest;
    }
    return picked;
}
/** The highest version satisfying `range`, or null; an open range is the caller's dist-tag lookup. */
export function resolveVersion(versions, range) {
    const trimmed = String(range ?? '').trim();
    if (OPEN_RANGES.has(trimmed))
        return null;
    return semver.maxSatisfying([...versions], trimmed, LOOSE);
}
