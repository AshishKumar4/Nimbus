/**
 * long-running-handle.ts — generic adapter (primitive #3 + #4).
 *
 * Goal: any long-running thing in a Nimbus session that *behaves* like
 * an HTTP server should plug into the supervisor's port registry the
 * same way, so:
 *
 *   - `ps` shows it (via `processTable.spawn` + `setLongRunning`)
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
export function makeLongRunningPortStub(handler: LongRunningHttpHandler) {
  return {
    async handleHttpRequest(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const innerPath = (url.pathname || '/') + url.search;
      return handler.handleRequest(request, innerPath);
    },
  };
}

/**
 * Parse `--port N`, `--port=N`, `-p N`, `-p=N` from argv. Returns the
 * parsed integer, or null. Last-wins (so `--port 3000 --port 4000` →
 * 4000), matching POSIX convention.
 *
 * Out-of-range or non-numeric values are returned as null without
 * throwing — callers fall back to the next source (env, config, default).
 */
export function parsePortFromArgv(argv: string[]): number | null {
  let result: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let candidate: string | undefined;
    if (a === '--port' || a === '-p') {
      candidate = argv[i + 1];
      i++;
    } else if (a.startsWith('--port=')) {
      candidate = a.slice('--port='.length);
    } else if (a.startsWith('-p=')) {
      candidate = a.slice('-p='.length);
    }
    if (!candidate) continue;
    const n = parseInt(candidate, 10);
    if (Number.isFinite(n) && n > 0 && n < 65536) result = n;
  }
  return result;
}

/**
 * Resolve a final port to bind to, given the various sources in
 * priority order. Returns the first finite source.
 *
 *   1. argv flags (--port / -p)
 *   2. env.PORT (post-shell-expansion; Markflow's `${PORT:-3000}` → 3000)
 *   3. viteConfig.port (explicit `port: NNNN` in vite.config.ts)
 *   4. fallback (caller-provided default, e.g. 5173 for vite, 3000 for express)
 */
export function resolveLongRunningPort(opts: {
  argv?: string[];
  env?: Record<string, any> | undefined;
  configPort?: number | undefined;
  fallback: number;
}): number {
  const argvPort = opts.argv ? parsePortFromArgv(opts.argv) : null;
  if (argvPort) return argvPort;
  const envPortStr = opts.env?.PORT;
  if (envPortStr !== undefined && envPortStr !== null && envPortStr !== '') {
    const n = parseInt(String(envPortStr), 10);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  if (opts.configPort && opts.configPort > 0 && opts.configPort < 65536) {
    return opts.configPort;
  }
  return opts.fallback;
}

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
export function expandShellDefaults(
  token: string,
  env: Record<string, any> | undefined,
): string {
  if (!token || token.indexOf('${') < 0) return token;
  const lookup = (name: string): string | undefined => {
    const v = env?.[name];
    if (v === undefined || v === null || v === '') return undefined;
    return String(v);
  };
  // ${VAR:-default}, ${VAR}. One pass; default value is itself
  // recursively expanded once.
  return token.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name, def) => {
    const v = lookup(name);
    if (v !== undefined) return v;
    if (def === undefined) return '';
    // One recursion level so `${PORT:-${PORT_FALLBACK:-3000}}` works.
    if (def.indexOf('${') >= 0) return expandShellDefaults(def, env);
    return def;
  });
}

/**
 * Apply `expandShellDefaults` to every argv token. Used at the top of
 * a long-running handler before argv parsing so flag values are
 * fully resolved.
 */
export function expandArgvShellDefaults(
  argv: ReadonlyArray<string>,
  env: Record<string, any> | undefined,
): string[] {
  return argv.map((t) => expandShellDefaults(t, env));
}

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
export function pickDefaultPreviewPort(
  ports: ReadonlyArray<{ port: number; registeredAt: number }>,
): number | null {
  if (ports.length === 0) return null;
  // Stable order: oldest registration first. A session that legitimately
  // runs two servers (e.g. vite + express API) should put the FRONTEND
  // (registered first) on the default `/preview/` route; the API is
  // accessed via `/preview/?port=8000`.
  let oldest = ports[0];
  for (const p of ports) if (p.registeredAt < oldest.registeredAt) oldest = p;
  return oldest.port;
}
