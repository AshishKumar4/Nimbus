/**
 * Package ABI policy — WASM swaps, rejected packages, build-only skips,
 * and native-artifact classification.
 *
 * The contract:
 *   - swaps  : name→name rewrite at the resolver/installer boundary.
 *              Only `compat: 'drop-in'` swaps qualify (the consumer's
 *              `require()` call site works unchanged). Different-
 *              require-name candidates (bcrypt → bcryptjs, argon2 →
 *              hash-wasm, …) are NOT swaps until the resolver supports
 *              `npm:` aliases. They live in `rejects` with a
 *              code-change suggestion.
 *
 *   - rejects: deny list with helpful messages. Every entry is
 *              `transitive: 'fail'` — hard-fail at any depth (top +
 *              transitive). The 'warn' classification is retired:
 *              plain-JS tooling installs, and native shards are caught
 *              by the optional-native-binding classifier instead.
 *
 * IMPORTANT: `PACKAGE_ABI_POLICY` is the single source of truth for the
 * whole npm policy — supervisor AND facets. Generated dynamic-Worker
 * facets cannot `import` this module, so
 * `src/loaders/npm-resolve-preamble.ts` SERIALIZES the policy object
 * (JSON) plus the `policy*` functions below (`fn.toString()`) into the
 * facet preamble at supervisor module-load time. The `policy*` functions
 * must therefore stay self-contained: parameters and globals only — no
 * references to module-scope bindings. The parity unit test
 * (`tests/unit/package-abi-policy.mjs`) extracts the injected policy and
 * asserts equality with this module.
 */

import {
  NATIVE_UNSUPPORTED_ABI,
  NIMBUS_ABI_TARGET,
  PYODIDE_PACKAGE_ABI,
  type PackageAbiPolicy,
  type PackageRejectEntry,
  type PackageStagedArtifactEntry,
  type PackageSwapEntry,
} from '@nimbus-sh/core/runtime/os-contracts.js';

// ─────────────────────────────────────────────────────────────────────────
// The policy
// ─────────────────────────────────────────────────────────────────────────

const SWAPS: ReadonlyArray<PackageSwapEntry> = [
  // Different-require-name candidates (bcrypt → bcryptjs, argon2 →
  // hash-wasm, node-sass → sass, grpc → @grpc/grpc-js, @swc/core →
  // @swc/wasm-web) are intentionally NOT here. Without npm-alias
  // support, swapping them would silently break the user's
  // `require(originalName)` call site. They are in `rejects`
  // with a code-change suggestion until npm-alias support exists.
  {
    from: 'esbuild',
    to: 'esbuild-wasm',
    reason:
      'Native esbuild not available in Workers; esbuild-wasm exposes the same build/transform/version/initialize API.',
    compat: 'drop-in',
  },
];

/**
 * Sentinel bin target the installer writes for a staged-artifact package.
 * `bin/<name>` is rewritten to `<prefix><artifact-id>`; the .bin runner
 * (init.ts) recognizes the scheme and dispatches the staged opencode bundle
 * through the node runtime instead of trying to exec the native launcher.
 */
export const STAGED_ARTIFACT_BIN_PREFIX = 'nimbus-staged:';

const STAGED_ARTIFACTS: ReadonlyArray<PackageStagedArtifactEntry> = [
  {
    from: 'opencode-ai',
    bin: 'opencode',
    artifact: 'opencode',
    reason:
      'opencode-ai ships a native launcher (bin/opencode.exe) and 12 platform-native shards; ' +
      'Nimbus runs the prebuilt opencode JS bundle instead.',
  },
];

const REJECTS: ReadonlyArray<PackageRejectEntry> = [
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
      'better-sqlite3-wasm (untested by Nimbus) or sql.js once wasm asset loading is available.',
    transitive: 'fail',
  },
  {
    from: 'better-sqlite3',
    reason: 'Native sqlite .node binding.',
    suggest:
      'better-sqlite3-wasm (untested by Nimbus) or @libsql/client if its subpath exports resolve in your project.',
    transitive: 'fail',
  },
  {
    from: 'canvas',
    reason: 'Native Cairo bindings.',
    suggest:
      'canvaskit-wasm (Skia -> WASM, canvas-API-compatible, ~7MB; untested by Nimbus) ' +
      'or @resvg/resvg-wasm for SVG.',
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
      'Native bcrypt; pure-JS bcryptjs has an equivalent sync API but the require() name differs and Nimbus does not yet support npm aliases.',
    suggest:
      'change `require("bcrypt")` to `require("bcryptjs")`, then `npm install bcryptjs`. APIs are sync-compatible.',
    transitive: 'fail',
  },
  {
    from: 'argon2',
    reason: 'Native Argon2 C bindings.',
    suggest:
      'hash-wasm for argon2d, argon2i, and argon2id.',
    transitive: 'fail',
  },
  {
    from: 'node-sass',
    reason: 'Native libsass; deprecated upstream.',
    suggest:
      'sass (dart-sass, pure JS).',
    transitive: 'fail',
  },
  {
    from: 'grpc',
    reason: 'Deprecated native gRPC.',
    suggest:
      '@grpc/grpc-js (pure JS, untested end-to-end in Nimbus).',
    transitive: 'fail',
  },
  {
    from: '@swc/core',
    reason: 'Native Rust SWC.',
    suggest:
      '@swc/wasm-web for transform/parse only; it does not provide the native Plugin API.',
    transitive: 'fail',
  },

  // ── ORM natives ──────────────────────────────────────────────────────
  {
    from: 'prisma',
    reason: 'Native query engine; not portable to Workers in this configuration.',
    suggest:
      '@prisma/adapter-d1 (Prisma official Workers adapter, untested by Nimbus), ' +
      'or migrate to drizzle-orm + @libsql/client (untested by Nimbus).',
    transitive: 'fail',
  },
  {
    from: '@prisma/client',
    reason: 'Same as `prisma` (native query engine).',
    suggest:
      '@prisma/adapter-d1 (untested by Nimbus), or drizzle-orm + @libsql/client (untested).',
    transitive: 'fail',
  },

  // ── Toolchains that carry their own native runtime ───────────────────
  // (wrangler, @cloudflare/vite-plugin, parcel, node-gyp, node-pre-gyp
  // were once 'warn' entries here. They are plain JS packages — the
  // native shards they pull are refused by the optional-native-binding
  // classifier — so they install like any other package. Only 'fail'
  // entries exist in this table; the `transitive` union on the public
  // PackageAbiPolicy type is frozen, so the field stays in the entry
  // shape.)


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

  // ── Packages that install but do not run correctly in the current loader ─
  {
    from: 'sql.js',
    reason:
      'Installs but fails at runtime because dist/sql-wasm.wasm is not available to the runtime loader.',
    suggest:
      'For SQL in Workers, consider Cloudflare D1 or @libsql/client.',
    transitive: 'fail',
  },
  {
    from: '@swc/wasm-web',
    reason:
      'Installs but fails at runtime because its generated code path depends on workerd-blocked dynamic code generation.',
    suggest:
      'For ESM transforms consider esbuild-wasm.',
    transitive: 'fail',
  },

  // ── WASM/WASI-flavoured packages that still do not load ─────────────
  {
    from: '@img/sharp-wasm32',
    reason:
      'WASM build of sharp; package is wasm32-cpu-only and libvips initThreads() requires pthread support unavailable in Workers.',
    suggest:
      'wasm-vips may work for simple pipelines; for complex pipelines, render server-side and ship pixels.',
    transitive: 'fail',
  },
  {
    from: '@napi-rs/canvas',
    reason:
      'Native bindings only (linux-x64-gnu/musl, darwin-arm64/x64, android-arm64, linux-arm64-gnu/musl, win32-x64-msvc, linux-arm-gnueabihf). No WASM build published.',
    suggest:
      'canvaskit-wasm (Skia -> WASM, canvas-API-compatible, ~7MB; untested by Nimbus) ' +
      'or @resvg/resvg-wasm for SVG.',
    transitive: 'fail',
  },
  {
    from: '@napi-rs/canvas-wasm32-wasi',
    reason:
      '@napi-rs/canvas does not publish a wasm32-wasi variant on npm (404). The @napi-rs/canvas project ships only native bindings. No WASM/WASI build exists.',
    suggest:
      'canvaskit-wasm (Skia -> WASM, canvas-API-compatible; untested by Nimbus) ' +
      'or @resvg/resvg-wasm for SVG.',
    transitive: 'fail',
  },

  // ── Tailwind v4 oxide + lightningcss native parents ────────────────
  // Both ship only platform-native .node bindings + a wasm32-wasi shard.
  // workerd has no node:wasi, so neither path loads.
  // Without these REJECT entries, both parents install fine and surface
  // a misleading runtime error (npm-4828 fallthrough for oxide, detect-
  // libc execSync gap for lightningcss). With transitive='fail', the
  // install is loudly rejected at resolve time.
  {
    from: '@tailwindcss/oxide',
    reason:
      'Native Rust Tailwind v4 oxide engine; ships only platform-specific .node bindings plus a wasm32-wasi shard. workerd has no node:wasi, and bare native bindings cannot dlopen.',
    suggest:
      'no Workers-compatible target — Tailwind v3 (`tailwindcss@^3`) is pure JS and works in Workers (untested by Nimbus). Tailwind v4 inherently requires the Rust oxide engine.',
    transitive: 'fail',
  },
  {
    from: 'lightningcss',
    reason:
      'Native Rust CSS parser; ships platform-specific .node bindings plus a wasm32-wasi-only `lightningcss-wasm` package. workerd has no node:wasi, and the package probes libc through child_process.execSync.',
    suggest:
      'no Workers-compatible target today — postcss + cssnano (pure JS, untested by Nimbus) cover most lightningcss use cases. For CSS minification only: clean-css (pure JS, untested by Nimbus).',
    transitive: 'fail',
  },
];


/**
 * The single typed package-ABI policy (see `PackageAbiPolicy` in
 * runtime/os-contracts.ts). Everything the npm resolver/installer needs
 * to decide swap / reject / skip / native-artifact classification, in
 * one JSON-serializable object.
 */
export const PACKAGE_ABI_POLICY: PackageAbiPolicy = {
  abiTarget: NIMBUS_ABI_TARGET,
  acceptedArtifactClasses: [
    'javascript',
    NIMBUS_ABI_TARGET,
    PYODIDE_PACKAGE_ABI,
    'py3-none-any',
    'python-source-pure',
    'pyodide',
    'ruby-wasm',
  ],
  nativeArtifactClass: NATIVE_UNSUPPORTED_ABI,
  swaps: SWAPS,
  stagedArtifacts: STAGED_ARTIFACTS,
  rejects: REJECTS,
  skipPackages: [],
  skipPrefixes: [],
  frameworkRequiredPackages: [],
  // The transitive-skip gate these fields fed was removed with the
  // required-reachability work: every package a project declares is
  // resolved, and refusal is the reject list's job. The fields stay —
  // empty — because `PackageAbiPolicy` is a public `@nimbus-sh/core`
  // type and the preamble's serialized policy must keep its shape.
  // Known native-shard name globs. Matched as `prefix-` (so the parent
  // package name without a platform suffix never matches).
  nativeShardPrefixes: [
    '@rollup/rollup-',
    '@parcel/watcher-',
    '@swc/core-',
    '@next/swc-',
    '@tailwindcss/oxide-',
    '@img/sharp-',
    '@napi-rs/canvas-',
    '@biomejs/cli-',
    '@esbuild/',
  ],
  // @rollup/wasm-node matches the '@rollup/rollup-'-adjacent shard shape
  // check by prefix but is the pure-WASM build, not a native shard.
  nativeShardExemptions: ['@rollup/wasm-node'],
  nativeBinExtensions: ['.exe', '.node'],
};

// ─────────────────────────────────────────────────────────────────────────
// Policy functions — SERIALIZED into facet preambles via fn.toString().
// Self-contained by contract: parameters and JS globals only.
// ─────────────────────────────────────────────────────────────────────────


export function policyLookupSwap(
  policy: PackageAbiPolicy,
  name: string,
): PackageSwapEntry | undefined {
  return policy.swaps.find((entry) => entry.from === name);
}

export function policyLookupReject(
  policy: PackageAbiPolicy,
  name: string,
): PackageRejectEntry | undefined {
  return policy.rejects.find((entry) => entry.from === name);
}

export function policyLookupStagedArtifact(
  policy: PackageAbiPolicy,
  name: string,
): PackageStagedArtifactEntry | undefined {
  return policy.stagedArtifacts.find((entry) => entry.from === name);
}

/**
 * Mutate a resolved-package shape so a staged-artifact package installs as
 * a Nimbus JS bundle instead of its native launcher: rewrite `bin` to the
 * single `nimbus-staged:<artifact>` sentinel and drop the platform-native
 * `optionalDependencies` (shards) so the resolver never enqueues them.
 *
 * Self-contained (parameters + globals only) so it serializes into the
 * resolver facet preamble. `pkg` is mutated in place and returned.
 */
export function policyApplyStagedArtifact(
  pkg: {
    bin?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    os?: string[];
    cpu?: string[];
    libc?: string[];
  },
  entry: PackageStagedArtifactEntry,
  binPrefix: string,
): void {
  pkg.bin = { [entry.bin]: `${binPrefix}${entry.artifact}` };
  pkg.optionalDependencies = undefined;
  // The staged bundle is platform-independent; clear the package's native
  // os/cpu/libc allowlists so the native-artifact reject does not fire on
  // them (opencode-ai declares os=[darwin,linux,win32] cpu=[arm64,x64]).
  pkg.os = undefined;
  pkg.cpu = undefined;
  pkg.libc = undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Supervisor lookup API
// ─────────────────────────────────────────────────────────────────────────

export function lookupSwap(name: string): PackageSwapEntry | undefined {
  return policyLookupSwap(PACKAGE_ABI_POLICY, name);
}

export function lookupReject(name: string): PackageRejectEntry | undefined {
  return policyLookupReject(PACKAGE_ABI_POLICY, name);
}

export function lookupStagedArtifact(name: string): PackageStagedArtifactEntry | undefined {
  return policyLookupStagedArtifact(PACKAGE_ABI_POLICY, name);
}

/** Apply the staged-artifact bin/optionalDeps rewrite in supervisor scope. */
export function applyStagedArtifact(
  pkg: { bin?: Record<string, string>; optionalDependencies?: Record<string, string> },
  entry: PackageStagedArtifactEntry,
): void {
  policyApplyStagedArtifact(pkg, entry, STAGED_ARTIFACT_BIN_PREFIX);
}


/**
 * Pure: return a new specs map with every swap `from` key rewritten
 * to its swap target. Records the swaps actually performed.
 *
 * Idempotent: running on already-swapped specs is a no-op.
 *
 * Range carry-over: the original spec range is preserved on the new key.
 * Future alias support may force pulling the current swap target version,
 * but for now we honour the user's requested range.
 */
export function applySwaps(
  specs: Record<string, string>,
): { specs: Record<string, string>; swaps: PackageSwapEntry[] } {
  const out: Record<string, string> = {};
  const swaps: PackageSwapEntry[] = [];
  for (const [name, range] of Object.entries(specs)) {
    const swap = lookupSwap(name);
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
 * Return rejects whose policy applies at this depth. Only 'fail'
 * entries exist, so 'top' and 'transitive' are the same set.
 */
export function findRejects(
  specs: Record<string, string>,
  ctx: 'top' | 'transitive',
): PackageRejectEntry[] {
  const out: PackageRejectEntry[] = [];
  for (const name of Object.keys(specs)) {
    const r = lookupReject(name);
    if (!r) continue;
    if (ctx === 'transitive' && r.transitive !== 'fail') continue;
    out.push(r);
  }
  return out;
}


// ─────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────

const ANSI_YELLOW = '\x1b[33m';
const ANSI_DIM = '\x1b[2m';
const ANSI_RESET = '\x1b[0m';

/**
 * Single-line yellow notice emitted to onProgress when a swap fires.
 *   `[npm] [swap] esbuild → esbuild-wasm (Native esbuild not available …)`
 */
export function formatSwapNotice(s: PackageSwapEntry): string {
  return `[npm] ${ANSI_YELLOW}[swap]${ANSI_RESET} ${s.from} → ${s.to} (${s.reason})`;
}

/**
 * Single-line yellow notice emitted for a `[skip]`.
 *   `[npm] [skip] fsevents — macOS-only filesystem watcher; never runs in Workers`
 *
 * When the entry carries an actionable suggestion it is appended inline
 * (`… try: <hint>`) — the same line shape for optional-shard skips and
 * required-package skips, so one grep explains every package the install
 * left out.
 */
export function formatTransitiveSkip(r: PackageRejectEntry): string {
  const base = `[npm] ${ANSI_YELLOW}[skip]${ANSI_RESET} ${r.from} — ${r.reason}`;
  if (r.suggest) return `${base} ${ANSI_DIM}… try:${ANSI_RESET} ${r.suggest}`;
  return base;
}


// ─────────────────────────────────────────────────────────────────────────
// Registry telemetry hook
// ─────────────────────────────────────────────────────────────────────────
//
// When a swap fires, a reject throws, or a transitive-skip drops a package,
// we emit a `RegistryEvent` so an external sink can aggregate these signals
// (e.g. "which rejected packages should we invest in swapping next?").
//
// Design:
//   - Pluggable sink: callers register a single global sink via
//     `setRegistryEventSink(...)`. The sink runs on the supervisor isolate;
//     the facet isolate collects events into a side-channel array
//     (ResolveOneResult.events) which the supervisor drains.
//   - Sink throws are CAUGHT (telemetry must never break the install path)
//     and counted via `getSinkThrowCount()` so production can detect
//     misbehaving sinks.
//   - Default sink: src/index.ts installs a JSONL-to-stdout sink at module
//     top so events show up in `wrangler tail`. Replace with
//     a durable analytics sink when needed.

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
 *   - `transitive-skip` — `from` was dropped silently from the resolved
 *                         tree at depth>0 (policy refusal, optional peer
 *                         in REJECT_INSTALL, or optional native binding).
 */
export type RegistryEvent =
  | { type: 'swap'; from: string; to: string; ctx: 'top' | 'transitive' }
  | { type: 'reject'; from: string; reason: string; suggest?: string; ctx: 'top' | 'transitive' }
  // Advisory: the package installed (npm parity — real npm keeps a
  // package that cannot run here); the note names the reason.
  | { type: 'advisory'; from: string; reason: string; suggest?: string; ctx: 'top' | 'transitive' }
  | { type: 'transitive-skip'; from: string; reason: string };

export type RegistryEventSink = (e: RegistryEvent) => void;

let _sink: RegistryEventSink | null = null;
let _sinkThrowCount = 0;

/**
 * Install (or clear, with `null`) the global registry event sink.
 *
 * The sink is a per-isolate singleton. The supervisor isolate's sink does
 * NOT propagate to facet isolates — facet emits travel through
 * `ResolveOneResult.events` and are flushed by the supervisor
 * after the facet returns.
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

/**
 * Minimal manifest shape consumed by the native-artifact classifier.
 * Carries the npm bin map plus the package's platform-constraint
 * metadata.
 */
export interface PackageBinManifest {
  name: string;
  bin?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  libc?: string[];
}

/**
 * Heuristic: does this packument represent a platform-native binding
 * that workerd cannot load?
 *
 * Returns true when ANY of:
 *   - `os`, `cpu`, or `libc` field is non-empty (npm spec platform
 *     constraints — package is opting out of cross-platform installs).
 *   - `main` ends in `.node` (Node.js N-API binary, not workerd-loadable).
 *   - name matches a known native-shard glob
 *     (policy.nativeShardPrefixes).
 *
 * Returns false for pure-JS packages, parent wrappers (e.g. the
 * non-platform `@parcel/watcher` itself), packuments with empty
 * platform-constraint arrays, and exempted pure-WASM builds
 * (policy.nativeShardExemptions).
 *
 * X.5-G G1: the resolver consults this on every packument fetched from
 * a transitive `optionalDependencies` entry. Returns-true → silent-skip
 * (emit a `transitive-skip` RegistryEvent, drop the package from the
 * resolved tree).
 *
 * Serialized into facet preambles — self-contained by contract.
 */
export function policyIsOptionalNativeBinding(
  policy: PackageAbiPolicy,
  p: MinimalPackument,
): boolean {
  if (!p) return false;
  if (Array.isArray(p.os) && p.os.length > 0) return true;
  if (Array.isArray(p.cpu) && p.cpu.length > 0) return true;
  if (Array.isArray(p.libc) && p.libc.length > 0) return true;
  if (typeof p.main === 'string' && /\.node$/.test(p.main)) return true;
  if (typeof p.name === 'string' && !policy.nativeShardExemptions.includes(p.name)) {
    for (const prefix of policy.nativeShardPrefixes) {
      // Require the prefix-then-something-else shape. The parent package
      // (e.g. `@parcel/watcher`) does not match.
      if (p.name.startsWith(prefix) && p.name.length > prefix.length) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Classify a package's published artifacts against the Nimbus ABI policy.
 * Two halves, two install outcomes:
 *
 *   - policyNativeBinAdvisory — any bin target with a native executable
 *     extension (.exe, .node N-API binaries, …). Real npm installs
 *     these: the artifact only fails when invoked, so install keeps the
 *     package and reports an advisory naming the reason.
 *   - policyNativePlatformReject — package.json `os` / `cpu` / `libc`
 *     allowlists. A positive allowlist means the package opts out of
 *     cross-platform installs (npm rejects mismatches with
 *     EBADPLATFORM); no allowlisted platform is executable in Nimbus.
 *     Pure negations (`!win32`) do NOT classify as native — they exclude
 *     platforms without requiring one.
 *
 * Diagnostics always name the package, the artifact class found
 * (policy.nativeArtifactClass), and the artifact kinds Nimbus accepts
 * instead.
 *
 * Serialized into facet preambles — self-contained by contract.
 */
export function policyNativeBinAdvisory(
  policy: PackageAbiPolicy,
  pkg: PackageBinManifest,
): PackageRejectEntry | undefined {
  const fileExtension = (path: string): string => {
    const text = String(path || '');
    const query = text.indexOf('?');
    const fragment = text.indexOf('#');
    const end = query < 0
      ? (fragment < 0 ? text.length : fragment)
      : (fragment < 0 ? query : Math.min(query, fragment));
    const clean = text.slice(0, end);
    const name = clean.slice(clean.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot).toLowerCase() : '';
  };
  for (const target of Object.values(pkg.bin ?? {})) {
    const ext = fileExtension(target);
    if (policy.nativeBinExtensions.includes(ext)) {
      return {
        from: pkg.name,
        reason:
          `Package ${pkg.name} exposes native executable bin '${target}' ` +
          `(artifact class '${policy.nativeArtifactClass}'). ` +
          'Nimbus cannot execute Linux/Windows/macOS native binaries; ' +
          `publish a JavaScript, WASM, or ${policy.abiTarget} artifact.`,
        transitive: 'fail',
      };
    }
  }
  return undefined;
}

/**
 * The install-time refusal half: package.json `os` / `cpu` / `libc`
 * allowlists. A positive allowlist means the package opts out of
 * cross-platform installs — npm rejects mismatches with EBADPLATFORM,
 * and no allowlisted platform is executable in Nimbus. Pure negations
 * (`!win32`) do NOT classify as native — they exclude platforms without
 * requiring one.
 *
 * Serialized into facet preambles — self-contained by contract.
 */
export function policyNativePlatformReject(
  policy: PackageAbiPolicy,
  pkg: PackageBinManifest,
): PackageRejectEntry | undefined {
  const allowlisted = (values?: string[]): string[] =>
    Array.isArray(values)
      ? values.filter((v) => typeof v === 'string' && v.length > 0 && !v.startsWith('!'))
      : [];
  const os = allowlisted(pkg.os);
  const cpu = allowlisted(pkg.cpu);
  const libc = allowlisted(pkg.libc);
  if (os.length > 0 || cpu.length > 0 || libc.length > 0) {
    const constraints = [
      os.length > 0 ? `os=[${os.join(', ')}]` : '',
      cpu.length > 0 ? `cpu=[${cpu.join(', ')}]` : '',
      libc.length > 0 ? `libc=[${libc.join(', ')}]` : '',
    ].filter((part) => part.length > 0).join(' ');
    return {
      from: pkg.name,
      reason:
        `Package ${pkg.name} only ships platform-native artifacts (${constraints}; ` +
        `artifact class '${policy.nativeArtifactClass}'). ` +
        'Nimbus cannot execute Linux/Windows/macOS native binaries; ' +
        `publish a JavaScript, WASM, or ${policy.abiTarget} artifact.`,
      transitive: 'fail',
    };
  }
  return undefined;
}

/**
 * Union of the two halves above — kept for the optional-native-binding
 * skip classifier, which treats either native shape as skippable from
 * an optional edge.
 */
export function policyNativeArtifactReject(
  policy: PackageAbiPolicy,
  pkg: PackageBinManifest,
): PackageRejectEntry | undefined {
  return (
    policyNativeBinAdvisory(policy, pkg) ??
    policyNativePlatformReject(policy, pkg)
  );
}

// Supervisor wrappers over the serializable policy functions.

export function isOptionalNativeBinding(p: MinimalPackument): boolean {
  return policyIsOptionalNativeBinding(PACKAGE_ABI_POLICY, p);
}

export function nativeExecutableReject(pkg: PackageBinManifest): PackageRejectEntry | undefined {
  return policyNativeArtifactReject(PACKAGE_ABI_POLICY, pkg);
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


// ─────────────────────────────────────────────────────────────────────────
// Module-load assertion: swap and reject `from` names are disjoint
// ─────────────────────────────────────────────────────────────────────────

(() => {
  for (const s of PACKAGE_ABI_POLICY.swaps) {
    if (PACKAGE_ABI_POLICY.rejects.some((r) => r.from === s.from)) {
      throw new Error(
        `Registry conflict: '${s.from}' is in both swaps and rejects. ` +
          `A name must own one role.`,
      );
    }
  }
})();
