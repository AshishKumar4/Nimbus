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
type ViteHost = any;
export declare function createViteCommand(self: ViteHost): (ctx: any) => Promise<number>;
export {};
//# sourceMappingURL=vite-command.d.ts.map