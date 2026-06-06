/**
 * ViteDevServer v2.0 — lightweight Vite-compatible dev server for Nimbus.
 *
 * Not actual Vite (which is 200+ packages). This is a purpose-built dev server
 * that implements the subset of Vite's behavior needed for serving modern
 * web apps: TS/TSX/JSX transform, bare import rewriting, HMR full-reload,
 * path alias resolution, TailwindCSS Play CDN, CSS-as-JS modules.
 *
 * Architecture:
 *   Browser iframe → /preview/* → DO fetch() → ViteDevServer.handleRequest()
 *     ├── /                    → serves index.html (injects HMR, Tailwind CDN, <base>)
 *     ├── /*.ts,*.tsx,*.jsx    → esbuild transform → JS with import rewrites + alias resolution
 *     ├── /*.css               → serve as text/css (with @import inlining, @tailwind stripping, @apply expansion)
 *     ├── /*.css?import        → wrap CSS in JS that injects <style> tag
 *     ├── /@modules/<pkg>      → resolve from node_modules, bundle via esbuild facet (synthetic-entry for barrels)
 *     ├── /@vite/client        → HMR client script
 *     ├── /*.json (as module)  → export default { ... }
 *     ├── /*.svg,*.png,... (as module) → export default "/preview/path/to/asset"
 *     └── /*                   → serve from VFS as-is (static assets)
 *
 * HMR: VFS events → ViteDevServer detects changes → sends {type:'hmr'}
 *       messages through the DO WebSocket → frontend dispatches to iframe.
 */
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { EsbuildService } from '../runtime/esbuild-service.js';
export interface ViteDevServerOptions {
    vfs: SqliteVFS;
    esbuild: EsbuildService;
    /** Root directory in VFS (e.g. "home/user/projects") */
    root: string;
    /** Callback to send HMR messages to the browser */
    onHmrMessage: (msg: any) => void;
    /** Port the virtual server "listens" on */
    port?: number;
    /** URL prefix the server is mounted at (e.g. "/preview"). Default: "/preview" */
    basePath?: string;
    /** Path aliases from vite.config.ts resolve.alias (e.g. { "@": "./src" }) */
    aliases?: Record<string, string>;
    /** Define replacements from vite.config.ts define (e.g. { "global": "globalThis" }) */
    define?: Record<string, string>;
    /** SqlStorage for pkg_esm_bundles cache (optional — enables local module serving) */
    sql?: SqlStorage;
    /**
     * Auto-inject React Router `basename` into entry files so <NavLink to="/x">
     * lands at `${basePath}/x`. Default: true. Set to false via
     * vite.config.ts `nimbusInjectBasename: false` to disable globally, or use
     * the `// nimbus-no-basename` comment for per-file opt-out.
     */
    injectBasename?: boolean;
    /**
     * Worker bindings env. Required for the on-demand-bundle facet path
     * (LOADER + ctx-exports). When provided, /preview/@modules/<spec>
     * misses bundle in a NimbusLoaderPool isolate instead of the
     * supervisor's EsbuildService — same architecture as the
     * pre-bundle path. Without this option, the supervisor falls back
     * to in-process esbuild (legacy behaviour).
     */
    env?: any;
    /** Durable Object state — needed alongside `env` for the facet pool. */
    ctx?: DurableObjectState;
    /**
     * process diagnostics support: when set, every diagnostic the dev server
     * would otherwise drop into Worker logs (console.warn / console.error)
     * is ALSO appended to the supervisor's per-PID ProcessLogStore at
     * this PID, on the 'stderr' stream. The Process tab in the frontend
     * reads from this store, so the user finally sees a real log of
     * what the dev server is doing — no more "silent after banner."
     */
    pid?: number;
    processLogs?: {
        append: (pid: number, stream: 'stdout' | 'stderr', data: string) => void;
    };
}
export declare class ViteDevServer {
    private vfs;
    private esbuild;
    private root;
    private onHmrMessage;
    private port;
    private basePath;
    private running;
    private moduleCache;
    private unsubVfs;
    /** True if index.html has an importmap (browser handles bare specifiers) */
    private hasImportmap;
    /** Path aliases from vite.config.ts (e.g. { "@": "./src" }) */
    private aliases;
    /** Define replacements for esbuild (e.g. { "global": "globalThis" }) */
    private define;
    /** Whether this project uses TailwindCSS */
    private hasTailwind;
    /** Parsed tailwind config JS (for CDN injection) */
    private tailwindConfigJs;
    /** NPM cache for pre-bundled ESM modules (optional). */
    private npmCache;
    /** Inject React Router basename into entry files? Default: true. */
    private injectBasename;
    /** Worker env (LOADER, ctx-exports) for the on-demand-bundle facet path.
     *  Null = legacy in-supervisor esbuild fallback. */
    private env;
    private ctx;
    /** Lazily-constructed pool for on-demand bundling. Mirrors the
     *  pre-bundle pool's wasm-modules-map shape. Created on first
     *  cold-path /preview/@modules/<spec> request. */
    private onDemandPool;
    private onDemandPoolPromise;
    /**
     * In-flight on-demand-bundle coalescing map. When the browser fires
     * multiple parallel requests for the same /preview/@modules/<spec>
     * (which happens on first preview load — every imported module
     * resolves concurrently), we want exactly ONE bundle attempt per
     * spec. The map holds the in-flight Promise<Response> keyed by
     * cacheKey; subsequent fetches return the same promise. Entry is
     * deleted when the promise settles so repeat-after-cache-expiry
     * goes through the cold path again.
     *
     * Without coalescing, N parallel requests each build a slice
     * (~28 MiB) and submit N facet RPCs in parallel. With a shared DO
     * isolate (Mini-PRD: DO shared isolate issues), the supervisor's
     * peak heap during page-load = N × slice_size + baseline, which
     * crashes the supervisor for N≥3 on a busy isolate.
     */
    private pendingBundles;
    /**
     * Single-slot semaphore for the on-demand bundle slow path. Serializes
     * slice-walk + facet-dispatch ACROSS DIFFERENT specs so the
     * supervisor holds at most ONE 28 MiB slice in memory at any time
     * during a flurry of /preview/@modules/* requests. Coupled with
     * pendingBundles (same-spec coalescing) this caps peak supervisor
     * slice memory at 28 MiB regardless of browser parallelism.
     *
     * Implementation: a chain of Promise<void> — each waiter awaits the
     * previous, runs its critical section, then releases. Latency
     * impact is bounded by per-spec bundle wall time (typically <1 s
     * for non-barrel packages); the browser's module-fetch parallelism
     * just becomes serialized at the bundler boundary, not at the wire.
     */
    private onDemandQueue;
    /**
     * process diagnostics support: the supervisor's per-PID log store. When set
     * (alongside `pid`), every diagnostic emitted by the dev server is
     * appended here on the 'stderr' stream so the Process tab UI shows
     * a real, scrolling, trace of bundler activity. When unset, falls
     * back to console.warn / console.error only (legacy behaviour).
     */
    private logPid;
    private logStore;
    constructor(opts: ViteDevServerOptions);
    /**
     * Lazily construct the NimbusLoaderPool used for on-demand bundling
     * of /preview/@modules/<spec> requests that miss both the in-memory
     * and pkg_esm_bundles caches. Mirrors the pre-bundle pool's
     * configuration: 1 worker, internal pLimit not needed (one bundle
     * per request), wasm shipped via wasmModules.
     *
     * Returns null when env/ctx aren't available (legacy fallback used).
     */
    private ensureOnDemandPool;
    /** Detect TailwindCSS usage in the project */
    private detectTailwind;
    /**
     * Rewrite absolute paths in HTML so they resolve under the basePath.
     */
    private rewriteHtmlPaths;
    /** Start the dev server (subscribe to VFS events for HMR). */
    start(): void;
    /** Stop the dev server. */
    stop(): void;
    get isRunning(): boolean;
    /**
     * process diagnostics support: single chokepoint for dev-server diagnostics.
     * Always writes to the workerd console (so wrangler tail / Worker
     * logs see it for ops triage) AND appends to the supervisor's
     * per-PID ProcessLogStore when one is wired (so the Process tab in
     * the browser shows the same line, on the same stderr stream, with
     * the same timestamp ordering). Callers no longer have to remember
     * to do both.
     *
     * Levels:
     *   - 'info': stdout stream of the Process tab; NOT echoed to the
     *     workerd console (would spam wrangler tail). Used for normal
     *     activity — request served, module bundled, HMR fired.
     *     Without this level the Process tab was silent past the
     *     synchronous `vite` builtin banner: the only call sites for
     *     log() were error / warn from cold-bundle failures, so on a
     *     clean Markflow run NOTHING reached subscribers and the tab
     *     froze on the banner content. Markflow regression on prod
     *     0a488bab.
     *   - 'warn' / 'error': stderr stream + console.warn/error. Used
     *     for cold-path bundle failures, synthetic-entry errors, and
     *     other diagnostics worth surfacing on the workerd console
     *     for ops triage.
     *
     * Trailing newline is added if missing so the log buffer is line-
     * oriented (the Process-tab UI splits on `\n`).
     */
    private log;
    /** Handle VFS change events → trigger HMR. */
    private handleVfsEvents;
    /** Normalize and sanitize a preview pathname to prevent traversal. */
    private sanitizePath;
    /**
     * Handle an HTTP request to the dev server.
     * Called from the DO's fetch() handler for /preview/* paths.
     *
     * Wraps `_handleRequestInner` so EVERY served request appears in
     * the Process tab's stdout stream (status + path + elapsed). Without
     * this, the tab was silent past the synchronous banner — the dev
     * server happily processed requests, but no per-request signal
     * reached subscribers and the user saw a frozen tab. Markflow
     * regression on prod 0a488bab.
     */
    handleRequest(request: Request, pathname: string): Promise<Response>;
    private _handleRequestInner;
    private serveIndexHtml;
    private getBarrelModuleCacheInfo;
    private cachedModuleMatchesBarrelInput;
    private serveModule;
    /**
     * Cold path of serveModule: package resolution → on-demand facet
     * bundle (synthetic-entry for barrels) → hard-error if bundle fails.
     * NO CDN fallback (100% edge contract). Extracted so the coalescing
     * + semaphore wrapper in serveModule() reads cleanly. Always runs
     * inside the on-demand semaphore — see serveModule's wrapper.
     */
    private serveModuleCold;
    /**
     * Resolve a bare package specifier (possibly with subpath) to a VFS file path.
     *
     * Algorithm:
     *   1. Parse into pkgName + subpath (e.g. "pkg/sub/deep" → pkg="pkg", subpath="sub/deep")
     *   2. Walk search dirs looking for node_modules/<pkg>/
     *   3. PREFER exports-field resolution (modern packages) with conditions
     *      [import, module, browser, default]
     *   4. FALL BACK to legacy resolution (packages without exports field):
     *      a. For subpath: try <nmDir>/<subpath>.{js,mjs,cjs,jsx,ts,tsx} — direct file
     *      b. For subpath: try <nmDir>/<subpath>/index.{js,mjs,cjs,jsx,ts,tsx}
     *      c. For subpath: try <nmDir>/<subpath>/package.json → read module/main
     *      d. For root: try pkg.module / pkg.main, then tryResolveFile
     *      e. For root: try <nmDir>/index.{ext}
     *
     * Step 4c is what makes `react-remove-scroll-bar/constants` work for legacy
     * packages without an exports field — the subpath directory has its own
     * package.json (or just an index.js that we pick up in 4b).
     */
    private resolvePackage;
    private tryResolveFile;
    /**
     * Try to resolve a URL pathname to an actual file in the VFS by applying
     * Vite/webpack-style extension resolution. This is critical for ES module
     * imports like `import App from "./App"` where the browser requests
     * /preview/src/App with no extension.
     *
     * Resolution order (matches Vite's default `resolve.extensions` plus .vue/.svelte):
     *   1. Exact file path
     *   2. path + .tsx, .ts, .jsx, .js, .mjs, .cjs, .vue, .svelte, .json
     *   3. path as directory → path/index.{ext} (covering .html for static sites)
     *   4. For .js/.mjs/.cjs/.jsx specifiers that don't resolve, try .ts/.tsx/.mts/.cts
     *      fallback — common in TypeScript projects with NodeNext module resolution
     *      (imports written as "./bar.js" while source is "./bar.ts")
     *
     * Note: `sanitizePath` strips trailing slashes before this runs, so requests
     * like `/utils/` arrive here as `/utils` — they hit the directory-index branch
     * via the `isDirectory` check, which is correct.
     */
    private resolveFileCandidate;
    /**
     * Decide whether a 404 on this request should fall back to index.html (SPA
     * routing) or stay as 404. We MUST NOT return HTML for JS module requests —
     * the browser rejects them with a MIME-type error and the whole app breaks.
     *
     * Strategy: trust `Sec-Fetch-Dest` (set by all modern browsers) as the
     * primary signal. Fall back to `Accept` header analysis + tight source-path
     * heuristics for edge cases like old clients or non-browser fetchers.
     *
     * We intentionally DO NOT treat every path under `/api/`, `/hooks/`,
     * `/components/`, etc. as a module — those are common client-side route
     * names in real React/Vue apps, and marking them as module would 404 legit
     * navigation. Only paths rooted under unambiguous build-system directories
     * (`/src/`, `/node_modules/`, `/@vite/`, `/@modules/`, `/@fs/`, `/public/`,
     * `/assets/`) are treated as definitely-not-SPA.
     */
    private isModuleRequest;
    private serveFile;
    private serveTransformed;
    get stats(): {
        running: boolean;
        port: number;
        root: string;
        cachedModules: number;
        hasTailwind: boolean;
        aliases: string[];
    };
}
//# sourceMappingURL=vite-dev-server.d.ts.map