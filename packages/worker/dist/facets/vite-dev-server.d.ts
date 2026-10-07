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
 *     ├── /@modules/<pkg>      → resolve from node_modules, bundle in the build facet (synthetic-entry for barrels)
 *     ├── /@vite/client        → HMR client script
 *     ├── /*.json (as module)  → export default { ... }
 *     ├── /*.svg,*.png,... (as module) → export default "/preview/path/to/asset"
 *     └── /*                   → serve from VFS as-is (static assets)
 *
 * HMR: VFS events → ViteDevServer detects changes → sends {type:'hmr'}
 *       messages through the DO WebSocket → frontend dispatches to iframe.
 */
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { EsbuildService } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { type ViteEsbuildSettings } from '@nimbus-sh/core/runtime/vite-esbuild-options.js';
import type { BundlePoolProvider } from './prebundle-pool.js';
import type { ParsedViteConfig } from '@nimbus-sh/core/runtime/vite-config-parser.js';
export interface ViteDevServerOptions {
    vfs: SqliteVFS;
    /**
     * Who the server reads and writes as: the credential of the process it
     * runs under, the command that started it. Everything it serves, bundles
     * or synthesizes goes through the VFS as this principal.
     */
    cred: VfsCred;
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
    /** Worker bindings env (ASSETS for vendored bundles). */
    env?: any;
    /** Durable Object state. */
    ctx?: DurableObjectState;
    /**
     * The session's pre-bundle pool (its build facet), shared with the
     * install-time pre-bundler. When provided, /preview/@modules/<spec>
     * misses bundle there from a slice, rather than through the session's
     * EsbuildService and its VFS plugin (the path callers without a LOADER
     * binding take).
     */
    bundlePool?: BundlePoolProvider;
    /**
     * process diagnostics support: when set, every diagnostic the dev server
     * would otherwise drop into Worker logs (console.warn / console.error)
     * is ALSO appended to the session process supervisor's per-PID log
     * ring at this PID, on the 'stderr' stream. The Process tab in the
     * frontend reads from this store, so the user finally sees a real log
     * of what the dev server is doing — no more "silent after banner."
     */
    pid?: number;
    processes?: {
        appendOutput(pid: number, stream: 'stdout' | 'stderr', data: string): void;
    };
    /**
     * The directory whose vite.config `aliases`, `define` and `injectBasename`
     * were read from (vite-config-file.ts), as a VFS path: when one there is
     * added, changed or removed, the server reads it again and drops what it
     * made under the old one, as Vite restarts on an edit of its config.
     * Absent: the options are the caller's own (/api/start-vite), never re-read.
     */
    configDir?: string;
    /** Told each config the server reads again (null: no vite.config there now), so a restore after hibernation starts from it. */
    onConfigChange?: (config: ParsedViteConfig | null) => void;
    /**
     * What the project's vite.config sets for Vite's esbuild plugin
     * (core vite-esbuild-options.ts's viteEsbuildSettings of the config `vite`
     * read). Absent: no vite.config, Vite's defaults and the server's own JSX.
     */
    viteEsbuild?: ViteEsbuildSettings;
}
/**
 * esbuild, when bundling CJS source with `external` specifiers, leaves the
 * `require("pkg")` calls in the output wrapped in a `__require()` helper that
 * falls back to the global `require`. In the browser there is no global
 * `require`, so every such call throws.
 *
 * The fix: detect all distinct `__require("X")` specifiers in the output,
 * emit a top-level ESM `import * as __ns_X from "X"` for each, and replace
 * every `__require("X")` call with a reference to that namespace (with
 * default-export interop — `__ns_X.default ?? __ns_X`).
 *
 * Before:
 *   var __require = ((x) => typeof require !== "undefined" ? require : ...);
 *   var React = __require("react");
 *
 * After:
 *   import * as __nimbus_ext__react from "react";
 *   const __nimbus_req = (id) => {
 *     if (id === "react") return __nimbus_ext__react.default ?? __nimbus_ext__react;
 *     throw new Error("require: " + id);
 *   };
 *   var __require = ((x) => typeof require !== "undefined" ? require : ...);
 *   var React = __nimbus_req("react");
 *
 * We inject `__nimbus_req` but keep esbuild's `__require` definition so we
 * don't have to rewrite its declaration — we just replace the call-sites.
 */
export declare function rewriteExternalRequires(code: string, basePath: string): string;
/**
 * esbuild bundles CJS packages by wrapping them in __commonJS helpers.
 * The resulting ESM bundle only has `export default require_X()` — no named
 * exports. This breaks `import { createRoot } from "react-dom/client"`.
 *
 * We fix this by STATICALLY analyzing the bundled source to find CJS export
 * patterns, then emitting named exports for each found name. We cannot use
 * `new Function()` or `eval()` to get runtime export keys because the
 * Cloudflare Workers runtime disallows string-to-code generation outside of
 * module initialization.
 *
 * The names are the CJS scan's Vite policy over the entire bundled text:
 * `exports.NAME =`, `exports["NAME"] =`, `module.exports.NAME =`, every
 * `Object.defineProperty(exports, "NAME", ...)`, and every key of a
 * `module.exports = { ... }` literal whatever its value.
 *
 * Input  (esbuild output):
 *   var require_X = __commonJS({ "...": function(exports) { exports.jsx = ...; exports.jsxs = ...; } });
 *   export default require_X();
 *
 * Output (synthesized):
 *   var require_X = __commonJS({...});
 *   const __nimbus_ns = require_X();
 *   export default __nimbus_ns;
 *   export const jsx = __nimbus_ns.jsx;
 *   export const jsxs = __nimbus_ns.jsxs;
 *
 * Note: we emit `export const NAME = __nimbus_ns.NAME` per key rather than
 * `export const { NAME, ... } = __nimbus_ns` destructuring. The former
 * preserves live binding semantics slightly better and avoids issues when
 * a key name happens to shadow a keyword or identifier.
 *
 * Returns the original code unchanged if:
 *   - The bundle already has named exports (not a CJS-only bundle)
 *   - No `export default` pattern found
 *   - No CJS export patterns found in the bundle source
 */
export declare function synthesizeCjsNamedExports(code: string): string;
/**
 * A module that fails in the page with `diag`. It declares `names` (each
 * undefined) beside its default, so an importer of any of them links, and
 * throws `diag` as it evaluates: the preview's overlay shows that, where a
 * module lacking a name the importer asks for would fail to link with "does
 * not provide an export named ..." and never run.
 */
export declare function failingModule(diag: string, names: Iterable<string>): string;
/**
 * The package scope of an importing file, read once: the first package.json
 * up from it (Node's rule: the first one wins, `imports` or not) and its
 * `imports`. A `#X` specifier resolves against this snapshot alone, so what
 * a module's imports are rewritten to is a function of what was read when
 * its request was made, which its cache key carries (npm/cache-keys.ts).
 */
interface PackageScope {
    /** VFS path of the directory holding the package.json. */
    dir: string;
    /** Its `imports`, or null (none, or an unreadable package.json). */
    imports: unknown;
}
/**
 * Importer context for `#X` subpath-import resolution. The dev-server
 * passes this through `rewriteAllImports` whenever it knows the source
 * file the imports came from (transformed user TS files, user JS).
 */
interface HashImportCtx {
    /** Project root (e.g. `home/user/example-app`). Used to clip the resolved
     *  target to a /preview-relative URL. */
    root: string;
    /** The importing file's package scope (packageScopeOf), or null where it has none. */
    scope: PackageScope | null;
}
/**
 * Rewrite all bare import/export specifiers in JS code.
 *
 * Handles ALL import forms including multi-line:
 *   1. import "specifier"                       (side-effect)
 *   2. import defaultExport from "specifier"     (default)
 *   3. import { named } from "specifier"         (named, possibly multi-line)
 *   4. import * as ns from "specifier"           (namespace)
 *   5. export { named } from "specifier"         (re-export)
 *   6. export * from "specifier"                 (re-export all)
 *   7. import("specifier")                       (dynamic)
 */
export declare function rewriteAllImports(code: string, aliases?: Record<string, string>, basePath?: string, importerCtx?: HashImportCtx): string;
export declare class ViteDevServer {
    private vfs;
    private vfsEvents;
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
    private env;
    private ctx;
    /** The session's pre-bundle pool; null = bundle through the EsbuildService. */
    private readonly bundlePool;
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
     * process diagnostics support: the supervisor's per-PID log store. When set
     * (alongside `pid`), every diagnostic emitted by the dev server is
     * appended here on the 'stderr' stream so the Process tab UI shows
     * a real, scrolling, trace of bundler activity. When unset, falls
     * back to console.warn / console.error only (legacy behaviour).
     */
    private logPid;
    private logSink;
    /** The vite.config directory the server re-reads (ViteDevServerOptions.configDir), or null. */
    private configDir;
    private onConfigChange;
    /**
     * Bumped each time the config the served modules depend on changes (a
     * vite.config read again, a tsconfig edited): a module a request began
     * making under an older one is served to that request, not remembered.
     */
    private configGeneration;
    /** The config re-read in flight, so edits in a burst read it once more, in order. */
    private configReload;
    /** What the project's vite.config sets for Vite's esbuild plugin. */
    private viteEsbuild;
    /** Each ts or tsx module's tsconfig, as tsconfck found it; forgotten with the modules. */
    private tsconfigs;
    /** Every config file the tsconfigs were read from: an edit of one changes how modules compile. */
    private tsconfigFiles;
    /** What has been said once (warnOnce). */
    private warned;
    constructor(opts: ViteDevServerOptions);
    /**
     * The session's pre-bundle pool for on-demand bundling of
     * /preview/@modules/<spec> requests that miss both the in-memory and
     * pkg_esm_bundles caches. Null when no pool was provided (the
     * EsbuildService fallback). Acquired BEFORE the slice lease — see
     * PrebundlePool.acquire.
     */
    private ensureOnDemandPool;
    /**
     * The bundle_hash a pre-bundle of `specifier` from `sources` has when the
     * code serving this server made it for this server's request
     * (npm/cache-keys.ts): by the build facet (the install's, or the pooled
     * path below), or by the service's build with no pool. The manifests
     * among `sources` are read now: a row built before a reinstall is not
     * this one's.
     */
    private bundleKeys;
    /** Detect TailwindCSS usage in the project */
    private detectTailwind;
    /**
     * Normalise a per-request mount base to the canonical form used for URL
     * rewriting and cache keys: '' for a root-mounted request (the served app
     * lives at the origin root, as on a `<port>--<sid>` host), otherwise the
     * prefix with any trailing slash stripped (e.g. '/s/otter-4271/preview').
     */
    private normBase;
    /** import.meta.env.BASE_URL for a mount base — always a trailing-slash URL. */
    private baseUrlValue;
    /** esbuild define set for a request served under `base`. */
    private defineFor;
    /** Whether this server's principal may read `path`. */
    /** `path`'s text, or null where this server cannot read it. */
    private readText;
    private mayRead;
    /**
     * Module-cache key for `key` under mount base `base`. The transformed text
     * embeds the base (module URLs, <base href>, BASE_URL, router basename), so
     * a module built for one base must never be served for another. NUL is used
     * as the separator because it cannot occur in a base or a VFS path.
     */
    private ck;
    /**
     * Rewrite absolute paths in HTML so they resolve under `base`.
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
    /**
     * Drop every module this server made (in memory; persisted rows are keyed
     * on their request) and move to a new config generation, so a request
     * still in flight under the old one does not put its module back.
     */
    private forgetModules;
    /** Log `message` as a warning, the first time only. */
    private warnOnce;
    /** The tsconfig the module `id` (an absolute VFS path) compiles under, as tsconfck finds it for Vite. */
    private tsconfigFor;
    /** moduleCache.set, unless the config changed since `generation` (the module was made under the old one). */
    private cacheModule;
    /**
     * Read the vite.config in configDir again (after the read in flight) and
     * take its aliases, define and injectBasename, as `vite` read them at
     * start; then forget every module and tell the browser to reload. A config
     * that cannot be read leaves the server on the one it has, as Vite keeps
     * running when a restart fails. What only a new `vite` takes (root, base,
     * port, outDir) is named in the log.
     */
    private reloadConfig;
    /**
     * reloadConfig, for a caller that knows the config may have changed
     * unseen (a server restored after hibernation, when no edit was watched):
     * settled once the config is read.
     */
    readConfigAgain(): Promise<void>;
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
    handleRequest(request: Request, pathname: string, mountBase?: string): Promise<Response>;
    private _handleRequestInner;
    private serveIndexHtml;
    /**
     * An HTML page as the dev server serves it: `rootHead` (the root page's
     * <base>), the Tailwind Play bundle for a Tailwind project, and the error
     * overlay and HMR client, before </head> (else before <body, else first),
     * with absolute paths under the mount base.
     */
    private withDevHead;
    /**
     * A pre-bundle as the browser loads it under the mount `base`, from
     * esbuild's base-independent output. `__require("external")` calls (CJS
     * source with esbuild externals) become ESM `import * as` + dispatch, so
     * externalized packages (react, scheduler) work. Bare imports esbuild
     * marked external carry the base: without it `import X from "scheduler"`
     * 404s. A CJS-only package's __commonJS wrapper emits only `export
     * default`, so its named exports are synthesized from a static scan, or
     * `import { createRoot } from "react-dom/client"` would fail.
     */
    private servablePrebundle;
    private getBarrelModuleCacheInfo;
    /**
     * Whether a cached bundle answers this request. A bundle synthesized from
     * some names (its inputHash set) answers only a barrel request for those
     * names; any other request, a barrel's whose project scan left files
     * unread among them, takes only a whole bundle.
     */
    private cachedModuleMatchesBarrelInput;
    private serveModule;
    /**
     * Cold path of serveModule: package resolution → on-demand facet
     * bundle (synthetic-entry for barrels) → hard-error if bundle fails.
     * NO CDN fallback (100% edge contract). Extracted so the coalescing
     * wrapper in serveModule() reads cleanly. The slice this body builds is
     * leased from the shared supervisor allocation budget for its worst
     * case before it is built, shrunk to its real size once built, and
     * released only after the facet result has been rewritten, cached and
     * wrapped in the Response — the pre-bundler's per-slice pattern.
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
    /** A module that shows `e`, the transform's error, in the page's overlay, as Vite's does. */
    private transformErrorModule;
    /**
     * Everything a served .ts/.tsx/.jsx module is a function of, beside its
     * text and the engines: the transform's options (with the define, the
     * mount's BASE_URL folded in), the mount base a router basename is
     * injected with (null: none), and what the import rewrite reads (null: an
     * importmap leaves imports alone) — the aliases, the base, and the
     * `imports` of the package.json a `#name` resolves in. The persisted row
     * is keyed on it whole (npm/cache-keys.ts).
     */
    private transformRequest;
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
export {};
//# sourceMappingURL=vite-dev-server.d.ts.map