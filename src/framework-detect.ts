/**
 * framework-detect.ts — single source of truth for "what kind of project
 * is this?" Pure function — no I/O of its own. Takes a parsed
 * package.json + a set of root-level filenames + (optional) per-file
 * contents and returns a discriminated union.
 *
 * Resolution order (first match wins):
 *
 *   0. Wrangler-on-framework override:
 *      `wrangler.{toml,jsonc,json}` at root AND any framework dep present
 *      → framework: <fw>, devCommand: 'wrangler-dev'
 *      W10's wrangler-dev path loads the framework's CF adapter.
 *      MUST come first — Remix-on-CF and SK-on-CF projects have BOTH a
 *      framework dep AND a wrangler config; without this rule W10's
 *      path never sees them.
 *
 *   1. `next` in deps                            → 'next'
 *   2. `astro` in deps                           → 'astro'
 *   3. `nuxt` in deps                            → 'nuxt'
 *   4. `@remix-run/dev` in deps AND vite.config* references @remix-run/dev
 *                                                → 'remix'
 *   5. `@sveltejs/kit` in deps                   → 'sveltekit'
 *   6. (rule moved to step 0)
 *   7. `wrangler.{toml,jsonc,json}` alone        → 'wrangler'
 *   8. `vite` in deps                            → 'vite' (generic)
 *   9. else                                      → 'unknown'
 *
 * Bare `@remix-run/react` without `@remix-run/dev` falls through to step 7
 * — it's a runtime dep alone, not a Remix v2 vite-plugin project.
 *
 * See audit/sections/W11-plan.md §4 for the full spec + rationale.
 */

export type Framework =
  | 'next'
  | 'astro'
  | 'nuxt'
  | 'remix'
  | 'sveltekit'
  | 'vite'
  | 'wrangler'
  | 'unknown';

export type DevCommand =
  | 'next-cli'
  | 'astro-cli'
  | 'nuxt-cli'
  | 'remix-cli'
  | 'sveltekit-vite'
  | 'vite-real'
  | 'wrangler-dev'
  | 'generic';

export interface DetectInput {
  pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  /** Basenames at project root, e.g. {'package.json', 'svelte.config.js'} */
  files: Set<string>;
  /**
   * Optional: file contents keyed by basename. Currently used for:
   *   - vite.config.{ts,js,mjs} — Remix gate (must reference @remix-run/dev)
   * If undefined, the Remix gate falls back to dep-presence only with a
   * lower confidence.
   */
  fileContents?: Record<string, string>;
}

export interface DetectResult {
  framework: Framework;
  /** 0..1; ≥0.7 means "act on it without asking". */
  confidence: number;
  /** Human-readable reason, suitable for logging to the user terminal. */
  reason: string;
  /** What the supervisor should treat `npm run dev` as. */
  devCommand: DevCommand;
}

const WRANGLER_CONFIG_FILES = ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json'];
const VITE_CONFIG_FILES = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs'];

function hasDep(pkg: DetectInput['pkg'], name: string): boolean {
  return (
    !!(pkg.dependencies && pkg.dependencies[name]) ||
    !!(pkg.devDependencies && pkg.devDependencies[name])
  );
}

function hasAnyFile(files: Set<string>, candidates: string[]): string | null {
  for (const c of candidates) {
    if (files.has(c)) return c;
  }
  return null;
}

function readViteConfig(input: DetectInput): { name: string; contents: string } | null {
  if (!input.fileContents) return null;
  for (const c of VITE_CONFIG_FILES) {
    if (input.fileContents[c]) return { name: c, contents: input.fileContents[c] };
  }
  return null;
}

/**
 * Detect what framework "owns" this project for purposes of routing
 * `npm run dev`/`npm run build`. Pure; deterministic; no I/O.
 */
export function detectFramework(input: DetectInput): DetectResult {
  const { pkg, files } = input;

  // ── Step 0: Wrangler-on-framework override ──────────────────────────
  const wranglerCfg = hasAnyFile(files, WRANGLER_CONFIG_FILES);
  if (wranglerCfg) {
    // Determine the underlying framework first (informational).
    const underlying = detectUnderlyingFramework(input);
    if (underlying.framework !== 'unknown' && underlying.framework !== 'wrangler') {
      return {
        framework: underlying.framework,
        confidence: 0.85,
        reason:
          `wrangler config (${wranglerCfg}) AND ${underlying.reason} — routing through ` +
          `wrangler-dev so the framework's Cloudflare adapter loads.`,
        devCommand: 'wrangler-dev',
      };
    }
  }

  // ── Steps 1-5 + 7-9: underlying framework (or generic) ───────────────
  return detectUnderlyingFramework(input);
}

function detectUnderlyingFramework(input: DetectInput): DetectResult {
  const { pkg, files } = input;

  // Step 1: Next.js
  if (hasDep(pkg, 'next')) {
    return {
      framework: 'next',
      confidence: 0.95,
      reason: "found 'next' in dependencies",
      devCommand: 'next-cli',
    };
  }

  // Step 2: Astro
  if (hasDep(pkg, 'astro')) {
    return {
      framework: 'astro',
      confidence: 0.95,
      reason: "found 'astro' in dependencies",
      devCommand: 'astro-cli',
    };
  }

  // Step 3: Nuxt
  if (hasDep(pkg, 'nuxt')) {
    return {
      framework: 'nuxt',
      confidence: 0.95,
      reason: "found 'nuxt' in dependencies",
      devCommand: 'nuxt-cli',
    };
  }

  // Step 4: Remix v2 (vite-plugin path).
  // Gate: @remix-run/dev in deps AND vite.config* references @remix-run/dev.
  if (hasDep(pkg, '@remix-run/dev')) {
    const cfg = readViteConfig(input);
    if (cfg && cfg.contents.includes('@remix-run/dev')) {
      return {
        framework: 'remix',
        confidence: 0.95,
        reason: `found '@remix-run/dev' in deps and ${cfg.name} imports it`,
        devCommand: 'remix-cli',
      };
    }
    // Lower-confidence fallback: dep present but no contents to verify.
    if (!input.fileContents) {
      return {
        framework: 'remix',
        confidence: 0.7,
        reason: "found '@remix-run/dev' in deps (vite.config contents not inspected)",
        devCommand: 'remix-cli',
      };
    }
    // Contents inspected and the import is missing — fall through.
  }

  // Step 5: SvelteKit
  if (hasDep(pkg, '@sveltejs/kit')) {
    return {
      framework: 'sveltekit',
      confidence: 0.95,
      reason: "found '@sveltejs/kit' in dependencies",
      devCommand: 'sveltekit-vite',
    };
  }

  // Step 7: standalone wrangler (no framework deps)
  if (hasAnyFile(files, WRANGLER_CONFIG_FILES) || hasDep(input.pkg, 'wrangler')) {
    return {
      framework: 'wrangler',
      confidence: 0.85,
      reason: "wrangler config or dep present, no framework dep — routing to wrangler-dev",
      devCommand: 'wrangler-dev',
    };
  }

  // Step 8: generic Vite
  if (hasDep(pkg, 'vite')) {
    return {
      framework: 'vite',
      confidence: 0.7,
      reason: "found 'vite' in dependencies (no specific framework)",
      devCommand: 'vite-real',
    };
  }

  // Step 9: unknown
  const depCount =
    Object.keys(pkg.dependencies || {}).length +
    Object.keys(pkg.devDependencies || {}).length;
  return {
    framework: 'unknown',
    confidence: depCount === 0 ? 0.1 : 0.3,
    reason:
      depCount === 0
        ? 'no dependencies declared'
        : 'no recognized framework dep (next/astro/nuxt/remix/sveltekit/vite)',
    devCommand: 'generic',
  };
}

/**
 * Companion helper: detection result is reportable as a one-line MOTD.
 * Used by initSession to print a single boot line:
 *   [nimbus] detected framework: sveltekit (sveltekit-vite, conf=0.95)
 */
export function describeDetect(result: DetectResult): string {
  return (
    `framework=${result.framework} dev=${result.devCommand} ` +
    `confidence=${result.confidence.toFixed(2)} (${result.reason})`
  );
}
