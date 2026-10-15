/**
 * start-real-vite.ts — how the `vite` builtin boots a cirrus-real (real
 * `vite`) dev server (opt-in via NIMBUS_REAL_VITE=1 or `nimbusDevServer:
 * 'real'`). Booting is heavy: it pre-bundles the user's vite.config against
 * the VFS, allocates the facet payload, and launches the server as one of the
 * session's resident processes. A new incarnation of the session boots it
 * again by running the `vite` command again (dev-servers.ts).
 */
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { ProcessRestart } from '@nimbus-sh/core/runtime/process-table.js';
import { CirrusReal } from '../facets/cirrus-real.js';
export interface StartRealViteOptions {
    /** VFS root the dev server serves from. */
    root: string;
    /** Virtual routing port the facet is registered on. */
    port: number;
    /** Mount base baked into the facet's vite `base` config. */
    basePath: string;
    /** Directory the user's vite.config.{ts,js,mjs} is searched in (the shell
     *  cwd at start). */
    configDir: string;
    /**
     * The process-table cwd+argv the dev server's pid is given — what the app
     * verbs derive its identity from — and who it runs as: the wrapper pid's
     * own, or the command's line, under its credential (devServerSpawn).
     * `execId` is the exec id the pid carries.
     */
    identity: DevServerIdentity;
    /** Optional abort signal threaded into the heavy-alloc gate. */
    signal?: AbortSignal;
    /** Called with a human message if vite.config pre-bundling fails (so the
     *  `vite` builtin can surface it on stderr). */
    onConfigError?: (message: string) => void;
}
/** Who a dev server's pid is: the cwd+argv its identity derives from, its credential, its exec id when it has one, and the process it restarts when it is a restore's. */
export interface DevServerIdentity {
    cwd: string;
    argv: string[];
    cred: VfsCred;
    execId?: string;
    restartedFrom?: ProcessRestart;
}
export interface StartRealViteResult {
    cirrusReal: CirrusReal;
    /** The bundled vite.config source, or null when there was none / it failed. */
    userConfigBundle: string | null;
    /** The resolved vite.config path, or null. */
    cfgPath: string | null;
}
/**
 * Boot a cirrus-real dev server on `self` as a resident process serving its
 * port. One already running is ended first. `self` is the session host
 * (InitHost = any).
 */
export declare function startRealVite(self: any, opts: StartRealViteOptions): Promise<StartRealViteResult>;
//# sourceMappingURL=start-real-vite.d.ts.map