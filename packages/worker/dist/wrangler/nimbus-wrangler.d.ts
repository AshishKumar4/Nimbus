/**
 * nimbus-wrangler.ts — Lightweight wrangler dev replacement for Nimbus.
 *
 * Architecture (from spec §8):
 *   nimbus-wrangler dev:
 *     1. Reads wrangler.jsonc/toml from VFS
 *     2. Bundles user's Worker code via EsbuildService
 *     3. Creates a dynamic worker via LOADER.load() with the bundled code
 *     4. Routes /worker/* requests to the dynamic worker's fetch()
 *     5. On VFS file change: re-bundles and recreates the dynamic worker
 *     6. Simulates KV via the worker's own storage
 *
 * The dynamic worker IS the user's Worker — running on the actual
 * Cloudflare Workers runtime, not a simulation.
 */
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { EsbuildService } from '../runtime/esbuild-service.js';
export interface NimbusWranglerOptions {
    vfs: SqliteVFS;
    esbuild: EsbuildService;
    env: any;
    /**
     * Supervisor DO's DurableObjectState. Required for ctx.facets.get()
     * when synthesizing durable_objects bindings (Phase 3). Also used for
     * ctx.exports loopback bindings when synthesizing assets / loaders.
     */
    ctx?: any;
    root: string;
    onLog: (msg: string) => void;
    onHmrMessage: (msg: any) => void;
}
/**
 * Rewrite a Location header emitted by the inner Worker so that, when
 * the browser follows it, the browser hits the outer-prefixed URL.
 *
 * Cases handled:
 *   - Same-origin absolute URL (http://localhost:.../s/foo/)
 *       → prepend outerWorkerBase to the pathname
 *   - Origin-relative (/s/foo/, /new)
 *       → prepend outerWorkerBase
 *   - Path-relative (foo/bar)
 *       → leave untouched (browser resolves against current URL, which
 *         is already outer-prefixed)
 *   - Cross-origin absolute URL (https://example.com/...)
 *       → leave untouched
 *   - Malformed / non-URL strings
 *       → leave untouched
 *
 * The outerWorkerBase is the full path prefix (e.g.
 * "/s/nimble-otter-4271/worker"); do not include a trailing slash.
 */
export declare function rewriteLocationForOuter(location: string, outerWorkerBase: string, currentRequestUrl: string): string;
export declare class NimbusWrangler {
    private vfs;
    private esbuild;
    private loaderEnv;
    private supervisorCtx;
    private root;
    private onLog;
    private onHmrMessage;
    private running;
    private config;
    private workerStub;
    private buildVersion;
    private unsubVfs;
    private rebuildTimer;
    /** DO class map: binding name → DurableObjectClass from the inner worker. */
    private doClassMap;
    /** Facet names we've created via ctx.facets.get — aborted on rebuild / stop. */
    private doFacetNames;
    constructor(opts: NimbusWranglerOptions);
    /** Start the wrangler dev server. */
    start(): Promise<boolean>;
    /** Stop the wrangler dev server. */
    stop(): void;
    get isRunning(): boolean;
    private readConfig;
    /** Minimal TOML parser — handles key = "value" and main/name/compatibility_date. */
    private parseMinimalToml;
    /**
     * Resolve the user's `main:` entry to a canonical VFS-key path.
     *
     * The wrangler.jsonc `main` field is user-controlled and templates
     * commonly emit any of:
     *   - "src/index.ts"     — clean relative
     *   - "./src/index.ts"   — npm-style with leading dot
     *   - "/src/index.ts"    — workspace-absolute mistake
     *   - "src//index.ts"    — accidental double-slash
     *
     * Naive `this.root + '/' + main` concatenation produced a malformed
     * VFS key for every shape except the first, so vfs.exists() returned
     * false even when the file was present at the canonical location.
     *
     * normalizeVfsPath collapses '.', '..', '//' runs and strips leading
     * slashes — exactly the canonicalization SqliteVFS expects (every
     * inode key in the live store is no-leading-slash, no internal
     * doubles; src/vfs/sqlite-vfs.ts:_mkdirSingle uses the same
     * `path.split('/').filter(Boolean)` shape via `normalizePath`).
     */
    private resolveEntryPath;
    private buildAndLoad;
    private buildInnerEnv;
    private handleVfsEvents;
    /**
     * Forward a request to the user's Worker.
     * Called from the DO's fetch() handler for /worker/* paths.
     *
     * Three things this proxy does besides a raw fetch:
     *  1. Buffers the request body to an ArrayBuffer before forwarding.
     *     The inner Worker can legitimately respond with a 302 (e.g.
     *     Nimbus-in-Nimbus: POST /new → 302 /s/<id>/). Workerd's `fetch`
     *     defaults to follow-redirects which requires replaying the body;
     *     a stream body can only be read once. Buffering first sidesteps
     *     the "one-time-use body encountered a redirect" error. POSTs to
     *     Nimbus's own /new endpoint are typically empty, but KV/D1 sims
     *     and user workers may send non-trivial bodies.
     *  2. Uses `redirect: 'manual'` so the inner's Location header comes
     *     back unchanged. We rewrite it below to prepend the outer worker
     *     prefix — otherwise the browser follows a bare `/s/<id>/` URL,
     *     which is an OUTER route and spawns a different session, not
     *     what the user wanted.
     *  3. Replaces a "Not found" 404 at the inner root with a small
     *     landing page. Nimbus itself (the likely inner worker) has no
     *     route for `/` when loaded without an ASSETS binding — users
     *     hitting `/s/<outer>/worker/` directly would otherwise see a
     *     bare 9-byte "Not found" response and think the whole thing
     *     broke. The landing page explains the Worker is running and
     *     points them at `/worker/new` / their own routes.
     */
    handleRequest(request: Request, pathname: string, 
    /**
     * Outer-facing prefix of this proxy (e.g. "/s/nimble-otter-4271/worker").
     * Used to rewrite inner-emitted Location headers that reference
     * their own origin-relative paths. When absent, Location headers
     * are passed through unchanged.
     */
    outerWorkerBase?: string): Promise<Response>;
    get stats(): {
        running: boolean;
        name: string;
        main: string;
        root: string;
        buildVersion: number;
    };
    /** @internal — test seam: parse the wrangler config and store it. Returns true on success. */
    _readConfigForTest(): boolean;
    /** @internal — test seam: invoke buildInnerEnv() without a probe-load pass. */
    _buildInnerEnvForTest(): Record<string, any>;
    /** @internal — test seam: install the VFS file-watch listener and the
     * mock-rebuild path (esbuild.build() is called, but the real
     * buildAndLoad() pipeline is bypassed in favour of just calling
     * esbuild). Used for hot-reload latency + nimbus-paths-not-watched
     * probes. Production calls start() which installs the watcher AND the
     * full rebuild pipeline. */
    _installWatchersForTest(): void;
}
//# sourceMappingURL=nimbus-wrangler.d.ts.map