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
  // X.5-G G2: rollup ships native platform shards as
  // `optionalDependencies` (26 of them). On any host where the matching
  // shard isn't present, rollup's own `native.js` throws the famous
  // 'npm has a bug related to optional dependencies (#4828)'. Even
  // when the matching shard IS installed, the .node binary cannot
  // load in workerd. @rollup/wasm-node is the upstream-published
  // pure-WASM build with byte-identical exports (verified via registry
  // packument compare 2026-05-05; both ship `dist/rollup.js` with the
  // same `exports` map). Drop-in swap.
  {
    from: 'rollup',
    to: '@rollup/wasm-node',
    reason:
      'Native rollup uses optionalDependencies for 26 platform shards (npm CLI bug #4828) ' +
      'and ships .node binaries that workerd cannot load. @rollup/wasm-node is the upstream ' +
      'pure-WASM build with identical exports.',
    compat: 'drop-in',
  },
];

export const REJECT_INSTALL: ReadonlyArray<RejectEntry> = [
  // ── Same-require-name natives that crash at load time ────────────────
  {
    from: 'sharp',
    reason: 'Native libvips bindings; not portable to Workers.',
    suggest:
      'no Workers-compatible target — render server-side or use Cloudflare Images. ' +
      'For the wasm32 build see @img/sharp-wasm32 entry below.',
    transitive: 'fail',
  },
  {
    from: 'sqlite3',
    reason: 'Native sqlite3 .node binding.',
    suggest:
      'better-sqlite3-wasm (untested by Nimbus) or sql.js (loader gap — see audit/probes/w6.5/spike/sql-js.verdict.md).',
    transitive: 'fail',
  },
  {
    from: 'better-sqlite3',
    reason: 'Native sqlite .node binding.',
    suggest:
      'better-sqlite3-wasm (untested by Nimbus) or @libsql/client (resolver subpath gap — see audit/probes/w6.5/spike/libsql-client.verdict.md; may already work post-W2.6a).',
    transitive: 'fail',
  },
  {
    from: 'canvas',
    reason: 'Native Cairo bindings.',
    suggest:
      'canvaskit-wasm (Skia → WASM, canvas-API-compatible, ~7MB; untested by Nimbus) ' +
      'or @resvg/resvg-wasm for SVG (verified — see audit/probes/wasm/resvg-wasm.out.txt).',
    transitive: 'fail',
  },
  {
    from: 'sodium-native',
    reason: 'Native libsodium.',
    suggest:
      'tweetnacl (pure JS, untested by Nimbus) or libsodium-wrappers (WASM, untested by Nimbus).',
    transitive: 'fail',
  },
  {
    from: 'fsevents',
    reason: 'macOS-only filesystem watcher; never runs in Workers.',
    suggest:
      'optional dep — chokidar/watchpack work without it (untested by Nimbus). ' +
      'Move to optionalDependencies in your package.json.',
    transitive: 'warn',
  },
  {
    from: 'bufferutil',
    reason: 'Native binding for ws speedups; install requires node-gyp.',
    suggest:
      'optional dep — ws works without it (slower frames; untested by Nimbus). ' +
      'Move to optionalDependencies.',
    transitive: 'warn',
  },
  {
    from: 'utf-8-validate',
    reason: 'Native binding for ws speedups; install requires node-gyp.',
    suggest:
      'optional dep — ws works without it (untested by Nimbus). Same as bufferutil.',
    transitive: 'warn',
  },
  {
    from: 'node-pty',
    reason: 'PTY syscalls unavailable in workerd.',
    suggest: 'no Workers-compatible target — use the Nimbus built-in shell.',
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
      'Native bcrypt; pure-JS bcryptjs has identical sync API but the require() name differs and Nimbus does not yet support `npm:` aliases (W6.6).',
    suggest:
      'change `require("bcrypt")` to `require("bcryptjs")`, then `npm install bcryptjs` (verified — see audit/probes/wasm/bcryptjs.out.txt). APIs are sync-compatible.',
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
    suggest:
      'sass (dart-sass, pure JS — partial support: top-level CJS load fails today, see audit/probes/wasm/sass.out.txt; untested for ESM imports).',
    transitive: 'fail',
  },
  {
    from: 'grpc',
    reason: 'Deprecated native gRPC.',
    suggest:
      '@grpc/grpc-js (pure JS — runtime resolver gap on internal subpath today, see audit/probes/wasm/grpc-grpc-js.out.txt; untested end-to-end).',
    transitive: 'fail',
  },
  {
    from: '@swc/core',
    reason: 'Native Rust SWC.',
    suggest:
      '@swc/wasm-web (transform/parse only; no Plugin API; loader gap — see audit/probes/wasm/swc-wasm-web.out.txt and audit/probes/w6.5/spike/swc-wasm-web.verdict.md).',
    transitive: 'fail',
  },

  // ── ORM natives ──────────────────────────────────────────────────────
  {
    from: 'prisma',
    reason: 'Native query engine; not portable to Workers in this configuration.',
    suggest:
      '@prisma/adapter-d1 (Prisma official Workers adapter, untested by Nimbus), ' +
      'or migrate to drizzle-orm + @libsql/client (untested; @libsql/client has known resolver gap — see audit/probes/wasm/libsql-client.out.txt).',
    transitive: 'fail',
  },
  {
    from: '@prisma/client',
    reason: 'Same as `prisma` (native query engine).',
    suggest:
      '@prisma/adapter-d1 (untested by Nimbus), or drizzle-orm + @libsql/client (untested).',
    transitive: 'fail',
  },

  // ── Build-time native compilers (always wrong in Workers) ───────────
  {
    from: 'node-gyp',
    reason: 'Build-time native compiler; never runs in Workers.',
    suggest:
      'no Workers-compatible target — remove from dependencies. Nimbus pre-skips build-only tools transitively.',
    transitive: 'warn',
  },
  {
    from: 'node-pre-gyp',
    reason: 'Build-time native compiler; never runs in Workers.',
    suggest: 'no Workers-compatible target — remove from dependencies.',
    transitive: 'warn',
  },

  // ── Bundled-binary giants ──────────────────────────────────────────
  {
    from: 'puppeteer',
    reason: 'Bundled Chromium binary (~150 MB).',
    suggest:
      'no Workers-compatible target for the bundled binary — use puppeteer-core + Cloudflare Browser Rendering (untested by Nimbus).',
    transitive: 'fail',
  },
  {
    from: 'playwright',
    reason: 'Bundled browsers (~300 MB).',
    suggest:
      'no Workers-compatible target for bundled browsers — use @playwright/test against a remote browser endpoint (untested by Nimbus).',
    transitive: 'fail',
  },

  // ── Loader-gap honesty (install OK; runtime FAIL today) ─────────────
  // These come out of REJECT once the loader work lands. Spike verdicts
  // (audit/probes/w6.5/spike/) confirmed both gaps span >1 src/ file.
  {
    from: 'sql.js',
    reason:
      'Installs but fails at runtime: ENOENT on dist/sql-wasm.wasm. Loader gap NOT in tar extraction — likely between streamTarEntries and writeBatch RPC handler, or in cirrus-real fs shim. See audit/probes/w6.5/spike/sql-js.verdict.md.',
    suggest:
      'no Workers-compatible target today — tracked for W6.5.x (multi-file fix exceeded W6.5 surface-area gate). For SQL in Workers consider Cloudflare D1 or @libsql/client (loader gap — see audit/probes/w6.5/spike/libsql-client.verdict.md).',
    transitive: 'fail',
  },
  {
    from: '@swc/wasm-web',
    reason:
      'Installs but fails at runtime: node-shims.ts:2058 throws "Cannot load module … file was not pre-bundled" — this is a workerd CSP-like new-Function block, not a slice walker gap. See audit/probes/w6.5/spike/swc-wasm-web.verdict.md.',
    suggest:
      'no Workers-compatible target today — tracked for W6.5.x (general facet-runtime issue, not @swc/wasm-web-specific). For ESM transforms consider esbuild-wasm (verified — see audit/probes/wasm/esbuild-wasm.out.txt; a Nimbus W6 swap target).',
    transitive: 'fail',
  },

  // ── W6.5 additions: WASM/wasi-flavour packages that don't load ──────
  {
    from: '@img/sharp-wasm32',
    reason:
      'WASM build of sharp; package is wasm32-cpu-only (npm refuses install on x64) AND libvips initThreads() fails under workerd (no pthread support — see audit/sections/07-workerd-hard-limits.md).',
    suggest:
      'wasm-vips (verified install + load, default-export-only API — see audit/probes/wasm/wasm-vips.out.txt). For complex pipelines: render server-side and ship pixels.',
    transitive: 'fail',
  },
  {
    from: '@napi-rs/canvas',
    reason:
      'Native bindings only (linux-x64-gnu/musl, darwin-arm64/x64, android-arm64, linux-arm64-gnu/musl, win32-x64-msvc, linux-arm-gnueabihf). No WASM build published.',
    suggest:
      'canvaskit-wasm (Skia → WASM, canvas-API-compatible, ~7MB; untested by Nimbus) ' +
      'or @resvg/resvg-wasm for SVG (verified — see audit/probes/wasm/resvg-wasm.out.txt).',
    transitive: 'fail',
  },
  {
    from: '@napi-rs/canvas-wasm32-wasi',
    reason:
      '@napi-rs/canvas does not publish a wasm32-wasi variant on npm (404). The @napi-rs/canvas project ships only native bindings. No WASM/WASI build exists.',
    suggest:
      'canvaskit-wasm (Skia → WASM, canvas-API-compatible; untested by Nimbus) ' +
      'or @resvg/resvg-wasm (verified — see audit/probes/wasm/resvg-wasm.out.txt) for SVG.',
    transitive: 'fail',
  },

  // ── X.5-26b additions: Tailwind v4 oxide + lightningcss native parents ─
  // Both ship only platform-native .node bindings + a wasm32-wasi shard.
  // workerd has no node:wasi (W6.5 hard limit), so neither path loads.
  // Without these REJECT entries, both parents install fine and surface
  // a misleading runtime error (npm-4828 fallthrough for oxide, detect-
  // libc execSync gap for lightningcss). With transitive='fail', the
  // install is loud-rejected at resolve time → ⚠ → ⛔ classifier flip.
  // Investigation: audit/probes/x526b/investigation/{tailwindcss-oxide,lightningcss}.out.txt
  // Plan: audit/sections/X526b-plan.md §3.1
  // Functional probes: audit/probes/x526b/functional/{oxide,lightningcss}-rejected.mjs
  // E2E probes: audit/probes/x526b/e2e/{oxide,lightningcss,tailwindcss-vite-transitive}-e2e.mjs
  {
    from: '@tailwindcss/oxide',
    reason:
      'Native Rust Tailwind v4 oxide engine; ships only platform-specific .node bindings (linux-x64-gnu/musl, darwin-x64/arm64, freebsd-x64, win32-x64-msvc, etc.) plus a wasm32-wasi shard. workerd has no node:wasi (W6.5 hard limit; see audit/sections/07-workerd-hard-limits.md), and bare native bindings cannot dlopen. The parent index.js throws an npm-4828 message at runtime when no sibling shard loads.',
    suggest:
      'no Workers-compatible target — Tailwind v3 (`tailwindcss@^3`) is pure JS and works in Workers (untested by Nimbus). Tailwind v4 inherently requires the Rust oxide engine.',
    transitive: 'fail',
  },
  {
    from: 'lightningcss',
    reason:
      'Native Rust CSS parser; ships platform-specific .node bindings + a wasm32-wasi-only `lightningcss-wasm` package (cpu=wasm32; npm refuses install on x64). workerd has no node:wasi (W6.5). Even before the binding load, the detect-libc dependency throws because child_process.execSync returns undefined inside workerd.',
    suggest:
      'no Workers-compatible target today — postcss + cssnano (pure JS, untested by Nimbus) cover most lightningcss use cases. For CSS minification only: clean-css (pure JS, untested by Nimbus).',
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
// W6.5: Telemetry hook
// ─────────────────────────────────────────────────────────────────────────
//
// When a swap fires, a reject throws, or a transitive-skip drops a package,
// we emit a `RegistryEvent` so an external sink can aggregate these signals
// (e.g. "which rejected packages should we invest in swapping next?").
//
// Design (W6.5-plan.md §5):
//   - Pluggable sink: callers register a single global sink via
//     `setRegistryEventSink(...)`. The sink runs on the supervisor isolate;
//     the facet isolate collects events into a side-channel array
//     (ResolveFacetResult.registryEvents) which the supervisor drains.
//   - Sink throws are CAUGHT (telemetry must never break the install path)
//     and counted via `getSinkThrowCount()` so production can detect
//     misbehaving sinks.
//   - Default sink: src/index.ts installs a JSONL-to-stdout sink at module
//     top so events show up in `wrangler tail`. Replace with
//     analytics_engine_datasets when F-observability lands.

/**
 * The discriminated-union event emitted by the supervisor whenever the
 * registry takes a decision.
 *
 *   - `swap`            — `from` is being installed as `to`. `ctx='top'` means
 *                         user typed `npm install <from>`; `'transitive'`
 *                         means a dep of a dep referenced `from`.
 *   - `reject`          — `from` was rejected with `reason` (and optional
 *                         actionable `suggest`). At `ctx='top'` an error is
 *                         thrown; at `ctx='transitive'` the throw happens
 *                         when the entry's policy is `'fail'`.
 *   - `transitive-skip` — `from` (with `transitive: 'warn'` policy) was
 *                         dropped silently from the resolved tree at depth>0.
 */
export type RegistryEvent =
  | { type: 'swap'; from: string; to: string; ctx: 'top' | 'transitive' }
  | { type: 'reject'; from: string; reason: string; suggest?: string; ctx: 'top' | 'transitive' }
  | { type: 'transitive-skip'; from: string; reason: string };

export type RegistryEventSink = (e: RegistryEvent) => void;

let _sink: RegistryEventSink | null = null;
let _sinkThrowCount = 0;

/**
 * Install (or clear, with `null`) the global registry event sink.
 *
 * The sink is a per-isolate singleton. The supervisor isolate's sink does
 * NOT propagate to facet isolates — facet emits travel through
 * `ResolveFacetResult.registryEvents` and are flushed by the supervisor
 * after the facet returns. See W6.5-plan.md §5.5 for the per-isolate
 * invariant.
 */
export function setRegistryEventSink(s: RegistryEventSink | null): void {
  _sink = s;
}

export function getRegistryEventSink(): RegistryEventSink | null {
  return _sink;
}

/**
 * Forward an event to the sink. Sink throws are caught (telemetry must
 * never break install) and counted.
 */
export function emitRegistryEvent(e: RegistryEvent): void {
  if (!_sink) return;
  try {
    _sink(e);
  } catch {
    _sinkThrowCount++;
  }
}

/**
 * Number of sink invocations that threw (and were caught). Useful for
 * production monitoring (and probes).
 */
export function getSinkThrowCount(): number {
  return _sinkThrowCount;
}

// ─────────────────────────────────────────────────────────────────────────
// X.5-G: optional-dependencies semantics
// ─────────────────────────────────────────────────────────────────────────
//
// npm 4828 / npm v7+ semantics for `optionalDependencies`:
//   - Entries are best-effort. Failure to install one MUST NOT cause the
//     parent install to fail.
//   - Entries with `os`, `cpu`, or `libc` constraints that don't match the
//     host MUST be silently skipped before any fetch attempt.
//   - Entries whose `main` is a `.node` (Node.js N-API binary) cannot run
//     in workerd (no dlopen) and must be silently skipped even on a
//     matching platform.
//
// X.5-G adds:
//   - `isOptionalNativeBinding(packument)`: heuristic to detect platform-
//     native bindings (used to silent-skip from `optionalDependencies`).
//   - `selectAutoInstallPeers(pkg)`: returns the subset of `peerDependencies`
//     to auto-install (filters out optional-marked-in-meta, EXCEPT when
//     called with `topLevel:true` per X5F R2.5 npm CLI default behaviour).
//     Peer-meta-only entries (in `peerDependenciesMeta` but NOT in
//     `peerDependencies`) are NEVER auto-installed.
//   - `classifyInstallError(e, ctx)`: distinguishes recoverable
//     optional-dep skip from real resolve failures and registry-rejects.

/**
 * Minimal shape of a registry packument entry that the helpers below
 * consume. We don't pull from a stricter schema because the registry
 * cache passes string-typed data with optional fields.
 */
export interface MinimalPackument {
  name?: string;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  main?: string;
}

// Known native-shard name globs. Matched as `prefix-` (so the parent
// package name without a platform suffix never matches).
const NATIVE_SHARD_PREFIXES: ReadonlyArray<string> = [
  '@rollup/rollup-',
  '@parcel/watcher-',
  '@swc/core-',
  '@next/swc-',
  '@tailwindcss/oxide-',
  '@img/sharp-',
  '@napi-rs/canvas-',
  '@biomejs/cli-',
  '@esbuild/',
];

/**
 * Heuristic: does this packument represent a platform-native binding
 * that workerd cannot load?
 *
 * Returns true when ANY of:
 *   - `os`, `cpu`, or `libc` field is non-empty (npm spec platform
 *     constraints — package is opting out of cross-platform installs).
 *   - `main` ends in `.node` (Node.js N-API binary, not workerd-loadable).
 *   - name matches a known native-shard glob (see NATIVE_SHARD_PREFIXES).
 *
 * Returns false for pure-JS packages, parent wrappers (e.g. the
 * non-platform `@parcel/watcher` itself), and packuments with empty
 * platform-constraint arrays.
 *
 * X.5-G G1: the resolver consults this on every packument fetched from
 * a transitive `optionalDependencies` entry. Returns-true → silent-skip
 * (emit a `transitive-skip` RegistryEvent, drop the package from the
 * resolved tree).
 */
export function isOptionalNativeBinding(p: MinimalPackument): boolean {
  if (!p) return false;
  if (Array.isArray(p.os) && p.os.length > 0) return true;
  if (Array.isArray(p.cpu) && p.cpu.length > 0) return true;
  if (Array.isArray(p.libc) && p.libc.length > 0) return true;
  if (typeof p.main === 'string' && /\.node$/.test(p.main)) return true;
  if (typeof p.name === 'string') {
    for (const prefix of NATIVE_SHARD_PREFIXES) {
      // Require the prefix-then-something-else shape. The parent package
      // (e.g. `@parcel/watcher`, `@rollup/wasm-node`) does not match.
      if (p.name.startsWith(prefix) && p.name.length > prefix.length) {
        // Carve out @rollup/wasm-node: it's the WASM build, not a native shard.
        if (p.name === '@rollup/wasm-node') return false;
        return true;
      }
    }
  }
  return false;
}

/**
 * Select which entries in `peerDependencies` should be auto-installed.
 *
 * npm v7+ default behaviour:
 *   - All `peerDependencies` entries auto-install.
 *   - Entries marked `optional: true` in `peerDependenciesMeta` STILL
 *     auto-install (with `--include=peer` default-on) — but tools may
 *     opt-out with `--no-include=peer`.
 *   - Entries that exist ONLY in `peerDependenciesMeta` (NOT in
 *     `peerDependencies`) are NEVER auto-installed (they're feature-
 *     detect signals, e.g. ts-jest's `esbuild`).
 *
 * X.5-G strict mode (the default here): we only iterate `peerDependencies`
 * keys. peer-meta-only entries are excluded by construction.
 *
 * The `requiredOnly` flag, when true, also filters out entries marked
 * optional in meta — used for transitive (depth>0) enqueue per X5F R2.
 * When false (top-level / X5F R2.5), all `peerDependencies` entries are
 * returned including optional-marked-in-meta ones (npm CLI default).
 */
export function selectAutoInstallPeers(
  pkg: {
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  },
  opts: { requiredOnly?: boolean } = {},
): string[] {
  const peers = pkg.peerDependencies || {};
  const meta = pkg.peerDependenciesMeta || {};
  const out: string[] = [];
  for (const name of Object.keys(peers)) {
    if (opts.requiredOnly && meta[name]?.optional) continue;
    out.push(name);
  }
  return out;
}

/**
 * Classification of an install-time error so the supervisor can decide
 * whether to swallow (recoverable) or propagate (real fail).
 *
 *   - 'optional-dep-skip'  — the failed package was an entry in
 *                            `optionalDependencies`; skip silently.
 *   - 'registry-reject'    — RegistryRejectError (W6 known-bad package).
 *   - 'real-resolve-fail'  — anything else; propagate.
 */
export type InstallErrorClass =
  | 'optional-dep-skip'
  | 'registry-reject'
  | 'real-resolve-fail';

export function classifyInstallError(
  e: unknown,
  ctx: { isOptional?: boolean } = {},
): InstallErrorClass {
  if (isRegistryReject(e)) return 'registry-reject';
  if (ctx.isOptional) return 'optional-dep-skip';
  return 'real-resolve-fail';
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
