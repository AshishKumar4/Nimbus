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
 *       │ FacetManager.spawnWorker(main.js, {
 *       │   modules: {
 *       │     main.js                — the process's NimbusProcess (generated)
 *       │     vite.bundle.js         — 2.3 MB real Vite (pre-bundled)
 *       │     cirrus-fs.js           — our fs shim (src/real-vite-fs-shim.ts)
 *       │     cirrus-fs-promises.js  — ditto (fs/promises)
 *       │     cirrus-ws.js           — our ws-shim (src/real-vite-hmr.ts)
 *       │     cirrus-chokidar.js     — our chokidar shim (src/real-vite-hmr.ts)
 *       │     real-node-fs.js        — raw node:fs re-export
 *       │     synthetic.js           — seeds globalThis.__cirrusRealFs
 *       │                              with the VFS snapshot
 *       │     user-vite-config.js    — pre-bundled vite.config.ts
 *       │   },
 *       │   bindings: { CIRRUS_HMR },
 *       │ })
 *       ▼
 *    Resident process (a facet, its lifecycle the manager's)
 *       - imports synthetic.js (side-effect: populates globalThis.__cirrusRealFs)
 *       - imports vite.bundle.js (evaluates, sees the seeded fs Map)
 *       - startProcess: `createServer().listen()`
 *       - handleHttpRequest: httpServerHandler({port}) from cloudflare:node
 *       - runs a long-poll loop against env.CIRRUS_HMR.hmrNextEvent
 *         that delivers VFS change events to the chokidar shim + HMR
 *         client messages to the ws shim
 *
 * All traffic in / out:
 *    Browser ──/preview/* ──>  DO.fetch ──> handleHttpRequest (/port/N: through the port registry)
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
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { ProcessRestart } from '@nimbus-sh/core/runtime/process-table.js';
import type { CompositeVFS } from '@nimbus-sh/core/vfs/composite.js';
import type { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import type { FacetManager } from './manager.js';
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
    readonly port: number;
    private root;
    private basePath;
    private vfs;
    private namespace;
    private userConfigBundle;
    private extraSyntheticFiles;
    /** The dev server's process, once launched, and its route (FacetManager.spawnWorker's facet). */
    pid: number;
    private route;
    private running;
    private _startedAt;
    private _snapshotStats;
    /** HMR bridge — shared by WS upgrade handler + VFS event pump. */
    hmr: HmrBridge;
    /** Unsubscribe from vfs events when the process ends. */
    private _vfsUnsub;
    constructor(opts: {
        env: any;
        port: number;
        root: string;
        basePath: string;
        vfs: SqliteVFS;
        /** Who the server reads its project as: the credential of the process it runs under. */
        cred: VfsCred;
        /** The session's namespace, whose changes the facet's chokidar hears (CompositeVFS.watchChanges). */
        namespace: Pick<CompositeVFS, 'watchChanges'>;
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
    /**
     * Run Vite as one of the session's resident processes, under `identity`,
     * and resolve once it listens on `port`. Its process ends as any other
     * does (kill, a lost host, the session's teardown), and that end stops
     * this controller.
     */
    start(ctx: DurableObjectState, launcher: Pick<FacetManager, 'spawnWorker'>, processes: Pick<SessionProcessSupervisor, 'get' | 'subscribeTerminal'>, identity: {
        cwd: string;
        argv: string[];
        cred: VfsCred;
        execId?: string;
        restartedFrom?: ProcessRestart;
    }): Promise<void>;
    private stop;
    /**
     * Browser WS upgrade request arrived at /preview/__nimbus_hmr.
     * The DO has already accepted the server-side socket via
     * ctx.acceptWebSocket; we register it with the HmrBridge.
     */
    attachHmrClient(ws: WebSocket): string;
    detachHmrClient(id: string): void;
    deliverHmrClientMessage(id: string, msg: string): void;
    /**
     * A request through the session's preview door, `innerPath` the path after
     * its `/preview` prefix, straight to the process's route: the body passes
     * through untouched, as the port registry's relay does not.
     */
    handleRequest(request: Request, innerPath: string): Promise<Response>;
}
//# sourceMappingURL=cirrus-real.d.ts.map