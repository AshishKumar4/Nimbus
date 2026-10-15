/**
 * session/vite-command.ts — the `vite` builtin command.
 *
 * Extracted from init.ts so the handler can be driven through the
 * command registry in unit tests — the module's only session coupling
 * is `self`, the same InitHost view initSession passes to every other
 * registration.
 *
 * Subcommands: `vite` (dev server), `vite build`, `vite preview`,
 * `vite stop`. Build honours build.outDir with Vite parity: output
 * writes to the resolved path, only an outDir strictly inside the
 * project root is emptied first, and the bundle is validated before
 * old output is cleared.
 */
import { ViteDevServer } from '../facets/vite-dev-server.js';
type ViteHost = any;
/** An in-session Vite server and its process, once each is made. */
export interface ViteShim {
    server: ViteDevServer | null;
    pid: number | null;
}
/**
 * What ends `shim` when its process ends (bindDevServer): the server stops,
 * and its port and the session's hold on it go.
 */
export declare function viteShimTeardown(self: ViteHost, shim: ViteShim): () => void;
/**
 * End whichever Vite server runs now, in the session or real Vite, with its
 * process: `vite stop` ends real Vite as finished, a server that replaces it
 * terminates it. Its port is released, and its record with it.
 */
export declare function stopViteServers(self: ViteHost, { replacing }: {
    replacing: boolean;
}): boolean;
export declare function createViteCommand(self: ViteHost): (ctx: any) => Promise<number>;
export {};
//# sourceMappingURL=vite-command.d.ts.map