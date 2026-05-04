/**
 * W6 — WASM swap + REJECT_INSTALL registry.
 *
 * The contract:
 *   - WASM_SWAPS    : name→name rewrite at the resolver/installer boundary.
 *                     Only `compat: 'drop-in'` swaps qualify (the consumer's
 *                     `require()` call site works unchanged). Different-
 *                     require-name candidates (bcrypt → bcryptjs, argon2 →
 *                     hash-wasm, …) are NOT swaps until the resolver supports
 *                     `npm:` aliases. They live in REJECT_INSTALL with a
 *                     code-change suggestion.
 *
 *   - REJECT_INSTALL: deny list with helpful messages. Each entry has a
 *                     per-entry `transitive` policy:
 *                       'fail' = hard-fail at any depth (top + transitive).
 *                       'warn' = top-level fails; transitive logs `[skip]`
 *                                and continues (matches the existing
 *                                `shouldSkipPackage` UX for build-only).
 *
 * IMPORTANT: This module is the single source of truth in the supervisor
 * isolate. The same data is *duplicated* into
 * `src/parallel/npm-resolve-preamble.ts` because that preamble is shipped
 * into NimbusFacetPool isolates as a string (cannot `import`). The
 * `audit/probes/w6/functional/preamble-parity.mjs` snapshot test gates
 * the duplication.
 *
 * See `audit/sections/W6-plan.md` §3.
 */

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export interface SwapEntry {
  /** Original package name the user (or a transitive dep) asked for. */
  from: string;
  /** Package name we install instead. */
  to: string;
  /** One-line reason shown to the user. */
  reason: string;
  /**
   * 'drop-in' = `require(from)` and `require(to)` work identically — same
   *             export shape. (Only kind W6 v2 supports.)
   * 'shim'    = (reserved) we write package.json `dependencies` so consumer
   *             imports `from`, gets `to`. Requires npm-alias parser (W6.5).
   * 'manual'  = (reserved) consumer code change required. Demoted to
   *             REJECT_INSTALL in W6 v2 — listing it as 'manual' here would
   *             silently break user code.
   */
  compat: 'drop-in' | 'shim' | 'manual';
}

export interface RejectEntry {
  from: string;
  /** Helpful one-liner. Always actionable. */
  reason: string;
  /** Optional swap-target suggestion shown inline. */
  suggest?: string;
  /**
   * 'fail' = hard-fail at any depth.
   * 'warn' = top-level hard-fails; transitive logs `[skip]` and drops the
   *          package from the resolved tree (matches existing
   *          `shouldSkipPackage` semantics for genuinely-optional natives
   *          like fsevents).
   */
  transitive: 'fail' | 'warn';
}

// ─────────────────────────────────────────────────────────────────────────
// Registries
// ─────────────────────────────────────────────────────────────────────────

export const WASM_SWAPS: ReadonlyArray<SwapEntry> = [
  // Different-require-name candidates (bcrypt → bcryptjs, argon2 →
  // hash-wasm, node-sass → sass, grpc → @grpc/grpc-js, @swc/core →
  // @swc/wasm-web) are intentionally NOT here. Without npm-alias
  // support, swapping them would silently break the user's
  // `require(originalName)` call site. They are in REJECT_INSTALL
  // with a code-change suggestion. Tracked as W6.5 to add alias
  // support. See plan §2 + §10.
  {
    from: 'esbuild',
    to: 'esbuild-wasm',
    reason:
      'Native esbuild not available in Workers; esbuild-wasm exposes the same build/transform/version/initialize API.',
    compat: 'drop-in',
  },
];

export const REJECT_INSTALL: ReadonlyArray<RejectEntry> = [
  // ── Same-require-name natives that crash at load time ────────────────
  {
    from: 'sharp',
    reason: 'Native libvips bindings; not portable to Workers.',
    suggest: 'no Workers-compatible swap; render server-side and ship pixels.',
    transitive: 'fail',
  },
  {
    from: 'sqlite3',
    reason: 'Native sqlite3 .node binding.',
    suggest: 'better-sqlite3-wasm or sql.js (after W6.5 loader fix).',
    transitive: 'fail',
  },
  {
    from: 'better-sqlite3',
    reason: 'Native sqlite .node binding.',
    suggest: 'better-sqlite3-wasm or @libsql/client (after W6.5 loader fix).',
    transitive: 'fail',
  },
  {
    from: 'canvas',
    reason: 'Native Cairo bindings.',
    suggest: 'no Workers-compatible swap; render server-side and ship pixels.',
    transitive: 'fail',
  },
  {
    from: 'sodium-native',
    reason: 'Native libsodium.',
    suggest: 'tweetnacl (pure JS) or libsodium-wrappers (WASM).',
    transitive: 'fail',
  },
  {
    from: 'fsevents',
    reason: 'macOS-only filesystem watcher; never runs in Workers.',
    suggest:
      'optional dep — chokidar/watchpack work without it. Move to optionalDependencies in your package.json.',
    transitive: 'warn',
  },
  {
    from: 'bufferutil',
    reason: 'Native binding for ws speedups; install requires node-gyp.',
    suggest: 'optional dep — ws works without it (slower frames). Move to optionalDependencies.',
    transitive: 'warn',
  },
  {
    from: 'utf-8-validate',
    reason: 'Native binding for ws speedups; install requires node-gyp.',
    suggest: 'optional dep — same as bufferutil.',
    transitive: 'warn',
  },
  {
    from: 'node-pty',
    reason: 'PTY syscalls unavailable in workerd.',
    suggest: 'use the Nimbus built-in shell.',
    transitive: 'fail',
  },
  {
    from: 'robotjs',
    reason: 'Desktop automation; sandboxed Workers cannot access OS UI.',
    suggest: 'no Workers-compatible target.',
    transitive: 'fail',
  },
  {
    from: 'electron',
    reason: 'Embedded Chromium runtime; not applicable to Workers.',
    suggest: 'no Workers-compatible target.',
    transitive: 'fail',
  },

  // ── Different-require-name natives (would be swaps with alias support) ─
  {
    from: 'bcrypt',
    reason:
      'Native bcrypt; pure-JS bcryptjs has identical sync API but the require() name differs and Nimbus does not yet support `npm:` aliases.',
    suggest:
      'change `require("bcrypt")` to `require("bcryptjs")`, then `npm install bcryptjs`. APIs are sync-compatible.',
    transitive: 'fail',
  },
  {
    from: 'argon2',
    reason: 'Native Argon2 C bindings.',
    suggest:
      'hash-wasm (argon2d/argon2i/argon2id; verified — see audit/probes/wasm/hash-wasm.out.txt).',
    transitive: 'fail',
  },
  {
    from: 'node-sass',
    reason: 'Native libsass; deprecated upstream.',
    suggest: 'sass (dart-sass, pure JS).',
    transitive: 'fail',
  },
  {
    from: 'grpc',
    reason: 'Deprecated native gRPC.',
    suggest: '@grpc/grpc-js (pure JS).',
    transitive: 'fail',
  },
  {
    from: '@swc/core',
    reason: 'Native Rust SWC.',
    suggest: '@swc/wasm-web (transform/parse only; no Plugin API; loader gap pending W6.5).',
    transitive: 'fail',
  },

  // ── ORM natives ──────────────────────────────────────────────────────
  {
    from: 'prisma',
    reason: 'Native query engine; not portable to Workers in this configuration.',
    suggest:
      '@prisma/adapter-d1 (Prisma official Workers adapter), or migrate to drizzle-orm + @libsql/client.',
    transitive: 'fail',
  },
  {
    from: '@prisma/client',
    reason: 'Same as `prisma`.',
    suggest:
      '@prisma/adapter-d1 (Prisma official Workers adapter), or drizzle-orm + @libsql/client.',
    transitive: 'fail',
  },

  // ── Build-time native compilers (always wrong in Workers) ───────────
  {
    from: 'node-gyp',
    reason: 'Build-time native compiler; never runs in Workers.',
    suggest: 'remove from dependencies — Nimbus pre-skips build-only tools transitively.',
    transitive: 'warn',
  },
  {
    from: 'node-pre-gyp',
    reason: 'Build-time native compiler; never runs in Workers.',
    suggest: 'remove from dependencies.',
    transitive: 'warn',
  },

  // ── Bundled-binary giants ──────────────────────────────────────────
  {
    from: 'puppeteer',
    reason: 'Bundled Chromium binary (~150 MB).',
    suggest: 'puppeteer-core + Cloudflare Browser Rendering.',
    transitive: 'fail',
  },
  {
    from: 'playwright',
    reason: 'Bundled browsers (~300 MB).',
    suggest: '@playwright/test against a remote browser endpoint.',
    transitive: 'fail',
  },

  // ── Loader-gap honesty (install OK; runtime FAIL today) ─────────────
  // These come out of REJECT once the W6.5 loader work lands.
  {
    from: 'sql.js',
    reason:
      'Installs but fails at runtime: WASM artifact `dist/sql-wasm.wasm` not extracted by Nimbus today (loader gap).',
    suggest: 'tracked as W6.5 — extraction filter for `dist/*.wasm`.',
    transitive: 'fail',
  },
  {
    from: '@swc/wasm-web',
    reason: 'Installs but fails at runtime: file not pre-bundled in VFS today (loader gap).',
    suggest: 'tracked as W6.5 — VFS pre-bundle wiring.',
    transitive: 'fail',
  },
];

// ─────────────────────────────────────────────────────────────────────────
// Lookup API
// ─────────────────────────────────────────────────────────────────────────

const _swapByFrom: ReadonlyMap<string, SwapEntry> = new Map(
  WASM_SWAPS.map((e) => [e.from, e]),
);

const _rejectByFrom: ReadonlyMap<string, RejectEntry> = new Map(
  REJECT_INSTALL.map((e) => [e.from, e]),
);

export function lookupSwap(name: string): SwapEntry | undefined {
  return _swapByFrom.get(name);
}

export function lookupReject(name: string): RejectEntry | undefined {
  return _rejectByFrom.get(name);
}

/**
 * Pure: return a new specs map with every WASM_SWAPS.from key rewritten
 * to its swap target. Records the swaps actually performed.
 *
 * Idempotent: running on already-swapped specs is a no-op.
 *
 * Range carry-over: the original spec range is preserved on the new key.
 * (Future W6.5 may want 'latest' to force pulling the current swap-target
 * version, but for now we honour the user's intent.)
 */
export function applySwaps(
  specs: Record<string, string>,
): { specs: Record<string, string>; swaps: SwapEntry[] } {
  const out: Record<string, string> = {};
  const swaps: SwapEntry[] = [];
  for (const [name, range] of Object.entries(specs)) {
    const swap = _swapByFrom.get(name);
    if (swap) {
      out[swap.to] = range;
      swaps.push(swap);
    } else {
      out[name] = range;
    }
  }
  return { specs: out, swaps };
}

/**
 * Return rejects whose policy applies at this depth.
 *   ctx='top'        → all matching rejects (any policy).
 *   ctx='transitive' → only `transitive: 'fail'` rejects (the 'warn'
 *                      policy is handled by the caller as a `[skip]`
 *                      log + continue).
 */
export function findRejects(
  specs: Record<string, string>,
  ctx: 'top' | 'transitive',
): RejectEntry[] {
  const out: RejectEntry[] = [];
  for (const name of Object.keys(specs)) {
    const r = _rejectByFrom.get(name);
    if (!r) continue;
    if (ctx === 'transitive' && r.transitive !== 'fail') continue;
    out.push(r);
  }
  return out;
}

/**
 * Lookup that the resolver uses at depth>0 to decide between throw and
 * `[skip]`+continue. Returns the entry only when its policy is 'warn'
 * (i.e., this is a transitive-skip case). 'fail' entries return undefined
 * here; the caller handles those via findRejects/throw.
 */
export function shouldWarnSkipTransitive(name: string): RejectEntry | undefined {
  const r = _rejectByFrom.get(name);
  if (r && r.transitive === 'warn') return r;
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────

const ANSI_RED = '\x1b[31m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_DIM = '\x1b[2m';
const ANSI_RESET = '\x1b[0m';

/**
 * Single-line yellow notice emitted to onProgress when a swap fires.
 *   `[npm] [swap] esbuild → esbuild-wasm (Native esbuild not available …)`
 */
export function formatSwapNotice(s: SwapEntry): string {
  return `[npm] ${ANSI_YELLOW}[swap]${ANSI_RESET} ${s.from} → ${s.to} (${s.reason})`;
}

/**
 * Multi-line red error thrown when one or more top-level rejects fire.
 * Includes a leading summary line and a `try:` suggestion per package
 * (when present).
 */
export function formatRejectError(rejects: ReadonlyArray<RejectEntry>): string {
  if (rejects.length === 0) return '';
  const head = `${ANSI_RED}npm install rejected:${ANSI_RESET} ${rejects.length} package${rejects.length === 1 ? '' : 's'} not supported on Nimbus.`;
  const lines = rejects.map((r) => {
    const main = `  ❌ ${r.from} — ${r.reason}`;
    if (r.suggest) {
      return `${main}\n     ${ANSI_DIM}try:${ANSI_RESET} ${r.suggest}`;
    }
    return main;
  });
  return [head, ...lines].join('\n');
}

/**
 * Single-line yellow notice emitted for a transitive `[skip]`.
 *   `[npm] [skip] fsevents — macOS-only filesystem watcher; never runs in Workers`
 */
export function formatTransitiveSkip(r: RejectEntry): string {
  return `[npm] ${ANSI_YELLOW}[skip]${ANSI_RESET} ${r.from} — ${r.reason}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Error class — used to mark registry-driven rejects across the
// supervisor/facet boundary
// ─────────────────────────────────────────────────────────────────────────

/**
 * Tag class for registry-driven rejects. Both the supervisor-side path
 * (npm-installer.ts:applyW6Registry, npm-resolver.ts:resolveTree) and the
 * facet-side path (npm-resolve-facet.ts:resolveTreeInFacet) throw errors
 * tagged for this case.
 *
 * Supervisor-side: throw `new RegistryRejectError(rejects)` directly.
 * Facet-side: cannot import this class (preamble has no import surface),
 *   so the facet throws `new Error(...)` with `err.__w6_reject = true`.
 *   Both are detected via `isRegistryReject()`.
 *
 * The own-property `__w6_reject = true` survives any boundary that
 * preserves error own-properties (NimbusFacetPool's loadable contract
 * is checked in audit/probes/w6/ ...).
 */
export class RegistryRejectError extends Error {
  readonly rejects: ReadonlyArray<RejectEntry>;
  readonly __w6_reject: true = true;
  constructor(rejects: ReadonlyArray<RejectEntry>) {
    super(formatRejectError(rejects));
    this.name = 'RegistryRejectError';
    this.rejects = rejects;
  }
}

/**
 * Robust check that survives the supervisor↔facet boundary: prototypes
 * are lost across that boundary, so we tag via an own-property.
 */
export function isRegistryReject(e: unknown): boolean {
  return !!(e && typeof e === 'object' && (e as any).__w6_reject === true);
}

// ─────────────────────────────────────────────────────────────────────────
// Module-load assertion: WASM_SWAPS.from and REJECT_INSTALL.from are disjoint
// ─────────────────────────────────────────────────────────────────────────

(() => {
  for (const s of WASM_SWAPS) {
    if (_rejectByFrom.has(s.from)) {
      throw new Error(
        `W6 registry conflict: '${s.from}' is in both WASM_SWAPS and REJECT_INSTALL. ` +
          `A name must own one role.`,
      );
    }
  }
})();
