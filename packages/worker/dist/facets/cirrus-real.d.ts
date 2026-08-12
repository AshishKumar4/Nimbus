/**
 * cirrus-real.ts — Real Vite inside a Cloudflare DO facet.
 *
 * Ships alongside the in-process Cirrus shim (src/vite-dev-server.ts,
 * untouched). Users opt into real-vite mode via `NIMBUS_REAL_VITE=1`
 * or `nimbusDevServer: 'real'` in vite.config.ts.
 *
 * Phase status (PHASE2-REAL-VITE-PLAN.md):
 *   0 (import + createServer + listen)        — passing, shipped
 *   1 (VFS-backed fs shim)                    — implemented here
 *   2 (HMR over our /ws)                      — implemented here
 *   3 (real @vitejs/plugin-react)             — depends on plugin preload
 *   4 (opt-in polish + boot banner)           — implemented in nimbus-session
 *
 * Architecture:
 *
 *    NimbusSession (supervisor DO)
 *       │
 *       │ LOADER.load({
 *       │   modules: {
 *       │     main.js                — facet entrypoint (generated)
 *       │     vite.bundle.js         — 2.3 MB real Vite (pre-bundled)
 *       │     cirrus-fs.js           — our fs shim (src/real-vite-fs-shim.ts)
 *       │     cirrus-fs-promises.js  — ditto (fs/promises)
 *       │     cirrus-ws.js           — our ws-shim (src/real-vite-hmr.ts)
 *       │     cirrus-chokidar.js     — our chokidar shim (src/real-vite-hmr.ts)
 *       │     real-node-fs.js        — raw node:fs re-export
 *       │     synthetic.js           — seeds globalThis.__cirrusRealFs
 *       │                              with the VFS snapshot
 *       │     user-vite-config.js    — pre-bundled vite.config.ts
 *       │   }
 *       │ })
 *       ▼
 *    Dynamic Worker (facet)
 *       - imports synthetic.js (side-effect: populates globalThis.__cirrusRealFs)
 *       - imports vite.bundle.js (evaluates, sees the seeded fs Map)
 *       - starts Vite server via `createServer().listen()`
 *       - exposes fetch via httpServerHandler({port}) from cloudflare:node
 *       - runs a long-poll loop against env.SUPERVISOR.hmrNextEvent
 *         that delivers VFS change events to the chokidar shim + HMR
 *         client messages to the ws shim
 *
 * All traffic in / out:
 *    Browser ──/preview/* ──>  DO.fetch   ──>  facetStub.fetch
 *    Browser ──/preview/__nimbus_hmr──>  DO.fetch (WS upgrade)
 *                                  │
 *                                  ▼
 *                               HmrBridge (nimbus-session-side)
 *                                  │  long-poll
 *                                  ▼
 *                               facet loop  ──>  chokidar / ws shim
 */
import { HmrBridge } from './real-vite-hmr.js';
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { VfsEventEmitter } from '@nimbus-sh/core/vfs/events.js';
import type { ParsedViteConfig } from '@nimbus-sh/core/runtime/vite-config-parser.js';
/**
 * Resolve opt-in mode.
 *
 * Priority: env var > parsed vite.config.ts opt-in > default ('cirrus').
 */
export declare function shouldUseRealVite(opts: {
    env?: Record<string, string | undefined> | undefined;
    viteConfig?: Pick<ParsedViteConfig, 'devServer' | 'importsVitePlugin'> | undefined;
}): boolean;
export declare class CirrusReal {
    private env;
    private port;
    private root;
    private basePath;
    private vfs;
    private vfsEvents;
    private userConfigBundle;
    private extraSyntheticFiles;
    private facetStub;
    private pid;
    private bootError;
    private _startedAt;
    /** [D'.1] facet name used with ctx.facets.get/delete. Set in start(),
     *  cleared in stop(). */
    private _facetName;
    /** Dispatch shape:
     *  - 'do-facet' (post-D'.1, requires `$experimental` compat flag)
     *  - 'fetcher-fallback' (D'.1 graceful-degrade, when
     *    getDurableObjectClass is unavailable — the prod and the
     *    flag-stripped local dev case after the 2026-05-08
     *    deploy-flag-fix tightening) [d1-fix]
     *  - null (not started, or stop()'d)
     *  Surfaced via /api/_diag/cirrus.kind for the probe.
     */
    private _kind;
    /** [D'.1] timestamp when the facet stub was successfully obtained
     *  (after ctx.facets.get returned). Used to compute the supervisor-
     *  side bootMs that includes module compilation + facet binding,
     *  but NOT the in-facet vite.createServer.listen() (that's measured
     *  separately via getFacetMeta RPC). */
    private _bootCompletedAt;
    /** [D'.1] last fetch latency ms — surfaces on diag for warm-reuse
     *  perf assertions. */
    private _lastFetchMs;
    private _snapshotStats;
    /** HMR bridge — shared by WS upgrade handler + VFS event pump. */
    hmr: HmrBridge;
    /** Unsubscribe from vfs events on stop(). */
    private _vfsUnsub;
    constructor(opts: {
        env: any;
        port: number;
        root: string;
        basePath: string;
        vfs: SqliteVFS;
        vfsEvents?: VfsEventEmitter | null;
        userConfigBundle?: string | null;
        extraSyntheticFiles?: Record<string, string>;
    });
    get isRunning(): boolean;
    get stats(): Record<string, unknown>;
    /** Soft warning set during start() if the project looks too large
     *  for the facet's 128 MB isolate budget. Surfaces in `stats` so
     *  the banner printed by nimbus-session.ts can show it. Empty
     *  string when the project is in the known-good envelope. */
    private _sizeWarning;
    start(ctx: DurableObjectState, pid: number): Promise<void>;
    stop(ctx?: DurableObjectState): void;
    /**
     * Browser WS upgrade request arrived at /preview/__nimbus_hmr.
     * The DO has already accepted the server-side socket via
     * ctx.acceptWebSocket; we register it with the HmrBridge.
     */
    attachHmrClient(ws: WebSocket): string;
    detachHmrClient(id: string): void;
    deliverHmrClientMessage(id: string, msg: string): void;
    /**
     * Route a (non-WS) request into the facet. `pathname` is the path
     * after stripping the session's `/preview` prefix (e.g. `/`,
     * `/@vite/client`, `/src/main.tsx`).
     */
    handleRequest(request: Request, pathname: string): Promise<Response>;
    /**
     * [D'.1] Diag bundle for /api/_diag/cirrus. Includes the facet's
     * own-SQLite identity cookie (round-tripped via the facet's
     * getFacetMeta RPC), supervisor-side dispatch kind, supervisor-side
     * bootMs, and last-fetch latency. Returns null when cirrus-real
     * is not running.
     */
    getDiag(): Promise<Record<string, unknown> | null>;
}
//# sourceMappingURL=cirrus-real.d.ts.map