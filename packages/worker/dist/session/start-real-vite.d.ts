/**
 * start-real-vite.ts — the one place a cirrus-real (real `vite`) dev server is
 * booted.
 *
 * Two callers share it: the `vite` shell builtin (opt-in via NIMBUS_REAL_VITE=1
 * or `nimbusDevServer: 'real'`) and the hibernation-restore path in
 * session/routes.ts. Booting is heavy — it pre-bundles the user's vite.config
 * against the VFS, allocates the facet payload, and boots a dynamic-worker
 * facet — so it must not be duplicated: a woken session has to rebuild the
 * server exactly as the command did, or the two disagree on what real-vite
 * looks like.
 *
 * It also persists what restore needs into the SAME `vite-config` key the
 * Cirrus shim writes, tagged `devServer: 'real'` so restore rebuilds real-vite
 * rather than the shim. Before this, cirrus-real wrote nothing at all and every
 * such session was unrecoverable after eviction.
 */
import { CirrusReal } from '../facets/cirrus-real.js';
export interface StartRealViteOptions {
    /** VFS root the dev server serves from. */
    root: string;
    /** Virtual routing port the facet is registered on. */
    port: number;
    /** Mount base baked into the facet's vite `base` config. */
    basePath: string;
    /** Directory the user's vite.config.{ts,js,mjs} is searched in (the shell
     *  cwd at start). Persisted so restore can re-bundle it. */
    configDir: string;
    /**
     * The process-table cwd+argv the dev server's pid is given — what the app
     * verbs derive its identity from. The `vite` builtin passes the wrapper
     * pid's own (or the argv it was invoked with); restore passes what was
     * persisted, so the restored server is the same application. Absent for
     * configs written before identity was persisted: those keep the bare
     * `[]` at the root, the same across every restore.
     */
    identity?: {
        cwd: string;
        argv: string[];
    };
    /** Optional abort signal threaded into the heavy-alloc gate. */
    signal?: AbortSignal;
    /** Called with a human message if vite.config pre-bundling fails (so the
     *  `vite` builtin can surface it on stderr). Restore passes nothing. */
    onConfigError?: (message: string) => void;
}
export interface StartRealViteResult {
    cirrusReal: CirrusReal;
    /** The bundled vite.config source, or null when there was none / it failed. */
    userConfigBundle: string | null;
    /** The resolved vite.config path, or null. */
    cfgPath: string | null;
}
/**
 * Boot a cirrus-real dev server on `self`, register its port, and persist the
 * config restore needs. `self` is the session host (RoutesHost/InitHost = any).
 */
export declare function startRealVite(self: any, opts: StartRealViteOptions): Promise<StartRealViteResult>;
//# sourceMappingURL=start-real-vite.d.ts.map