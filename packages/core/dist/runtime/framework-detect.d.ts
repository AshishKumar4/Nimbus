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
 */
export type Framework = 'next' | 'astro' | 'nuxt' | 'remix' | 'sveltekit' | 'vite' | 'wrangler' | 'unknown';
export type DevCommand = 'next-cli' | 'astro-cli' | 'nuxt-cli' | 'remix-cli' | 'sveltekit-vite' | 'vite-real' | 'wrangler-dev' | 'generic';
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
/**
 * Detect what framework "owns" this project for purposes of routing
 * `npm run dev`/`npm run build`. Pure; deterministic; no I/O.
 */
export declare function detectFramework(input: DetectInput): DetectResult;
/**
 * Companion helper: detection result is reportable as a one-line MOTD.
 * Used by initSession to print a single boot line:
 *   [nimbus] detected framework: sveltekit (sveltekit-vite, conf=0.95)
 */
export declare function describeDetect(result: DetectResult): string;
//# sourceMappingURL=framework-detect.d.ts.map