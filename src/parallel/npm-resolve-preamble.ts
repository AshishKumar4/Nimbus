/**
 * npm-resolve-preamble.ts — preamble injected into NimbusFacetPool isolates
 * that run src/npm-resolve-facet.ts.
 *
 * NimbusFacetPool serialises the user function via fn.toString() and runs
 * it inside a dynamic worker. Names referenced by the function at module
 * scope are NOT in that worker's lexical scope at runtime — they must be
 * re-declared in the preamble.
 *
 * The resolver-facet references the following preamble symbols:
 *   - SHOULD_SKIP_PACKAGE(name) → boolean
 *   - PARSE_SEMVER(v) → [major, minor, patch] | null
 *   - COMPARE_SEMVER(a, b) → number
 *   - SATISFIES_RANGE(version, range) → boolean
 *   - RESOLVE_VERSION(versions, range) → string | null
 *
 * All of these are pasted from src/npm-resolver.ts:79-202 / 717-748 and
 * MUST stay byte-equivalent. Divergence between supervisor and facet
 * resolution would mean the facet picks different versions than the
 * legacy in-supervisor path, breaking both correctness and the
 * NIMBUS_FACET_RESOLVER=0 fallback contract.
 *
 * Preamble bytes are part of the loader-cache key for NimbusFacetPool —
 * any edit invalidates the warm slot and forces a re-load on next
 * dispatch. Acceptable cost for a one-shot resolver phase.
 */

export const NPM_RESOLVE_PREAMBLE: string = `
// ── Skip list (pasted from src/npm-resolver.ts:719-742) ──────────────────
const __SKIP_PACKAGES = new Set([
  'typescript', 'esbuild', 'vite', 'rollup', 'webpack', 'parcel',
  'postcss', 'autoprefixer', 'tailwindcss', 'cssnano',
  'prettier', 'eslint', 'stylelint',
  'fsevents', 'chokidar', 'node-gyp', 'node-pre-gyp',
  '@cloudflare/vite-plugin', '@cloudflare/workers-types', 'wrangler',
  'husky', 'lint-staged', 'commitlint',
]);
const __SKIP_PREFIXES = [
  '@types/',
  '@eslint/',
  '@typescript-eslint/',
  'eslint-plugin-',
  'eslint-config-',
];
function SHOULD_SKIP_PACKAGE(name) {
  if (__SKIP_PACKAGES.has(name)) return true;
  for (const p of __SKIP_PREFIXES) if (name.startsWith(p)) return true;
  return false;
}

// ── Semver helpers (pasted from src/npm-resolver.ts:83-202) ─────────────
function PARSE_SEMVER(v) {
  const m = v.replace(/^v/, '').match(/^(\\d+)\\.(\\d+)\\.(\\d+)/);
  return m ? [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])] : null;
}

function COMPARE_SEMVER(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function __SATISFIES_COMPARATOR(version, comparator) {
  const comp = comparator.trim();
  if (!comp || comp === '*' || comp === 'latest' || comp === '' || comp === 'x') return true;
  let op = '';
  let rangeStr = comp;
  const prefixMatch = comp.match(/^([~^]|>=|<=|>|<|=)\\s*/);
  if (prefixMatch) {
    op = prefixMatch[1];
    rangeStr = comp.slice(prefixMatch[0].length);
  }
  rangeStr = rangeStr.replace(/\\.x/g, '.0');
  if (rangeStr.match(/^\\d+$/)) rangeStr += '.0.0';
  else if (rangeStr.match(/^\\d+\\.\\d+$/)) rangeStr += '.0';
  const vParts = PARSE_SEMVER(version);
  const rParts = PARSE_SEMVER(rangeStr);
  if (!vParts || !rParts) return false;
  const cmp = COMPARE_SEMVER(vParts, rParts);
  switch (op) {
    case '^': {
      if (rParts[0] > 0) {
        return vParts[0] === rParts[0] && cmp >= 0;
      }
      if (rParts[1] > 0) {
        return vParts[0] === 0 && vParts[1] === rParts[1] && cmp >= 0;
      }
      return vParts[0] === 0 && vParts[1] === 0 && vParts[2] === rParts[2];
    }
    case '~': {
      return vParts[0] === rParts[0] && vParts[1] === rParts[1] && vParts[2] >= rParts[2];
    }
    case '>=': return cmp >= 0;
    case '>':  return cmp > 0;
    case '<=': return cmp <= 0;
    case '<':  return cmp < 0;
    case '=':  return cmp === 0;
    default: {
      if (comp.match(/^\\d/)) {
        return cmp === 0;
      }
      return cmp === 0;
    }
  }
}

function SATISFIES_RANGE(version, range) {
  const trimmed = range.trim();
  if (!trimmed || trimmed === '*' || trimmed === 'latest' || trimmed === '') return true;
  const orParts = trimmed.split(/\\s*\\|\\|\\s*/);
  for (const orPart of orParts) {
    const hyphen = orPart.match(/^(\\S+)\\s+-\\s+(\\S+)$/);
    if (hyphen) {
      if (__SATISFIES_COMPARATOR(version, '>=' + hyphen[1]) &&
          __SATISFIES_COMPARATOR(version, '<=' + hyphen[2])) {
        return true;
      }
      continue;
    }
    const andParts = orPart.trim().split(/\\s+/);
    const allMatch = andParts.every((part) => __SATISFIES_COMPARATOR(version, part));
    if (allMatch) return true;
  }
  return false;
}

function RESOLVE_VERSION(versions, range) {
  if (!range || range === 'latest' || range === '*' || range === '') return null;
  const matching = versions.filter((v) => {
    if (v.includes('-') && !range.includes('-')) return false;
    return SATISFIES_RANGE(v, range);
  });
  if (matching.length === 0) return null;
  matching.sort((a, b) => {
    const ap = PARSE_SEMVER(a);
    const bp = PARSE_SEMVER(b);
    if (!ap || !bp) return 0;
    return COMPARE_SEMVER(bp, ap);
  });
  return matching[0];
}
// ── end npm-resolve preamble ────────────────────────────────────────────
`;
