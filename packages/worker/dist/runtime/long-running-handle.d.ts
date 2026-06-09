/**
 * long-running-handle.ts — generic adapter (primitive #3 + #4).
 *
 * Goal: any long-running thing in a Nimbus session that *behaves* like
 * an HTTP server should plug into the supervisor's port registry the
 * same way, so:
 *
 *   - `ps` shows it (via the process supervisor's long-running spawn)
 *   - `/preview/?port=N` routes to it
 *   - `/preview/` routes to the default-target one
 *   - `vite stop` / `kill <pid>` tears it down
 *
 * Today, two "long-running things" exist in-process:
 *
 *   1. ViteDevServer (the built-in Cirrus shim)
 *   2. CirrusReal (the experimental real-vite facet)
 *
 * Both already expose a `handleRequest(request, pathname)` method.
 * `PortRegistry` expects facets exposing `handleHttpRequest(request)`
 * (single-arg, full request, with the inner path baked into the URL).
 *
 * `makeLongRunningPortStub` adapts the (request, pathname) shape into
 * the (request) shape, by stripping a configurable `basePath` prefix
 * from `request.url.pathname` and forwarding the rest. It is the ONE
 * hook every future long-running thing will use; we do not write a new
 * adapter per framework.
 *
 * NOTE: this is a SUPERVISOR-LOCAL stub, NOT a `WorkerEntrypoint`
 * RPC stub. The port-registry handler at `routeRequest` happily
 * accepts any object exposing `handleHttpRequest`, including in-DO
 * wrappers. That is by design — a long-running facet is NOT required
 * to live in a separate isolate; the routing primitive is the same
 * either way.
 */
/**
 * The minimal shape any long-running HTTP-like thing in a Nimbus
 * session must expose to be registered as a port handler. The first
 * arg is the original Request (in case the handler wants headers /
 * body / method); the second is the inner path with any base-prefix
 * already stripped, plus the original querystring.
 */
export interface LongRunningHttpHandler {
    handleRequest(request: Request, innerPath: string): Promise<Response>;
}
/**
 * Build a port-registry-compatible stub that forwards into the given
 * handler.
 *
 * The supervisor calls `stub.handleHttpRequest(request)` with a request
 * whose URL pathname is the path relative to the port (`PortRegistry`
 * already strips the `/port/<n>` prefix). We pass that pathname to the
 * underlying handler unchanged.
 *
 * Concretely: `GET /port/3000/api/users?id=42`
 *   → port-registry rewrites url to `/api/users?id=42`
 *   → stub.handleHttpRequest(req)  // req.url has /api/users?id=42
 *   → handler.handleRequest(req, "/api/users?id=42")
 */
export declare function makeLongRunningPortStub(handler: LongRunningHttpHandler): {
    handleHttpRequest(request: Request): Promise<Response>;
};
/**
 * Parse `--port N`, `--port=N`, `-p N`, `-p=N` from argv. Returns the
 * parsed integer, or null. Last-wins (so `--port 3000 --port 4000` →
 * 4000), matching POSIX convention.
 *
 * Out-of-range or non-numeric values are returned as null without
 * throwing — callers fall back to the next source (env, config, default).
 */
export declare function parsePortFromArgv(argv: string[]): number | null;
/**
 * Resolve a final port to bind to, given the various sources in
 * priority order. Returns the first finite source.
 *
 *   1. argv flags (--port / -p)
 *   2. env.PORT (post-shell-expansion; Markflow's `${PORT:-3000}` → 3000)
 *   3. viteConfig.port (explicit `port: NNNN` in vite.config.ts)
 *   4. fallback (caller-provided default, e.g. 5173 for vite, 3000 for express)
 */
export declare function resolveLongRunningPort(opts: {
    argv?: string[];
    env?: Record<string, any> | undefined;
    configPort?: number | undefined;
    fallback: number;
}): number;
/**
 * Expand shell-style `${VAR}` and `${VAR:-default}` references in a
 * single argv token, against the supplied env map.
 *
 * Nimbus's shell does not expand parameter substitution, so a
 * package.json script line like
 *
 *     "dev": "vite --host 0.0.0.0 --port ${PORT:-3000}"
 *
 * arrives at the vite handler as the literal token `${PORT:-3000}`.
 * Without expansion, `--port ${PORT:-3000}` is parsed as a non-numeric
 * port and discarded. With expansion (against `env.PORT` falling back
 * to `3000`), the user gets the port they asked for.
 *
 * Supports the two forms commonly seen in `package.json` scripts:
 *
 *   - ${VAR}             → env[VAR] || ''
 *   - ${VAR:-default}    → env[VAR] || default
 *   - ${VAR:-other_var}  → recursive (one level), so the default may
 *                          itself reference an env var
 *
 * Does NOT support: command substitution, arithmetic substitution,
 * pattern operators (`${VAR##pat}` etc.), positional params, glob.
 * That is intentional — full shell semantics belong in the shell, not
 * the argv expander; this helper covers ~95% of dev-script usage.
 */
export declare function expandShellDefaults(token: string, env: Record<string, any> | undefined): string;
/**
 * Apply `expandShellDefaults` to every argv token. Used at the top of
 * a long-running handler before argv parsing so flag values are
 * fully resolved.
 */
export declare function expandArgvShellDefaults(argv: ReadonlyArray<string>, env: Record<string, any> | undefined): string[];
/**
 * Pick the default `/preview/` target when no `?port=N` is supplied
 * AND no in-process `viteDevServer` is currently running. The strategy
 * is "first PortRegistry entry, ordered by registration time" — so if
 * a session has only one long-running thing (Markflow's vite on :3000),
 * `/preview/` lands on it without the user supplying a port.
 *
 * Returns null if the registry is empty, in which case the caller
 * surfaces the existing "no dev server running" placeholder.
 */
export declare function pickDefaultPreviewPort(ports: ReadonlyArray<{
    port: number;
    registeredAt: number;
}>): number | null;
//# sourceMappingURL=long-running-handle.d.ts.map