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
export function parseSemver(v: string): ParsedSemver | null {
  const m = String(v).trim().replace(/^[v=]+/, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  const prerelease: Array<string | number> = m[4] === undefined
    ? []
    : m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id));
  return [Number(m[1]), Number(m[2]), Number(m[3]), prerelease];
}

/**
 * Total order. A release sorts above every prerelease of the same triple;
 * prerelease identifiers compare left to right, numeric before alphanumeric,
 * numeric by value, alphanumeric lexically, and a longer list sorts above
 * its prefix (semver.org §11).
 */
export function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  if (a[2] !== b[2]) return a[2] - b[2];
  const ap = a[3] ?? [];
  const bp = b[3] ?? [];
  if (ap.length === 0 && bp.length === 0) return 0;
  if (ap.length === 0) return 1;
  if (bp.length === 0) return -1;
  const n = Math.min(ap.length, bp.length);
  for (let i = 0; i < n; i++) {
    const x = ap[i];
    const y = bp[i];
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return ap.length - bp.length;
}

/**
 * One comparator set (the space-separated part of a range) as
 * `>=lower <upper` bounds. Every range shape npm uses normalises to at
 * most two bounds, so a set is a list of `[op, version]` pairs.
 */
export function semverComparators(part: string): Array<[string, ParsedSemver]> | null {
  const comp = part.trim();
  if (comp === '' || comp === '*' || comp === 'x' || comp === 'X' || comp === 'latest') return [];
  const m = comp.match(/^(\^|~>?|>=|<=|>|<|=)?\s*v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  const op = m[1] === '~>' ? '~' : (m[1] ?? '');
  const wild = (s: string | undefined): boolean => s === undefined || s === 'x' || s === 'X' || s === '*';
  const majorWild = wild(m[2]);
  const minorWild = wild(m[3]);
  const patchWild = wild(m[4]);
  const major = majorWild ? 0 : Number(m[2]);
  const minor = minorWild ? 0 : Number(m[3]);
  const patch = patchWild ? 0 : Number(m[4]);
  const pre: Array<string | number> = m[5] === undefined || patchWild
    ? []
    : m[5].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id));
  const lower: ParsedSemver = [major, minor, patch, pre];
  const ge = (): Array<[string, ParsedSemver]> => [['>=', lower]];
  const upto = (u: ParsedSemver): Array<[string, ParsedSemver]> => [['>=', lower], ['<', u]];
  // X-ranges: `*`, `1`, `1.2`, `1.x`, `1.2.x` — an op in front is applied to
  // the lowest version the X-range names (`>=1.2` is `>=1.2.0`, `<1.x` is `<1.0.0`).
  if (majorWild) return [];
  if (minorWild) {
    if (op === '' || op === '^' || op === '~' || op === '=') return upto([major + 1, 0, 0, []]);
    return op === '<=' ? [['<', [major + 1, 0, 0, []]]] : [[op, lower]];
  }
  if (patchWild) {
    if (op === '' || op === '~' || op === '=') return upto([major, minor + 1, 0, []]);
    if (op === '^') return upto(major === 0 ? [0, minor + 1, 0, []] : [major + 1, 0, 0, []]);
    return op === '<=' ? [['<', [major, minor + 1, 0, []]]] : [[op, lower]];
  }
  switch (op) {
    case '^':
      if (major > 0) return upto([major + 1, 0, 0, []]);
      if (minor > 0) return upto([0, minor + 1, 0, []]);
      return upto([0, 0, patch + 1, []]);
    case '~':
      return upto([major, minor + 1, 0, []]);
    case '':
    case '=':
      return [['=', lower]];
    default:
      return [[op, lower]];
  }
}

/**
 * node-semver's prerelease rule: a prerelease version satisfies a comparator
 * set only when some comparator in that set names a prerelease of the same
 * `major.minor.patch`. `^1.0.0-next.24` admits `1.0.0-next.29` and `1.0.0`,
 * never `1.1.0-rc.1`; `^1.0.0` admits no prerelease at all.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseSemver(version);
  if (!v) return false;
  const trimmed = String(range).trim();
  if (trimmed === '' || trimmed === '*' || trimmed === 'x' || trimmed === 'latest') return v[3].length === 0;
  for (const orPart of trimmed.split(/\s*\|\|\s*/)) {
    let comparators: Array<[string, ParsedSemver]> | null = [];
    const hyphen = orPart.trim().match(/^(\S+)\s+-\s+(\S+)$/);
    if (hyphen) {
      const lo = semverComparators('>=' + hyphen[1]);
      const hi = semverComparators('<=' + hyphen[2]);
      comparators = lo && hi ? [...lo, ...hi] : null;
    } else {
      for (const part of orPart.trim().split(/\s+/)) {
        const c = semverComparators(part);
        if (c === null) { comparators = null; break; }
        comparators.push(...c);
      }
    }
    if (comparators === null) continue;
    let ok = true;
    for (const [op, r] of comparators) {
      const cmp = compareSemver(v, r);
      if (op === '>=' ? cmp < 0 : op === '>' ? cmp <= 0 : op === '<=' ? cmp > 0 : op === '<' ? cmp >= 0 : cmp !== 0) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (v[3].length > 0) {
      const admitted = comparators.some(([, r]) =>
        r[3].length > 0 && r[0] === v[0] && r[1] === v[1] && r[2] === v[2]);
      if (!admitted) continue;
    }
    return true;
  }
  return false;
}

/**
 * Whether `range` is semver-shaped at all — `''`, `*`, `latest`, tags,
 * comparators, hyphen ranges, `||` groups. False for git:, github:,
 * URL, file:, and other non-registry specifiers, where a version pin's
 * presence is all a lockfile can answer.
 */
export function isSemverRange(range: string): boolean {
  const trimmed = String(range).trim();
  if (trimmed === '' || trimmed === '*' || trimmed === 'x' || trimmed === 'X' || trimmed === 'latest') return true;
  for (const orPart of trimmed.split(/\s*\|\|\s*/)) {
    const hyphen = orPart.trim().match(/^(\S+)\s+-\s+(\S+)$/);
    if (hyphen) {
      const lo = semverComparators('>=' + hyphen[1]);
      const hi = semverComparators('<=' + hyphen[2]);
      if (lo === null || hi === null) return false;
      continue;
    }
    for (const part of orPart.trim().split(/\s+/)) {
      if (semverComparators(part) === null) return false;
    }
  }
  return true;
}

/** The highest version satisfying `range`, or null; `latest`/`*` are the caller's dist-tag lookup. */
export function resolveVersion(versions: readonly string[], range: string): string | null {
  const trimmed = String(range ?? '').trim();
  if (trimmed === '' || trimmed === '*' || trimmed === 'x' || trimmed === 'X' || trimmed === 'latest') return null;
  let best: { v: string; p: ParsedSemver } | null = null;
  for (const v of versions) {
    if (!satisfiesRange(v, trimmed)) continue;
    const p = parseSemver(v);
    if (!p) continue;
    if (best === null || compareSemver(p, best.p) > 0) best = { v, p };
  }
  return best === null ? null : best.v;
}
