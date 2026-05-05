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
 *   - SHOULD_SWAP(name)         → { from, to } | undefined           (W6)
 *   - SHOULD_REJECT_FAIL(name)  → { from, reason, suggest? } | undefined (W6)
 *   - SHOULD_WARN_SKIP_TRANSITIVE(name) → entry | undefined          (W6)
 *   - PARSE_SEMVER(v) → [major, minor, patch] | null
 *   - COMPARE_SEMVER(a, b) → number
 *   - SATISFIES_RANGE(version, range) → boolean
 *   - RESOLVE_VERSION(versions, range) → string | null
 *
 * All of these are pasted from src/npm-resolver.ts and src/wasm-swap-registry.ts
 * and MUST stay byte-equivalent. Divergence between supervisor and facet
 * resolution would mean the facet picks different versions / makes different
 * swap-or-reject decisions than the legacy in-supervisor path, breaking
 * both correctness and the NIMBUS_FACET_RESOLVER=0 fallback contract.
 *
 * The W6 registry data is duplicated below — gated by
 * `audit/probes/w6/functional/preamble-parity.mjs`.
 *
 * Preamble bytes are part of the loader-cache key for NimbusFacetPool —
 * any edit invalidates the warm slot and forces a re-load on next
 * dispatch. Acceptable cost for a one-shot resolver phase.
 */

export const NPM_RESOLVE_PREAMBLE: string = `
// ── Skip list (mirrors src/npm-resolver.ts SKIP_PACKAGES, post-W6+W11) ──
// W6: 'esbuild' migrated to WASM_SWAPS; 'fsevents' migrated to REJECT_INSTALL.
// W11: vite is exempted when frameworkAware=true so framework CLIs can
//      import('vite') from node_modules. See audit/sections/W11-plan.md §3.0.
const __SKIP_PACKAGES = new Set([
  'typescript', 'vite', 'rollup', 'webpack', 'parcel',
  'postcss', 'autoprefixer', 'tailwindcss', 'cssnano',
  'prettier', 'eslint', 'stylelint',
  'chokidar', 'node-gyp', 'node-pre-gyp',
  '@cloudflare/vite-plugin', '@cloudflare/workers-types', 'wrangler',
  'husky', 'lint-staged', 'commitlint',
]);
const __FRAMEWORK_REQUIRED_PACKAGES = new Set([
  'vite',
]);
const __SKIP_PREFIXES = [
  '@types/',
  '@eslint/',
  '@typescript-eslint/',
  'eslint-plugin-',
  'eslint-config-',
];
function SHOULD_SKIP_PACKAGE(name, frameworkAware) {
  if (frameworkAware && __FRAMEWORK_REQUIRED_PACKAGES.has(name)) return false;
  if (__SKIP_PACKAGES.has(name)) return true;
  for (const p of __SKIP_PREFIXES) if (name.startsWith(p)) return true;
  return false;
}

// ── W6 swap / reject registry (mirrors src/wasm-swap-registry.ts) ─────
// Gated by audit/probes/w6/functional/preamble-parity.mjs.
const __WASM_SWAPS = new Map([
  ['esbuild', { from: 'esbuild', to: 'esbuild-wasm' }],
]);
// Mirror of REJECT_INSTALL in src/wasm-swap-registry.ts. Entries with
// transitive='warn' are tagged so the resolver can decide skip-vs-throw.
const __REJECT_INSTALL = new Map([
  ['sharp',          { from: 'sharp',          reason: 'Native libvips bindings; not portable to Workers.', transitive: 'fail' }],
  ['sqlite3',        { from: 'sqlite3',        reason: 'Native sqlite3 .node binding.', transitive: 'fail' }],
  ['better-sqlite3', { from: 'better-sqlite3', reason: 'Native sqlite .node binding.', transitive: 'fail' }],
  ['canvas',         { from: 'canvas',         reason: 'Native Cairo bindings.', transitive: 'fail' }],
  ['sodium-native',  { from: 'sodium-native',  reason: 'Native libsodium.', transitive: 'fail' }],
  ['fsevents',       { from: 'fsevents',       reason: 'macOS-only filesystem watcher; never runs in Workers.', transitive: 'warn' }],
  ['bufferutil',     { from: 'bufferutil',     reason: 'Native binding for ws speedups; install requires node-gyp.', transitive: 'warn' }],
  ['utf-8-validate', { from: 'utf-8-validate', reason: 'Native binding for ws speedups; install requires node-gyp.', transitive: 'warn' }],
  ['node-pty',       { from: 'node-pty',       reason: 'PTY syscalls unavailable in workerd.', transitive: 'fail' }],
  ['robotjs',        { from: 'robotjs',        reason: 'Desktop automation; sandboxed Workers cannot access OS UI.', transitive: 'fail' }],
  ['electron',       { from: 'electron',       reason: 'Embedded Chromium runtime; not applicable to Workers.', transitive: 'fail' }],
  ['bcrypt',         { from: 'bcrypt',         reason: 'Native bcrypt; require() name differs from bcryptjs.', transitive: 'fail' }],
  ['argon2',         { from: 'argon2',         reason: 'Native Argon2 C bindings.', transitive: 'fail' }],
  ['node-sass',      { from: 'node-sass',      reason: 'Native libsass; deprecated upstream.', transitive: 'fail' }],
  ['grpc',           { from: 'grpc',           reason: 'Deprecated native gRPC.', transitive: 'fail' }],
  ['@swc/core',      { from: '@swc/core',      reason: 'Native Rust SWC.', transitive: 'fail' }],
  ['prisma',         { from: 'prisma',         reason: 'Native query engine; not portable to Workers in this configuration.', transitive: 'fail' }],
  ['@prisma/client', { from: '@prisma/client', reason: 'Native Prisma query engine.', transitive: 'fail' }],
  ['node-gyp',       { from: 'node-gyp',       reason: 'Build-time native compiler; never runs in Workers.', transitive: 'warn' }],
  ['node-pre-gyp',   { from: 'node-pre-gyp',   reason: 'Build-time native compiler; never runs in Workers.', transitive: 'warn' }],
  ['puppeteer',      { from: 'puppeteer',      reason: 'Bundled Chromium binary (~150 MB).', transitive: 'fail' }],
  ['playwright',     { from: 'playwright',     reason: 'Bundled browsers (~300 MB).', transitive: 'fail' }],
  ['sql.js',         { from: 'sql.js',         reason: 'Installs but fails at runtime: WASM artifact dist/sql-wasm.wasm not extracted (loader gap).', transitive: 'fail' }],
  ['@swc/wasm-web',  { from: '@swc/wasm-web',  reason: 'Installs but fails at runtime: file not pre-bundled in VFS (loader gap).', transitive: 'fail' }],
]);
function SHOULD_SWAP(name) {
  return __WASM_SWAPS.get(name);
}
function SHOULD_REJECT_FAIL(name) {
  const r = __REJECT_INSTALL.get(name);
  if (r && r.transitive === 'fail') return r;
  return undefined;
}
function SHOULD_WARN_SKIP_TRANSITIVE(name) {
  const r = __REJECT_INSTALL.get(name);
  if (r && r.transitive === 'warn') return r;
  return undefined;
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
