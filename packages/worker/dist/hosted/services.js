import { staticStdinReader } from "@nimbus-sh/core/shell/stdin-adapter.js";
import { composeFacetManager } from "../facets/compose.js";
import { FacetProcessManager, textBytes } from "../facets/process.js";
import { ChildProcessSpawnPool } from "../loaders/child-process/spawn-pool.js";
import { CRED_KERNEL, CRED_SESSION_USER } from "@nimbus-sh/core/runtime/os-contracts.js";
import { SqliteFilesystemAuthority } from "@nimbus-sh/core/runtime/filesystem-authority.js";
import { EsbuildBundlePool } from "../facets/esbuild-bundle-pool.js";
import { EsbuildService } from "@nimbus-sh/core/runtime/esbuild-service.js";
import { CF_COMPAT_DATE } from "@nimbus-sh/core/constants.js";
import { notifyTerminalEvent } from "../runtime/process-logs-api.js";
// The supervisor terminates a facet's outbound sockets so inbound frames
// arrive as supervisor replies (VFS coherence witness 3).
import { WebSocketRelay } from "../session/ws-relay.js";
// ── Pure helpers extracted to ./nimbus-session-helpers.ts (S1) ────────
//
// renderNoDevServerHtml, BUNDLER_BIN_PREFIXES, NIMBUS_UNSUPPORTED_BINS,
// WRANGLER_IGNORED_FLAGS{,_WITH_VALUE}, WRANGLER_UNSUPPORTED_CONFIG_FIELDS,
// filterWranglerFlags, detectUnsupportedWranglerConfig, _CP_FACET_DIRECT,
// _CP_PURE_BUILTIN, _classifyCommand, detectBundlerBin, checkNodeModulesGuard
// all live in the helpers module now.
//
// They are imported here (so call sites in this file work unchanged) and
// re-exported (so external callers importing them from
// `./nimbus-session.js` keep working — back-compat).
//
// (esbuild wasm bytes are fetched from env.ASSETS by
//  src/esbuild-wasm-bytes.ts at pool-construction time; A'.5 dropped
//  the supervisor-resident cache + the SUPERVISOR.getEsbuildWasm RPC.)
// Helpers needed by this class file's own logic (not just re-export).
import { _classifyCommand } from "../session/helpers.js";
import { z } from "zod/v4";
const CpFacetDirectPayloadSchema = z.object({
    command: z.unknown().optional().transform((value) => value == null ? '' : String(value)),
    args: z.array(z.unknown()).optional().transform((value) => (value || []).map((item) => String(item))),
    env: z.record(z.string(), z.unknown()).optional().transform((value) => {
        const out = {};
        for (const [key, item] of Object.entries(value || {}))
            out[key] = String(item);
        return out;
    }),
    cwd: z.unknown().optional().transform((value) => value == null ? '/' : String(value)),
    stdin: z.unknown().optional().transform((value) => value == null ? '' : String(value)),
    processPid: z.number().int().positive(),
}).passthrough();
function normalizeCpCommandName(name) {
    const text = String(name || '').trim();
    if (!text.startsWith('/'))
        return text;
    const slash = text.lastIndexOf('/');
    const base = slash >= 0 ? text.slice(slash + 1) : text;
    const dir = text.slice(0, Math.max(0, text.length - base.length));
    if (dir === '/bin/' || dir === '/usr/bin/' || dir === '/usr/local/bin/') {
        return base;
    }
    return text;
}
export function ensureBundlePool(self, runtimeContext) {
    if (!self.bundlePool)
        self.bundlePool = new EsbuildBundlePool(runtimeContext.env, runtimeContext.ctx);
    return self.bundlePool;
}
export function ensureFacetManager(self, runtimeContext) {
    if (!self.facetManagerComposed) {
        // The manager is composed over the filesystem, so the filesystem comes
        // first. Cheap and idempotent; every caller already stood it up or is
        // about to.
        self.ensureSqliteFs();
        const filesystem = runtimeContext.filesystem();
        // The manager reaches the disk behind the authority (boot images, the
        // launch journal), so a host that credentials something other than this
        // session's SQLite filesystem cannot compose one.
        if (!(filesystem instanceof SqliteFilesystemAuthority)) {
            throw new Error('Nimbus: the facet manager needs the session SqliteFilesystemAuthority, not a foreign filesystem authority');
        }
        self.facetManagerComposed = composeFacetManager({
            ctx: runtimeContext.ctx,
            env: runtimeContext.env,
            processes: self.processes,
            portRegistry: self.portRegistry,
            vfs: filesystem.vfs,
            filesystem,
            ...(self.esbuildService ? { esbuild: self.esbuildService } : {}),
            hooks: {
                onExternalExit: (pid, code, reason) => self._reportExternalExit(pid, code, reason),
                requestLaunchTurn: (notBefore) => runtimeContext.requestLaunchTurn(notBefore),
                resolveWorkerLaunch: runtimeContext.resolveWorkerLaunch,
                notify: (line) => runtimeContext.notify(line),
                onSpawn: (pid, command, longRunning) => {
                    const attachedTty = self.processes.get(pid)?.attachedTty === true;
                    if (longRunning) {
                        try {
                            self.processes.openInput(pid);
                        }
                        catch { }
                        // The one arming site: the journal's re-drive path comes back
                        // through this same hook. See ensureResidentKeepalive.
                        runtimeContext.armResidentKeepalive?.();
                    }
                    // Only surface long-running / user-visible spawns to keep
                    // the terminal uncluttered. Short `node <file>` evals also
                    // get a line because users want the pid for `logs`/`kill`.
                    if (!self.terminal)
                        return;
                    const label = longRunning ? 'started (long-running)' : 'started';
                    self.terminal.write(`\x1b[2m[facet ${label}: pid=${pid} cmd="${command}"]\x1b[0m\r\n`);
                    // Structured event so the tabs UI can auto-open a log tab
                    // for long-running processes (vite, wrangler dev, etc.).
                    notifyTerminalEvent(self.terminal, {
                        type: 'spawn', pid, command, longRunning, attachedTty,
                    });
                },
            },
        });
    }
    const composed = self.facetManagerComposed;
    // W3.5 Fix B: share the session's lazy esbuildService with the
    // FacetManager so the bundle's ESM→CJS pre-pass doesn't pay
    // wasm-init twice. The session may construct it after the manager
    // exists, so the share is re-offered on every call; FacetManager
    // otherwise lazy-creates its own on first exec — same wasm bytes,
    // same ~10ms init cost, just paid once per surface.
    if (self.esbuildService) {
        composed.manager.setEsbuildService(self.esbuildService);
    }
    return composed;
}
export function _ensureWebSocketRelay(self, runtimeContext) {
    if (!self.webSocketRelay)
        self.webSocketRelay = new WebSocketRelay();
    return self.webSocketRelay;
}
export function _ensureFacetProcessManager(self, runtimeContext) {
    if (self.facetProcessManager)
        return self.facetProcessManager;
    self.ensureSqliteFs();
    self.ensureFacetManager();
    // FacetProcessManager is statically imported at top-of-file (W8).
    // No lazy-import: workerd doesn't ship CJS require, and the dynamic
    // import would be async — making _ensureFacetProcessManager async
    // would force every cp* RPC entry point to also be async on the
    // promise-resolution path, which is fine but uglier. Compile-time
    // tree-shaking handles unused-when-no-cp-RPC paths.
    // Adapter for FacetManagerLike — wraps the existing FacetManager.exec
    // with a streaming surface. Phase 1 simplification: facet-direct
    // commands are dispatched through the shell registry the same way
    // shell.execute does, but with the per-PID hooks routed.
    const facetMgrAdapter = {
        execStream: async (codeJson, opts, hooks) => {
            // codeJson is a payload from FacetProcessManager._dispatch facet-direct
            // path: {command, args, env, cwd, stdin}. We dispatch through the
            // existing shell registry by resolving the command and invoking
            // it with synthesized output streams that route to hooks.
            let payload;
            try {
                const parsed = CpFacetDirectPayloadSchema.safeParse(JSON.parse(codeJson));
                if (!parsed.success) {
                    hooks.onStderr(textBytes('child_process: facet dispatch requires a broker-assigned process pid\n'));
                    return 1;
                }
                payload = parsed.data;
            }
            catch {
                hooks.onStderr(textBytes('child_process: invalid facet dispatch payload\n'));
                return 1;
            }
            const registry = self._cpRegistry;
            if (!registry) {
                hooks.onStderr(textBytes('child_process: command registry unavailable\n'));
                return 127;
            }
            const commandName = normalizeCpCommandName(payload.command);
            const cmd = await registry.resolve(commandName);
            if (!cmd) {
                hooks.onStderr(textBytes(`${payload.command}: command not found\n`));
                return 127;
            }
            // Synthesize a CommandContext for the internal shell substrate.
            const stdoutStream = { write: (d) => hooks.onStdout(textBytes(String(d))) };
            const stderrStream = { write: (d) => hooks.onStderr(textBytes(String(d))) };
            const ac = new AbortController();
            const cred = self.processes.cred(payload.processPid);
            const ctx = {
                pid: payload.processPid,
                cred,
                args: payload.args || [],
                env: payload.env || {},
                cwd: payload.cwd || '/home/user',
                vfs: self.sqliteFs.as(cred),
                stdout: stdoutStream,
                stderr: stderrStream,
                signal: ac.signal,
                // For commands that need stdin we pass a tiny adapter.
                stdin: staticStdinReader(payload.stdin || ''),
                setUmask: (mask) => { self.processes.setUmask(payload.processPid, mask); },
                runAs: async (targetCred, argv) => {
                    if (argv.length === 0)
                        return 0;
                    const child = self.processes.spawn(argv.join(' '), argv, payload.cwd, { parentPid: payload.processPid, cred: targetCred });
                    let exitCode = 1;
                    try {
                        exitCode = await cmdRegistryAdapter.runPureBuiltin(child.pid, argv[0], argv.slice(1), payload.env, payload.cwd, payload.stdin, hooks);
                        return exitCode;
                    }
                    finally {
                        self.processes.exit(child.pid, exitCode);
                    }
                },
                __nimbusCaptureOutput: true,
            };
            try {
                const code = await cmd(ctx);
                return typeof code === 'number' ? code : 0;
            }
            catch (e) {
                hooks.onStderr(textBytes(`${payload.command}: ${e?.message || String(e)}\n`));
                return 1;
            }
        },
        abort: (facetName) => {
            // Best-effort: relay to ctx.facets.abort, mirroring FacetManager.kill.
            try {
                runtimeContext.ctx.facets?.abort?.(facetName, new Error('SIGKILL'));
            }
            catch { }
            return true;
        },
    };
    // Adapter for CommandRegistryLike. The shared shell registry is
    // attached to `this._cpRegistry` by the shell-init path (see
    // construction near line 2058 — registry passed as ctor arg there).
    const cmdRegistryAdapter = {
        // Consult the live shell registry FIRST so dynamically-registered
        // commands (registerUnixCommands / git / npm / wrangler etc.) are seen
        // even if they're not in the static _CP_PURE_BUILTIN allow-list. Falls
        // back to the static facet-direct table for known facet-only commands.
        // Returns null
        // (→ exit 127) for everything unknown.
        resolve: (name) => {
            const commandName = normalizeCpCommandName(name);
            const registry = self._cpRegistry;
            if (registry && typeof registry.has === 'function' && registry.has(commandName)) {
                // Registered — classify by name. Reuse the static table so
                // facet-direct commands (node/npm/git/...) keep their kind
                // even when they ALSO happen to be registry entries.
                return _classifyCommand(commandName) || { kind: 'pure-builtin' };
            }
            return _classifyCommand(commandName);
        },
        runPureBuiltin: async (pid, name, args, env, cwd, stdin, hooks) => {
            const registry = self._cpRegistry;
            if (!registry) {
                hooks.onStderr(textBytes('cp: registry unavailable\n'));
                return 127;
            }
            const commandName = normalizeCpCommandName(name);
            const cmd = await registry.resolve(commandName);
            if (!cmd) {
                hooks.onStderr(textBytes(`${name}: command not found\n`));
                return 127;
            }
            const cred = self.processes.cred(pid);
            const ac = new AbortController();
            const ctx = {
                pid,
                cred,
                args, env, cwd,
                vfs: self.sqliteFs.as(cred),
                stdout: { write: (d) => hooks.onStdout(textBytes(String(d))) },
                stderr: { write: (d) => hooks.onStderr(textBytes(String(d))) },
                signal: ac.signal,
                stdin: staticStdinReader(stdin),
                setUmask: (mask) => { self.processes.setUmask(pid, mask); },
                runAs: async (targetCred, argv) => {
                    if (argv.length === 0)
                        return 0;
                    const child = self.processes.spawn(argv.join(' '), argv, cwd, { parentPid: pid, cred: targetCred });
                    let exitCode = 1;
                    try {
                        exitCode = await cmdRegistryAdapter.runPureBuiltin(child.pid, argv[0], argv.slice(1), env, cwd, stdin, hooks);
                        return exitCode;
                    }
                    finally {
                        self.processes.exit(child.pid, exitCode);
                    }
                },
            };
            try {
                const code = await cmd(ctx);
                return typeof code === 'number' ? code : 0;
            }
            catch (e) {
                hooks.onStderr(textBytes(`${name}: ${e?.message || String(e)}\n`));
                return 1;
            }
        },
    };
    // Construct the child-process Loader pool when the binding is available.
    // Unit-test hosts without LOADER continue through direct dispatch.
    let spawnPool;
    try {
        const envAny = runtimeContext.env;
        if (envAny?.LOADER && typeof envAny.LOADER.get === 'function') {
            spawnPool = new ChildProcessSpawnPool(runtimeContext.env, runtimeContext.ctx);
        }
    }
    catch {
        spawnPool = undefined;
    }
    self.facetProcessManager = new FacetProcessManager({
        facetMgr: facetMgrAdapter,
        processes: self.processes,
        vfsForProcess: (pid) => self.sqliteFs.as(self.processes.cred(pid)),
        commandRegistry: cmdRegistryAdapter,
        shellExecutor: {
            execute: async (pid, commandLine, env, cwd, stdin, hooks) => {
                if (!self.shell) {
                    hooks.onStderr(textBytes('sh: shell unavailable\n'));
                    return 127;
                }
                const cred = self.processes.cred(pid);
                const setUmask = (mask) => { self.processes.setUmask(pid, mask); };
                const runAs = async (_parent, targetCred, argv) => {
                    if (argv.length === 0)
                        return 0;
                    const child = self.processes.spawn(argv.join(' '), argv, cwd, { parentPid: pid, cred: targetCred });
                    let exitCode = 1;
                    try {
                        exitCode = await cmdRegistryAdapter.runPureBuiltin(child.pid, argv[0], argv.slice(1), env, cwd, stdin, hooks);
                        return exitCode;
                    }
                    finally {
                        self.processes.exit(child.pid, exitCode);
                    }
                };
                const result = await self.shell.execute(String(commandLine), {
                    cwd: cwd || '/home/user',
                    env: { ...self.shell.env, ...(env || {}) },
                    onStdout: hooks.onStdout,
                    onStderr: hooks.onStderr,
                    stdin,
                    isolateShellState: true,
                    commandContext: { pid, cred, setUmask },
                    runAs,
                });
                return typeof result?.exitCode === 'number' ? result.exitCode : 0;
            },
        },
        ctx: runtimeContext.ctx,
        spawnPool,
    });
    return self.facetProcessManager;
}
export function ensureFetchProxy(self, runtimeContext, log) {
    if (self.fetchProxyEntrypoint)
        return self.fetchProxyEntrypoint;
    try {
        const env = runtimeContext.env;
        if (!env?.LOADER?.load) {
            log?.('LOADER.load not available — using global fetch');
            return null;
        }
        // Buffered proxy: reads the entire response body into an ArrayBuffer
        // and returns it in ONE message instead of forwarding a ReadableStream.
        // In workerd local dev, streaming responses across a service-binding
        // RPC fabric opens a separate loopback socket PER chunk (~16KB), which
        // exhausts ephemeral ports for larger installs (npm registry packuments
        // are 500KB-3MB, tarballs up to 5MB). Buffering to arrayBuffer means
        // 1 stub call = 1 loopback connection, not N connections.
        //
        // 32MB cap prevents a malformed giant response from OOMing the proxy
        // isolate. Packages with tarballs larger than 32MB will fail to install
        // cleanly (returned as 413 → caller treats as failed fetch).
        const proxyCode = [
            'const MAX_BYTES = 32 * 1024 * 1024;',
            'export default {',
            '  async fetch(request, workerEnv) {',
            '    try {',
            '      const body = await request.json();',
            '      const resp = await fetch(body.url, {',
            '        method: body.method || "GET",',
            '        headers: body.headers || {},',
            '      });',
            '      // Check advertised Content-Length before buffering',
            '      const clStr = resp.headers.get("content-length");',
            '      if (clStr) {',
            '        const cl = parseInt(clStr, 10);',
            '        if (cl > MAX_BYTES) {',
            '          return new Response(',
            '            JSON.stringify({ error: "response too large: " + cl + " bytes (cap " + MAX_BYTES + ")" }),',
            '            { status: 413, headers: { "Content-Type": "application/json" } }',
            '          );',
            '        }',
            '      }',
            '      // Buffer entire body — ONE message, not streamed chunks',
            '      const buf = await resp.arrayBuffer();',
            '      if (buf.byteLength > MAX_BYTES) {',
            '        return new Response(',
            '          JSON.stringify({ error: "response exceeded cap: " + buf.byteLength + " bytes" }),',
            '          { status: 413, headers: { "Content-Type": "application/json" } }',
            '        );',
            '      }',
            '      return new Response(buf, {',
            '        status: resp.status,',
            '        statusText: resp.statusText,',
            '        headers: Object.fromEntries(resp.headers.entries()),',
            '      });',
            '    } catch (e) {',
            '      return new Response(JSON.stringify({ error: e.message }), {',
            '        status: 502,',
            '        headers: { "Content-Type": "application/json" },',
            '      });',
            '    }',
            '  }',
            '};',
        ].join('\n');
        const worker = env.LOADER.load({
            compatibilityDate: CF_COMPAT_DATE,
            compatibilityFlags: ['nodejs_compat'],
            mainModule: 'fetch-proxy.js',
            modules: { 'fetch-proxy.js': proxyCode },
        });
        self.fetchProxyEntrypoint = worker.getEntrypoint();
        log?.('Fetch proxy worker created (singleton)');
        return self.fetchProxyEntrypoint;
    }
    catch (e) {
        log?.(`Fetch proxy creation failed: ${e?.message}`);
        return null;
    }
}
export function buildFetchFn(self, runtimeContext, log) {
    const entrypoint = self.ensureFetchProxy(log);
    if (!entrypoint)
        return undefined;
    return async (url, init) => {
        const headers = {};
        if (init?.headers) {
            if (init.headers instanceof Headers) {
                init.headers.forEach((v, k) => { headers[k] = v; });
            }
            else if (typeof init.headers === 'object') {
                Object.assign(headers, init.headers);
            }
        }
        return entrypoint.fetch(new Request('http://fetch-proxy/do-fetch', {
            method: 'POST',
            body: JSON.stringify({ url, method: init?.method || 'GET', headers }),
        }));
    };
}
export async function ensureNpmInstaller(self, runtimeContext, onProgress) {
    self.ensureSqliteFs();
    if (!self.esbuildService) {
        if (!self.sqliteFs)
            throw new Error('Session VFS is not initialized');
        self.esbuildService = new EsbuildService(self.sqliteFs.as(CRED_KERNEL));
    }
    // Lazy-load the installer (+ its ~216 KB resolver/facet/loader-pool
    // subgraph) on first npm use so it stays out of the cold script-eval
    // graph. The install command paths that call this are already async.
    const { NpmInstaller } = await import('../npm/installer.js');
    // ── Lazy fetch-proxy ────────────────────────────────────────────
    // The fetch-proxy is a singleton dynamic worker (LOADER.load) that
    // buffers registry responses to dodge wrangler-local-dev port
    // exhaustion. It is only needed for the in-supervisor npm paths.
    // When the resolver and install paths run in facets (default-on),
    // they use bare globalThis.fetch and need no proxy.
    //
    // workerd has a per-DO cap on concurrent dynamic workers (~5-6
    // empirically). A permanent live proxy worker eats one of those
    // slots for the entire DO lifetime, so the proxy is built only when
    // any facet path is disabled via its env flag.
    const useFacetResolver = self._envFlagDefaultOn('NIMBUS_FACET_RESOLVER');
    const useFacetInstall = self._envFlagDefaultOn('NIMBUS_FACET_NPM_INSTALL');
    const useBatchFacet = self._envFlagDefaultOn('NIMBUS_FACET_NPM_INSTALL_BATCH');
    const needProxy = !(useFacetResolver && useFacetInstall && useBatchFacet);
    const fetchFn = needProxy ? self.buildFetchFn(onProgress) : undefined;
    if (!needProxy) {
        onProgress?.(`[npm] Lazy fetch-proxy: skipped (all facet paths default-on)`);
    }
    self.npmInstaller = new NpmInstaller(self.sqliteFs, runtimeContext.ctx.storage.sql, {
        esbuild: self.esbuildService,
        bundlePool: self.ensureBundlePool(),
        ctx: runtimeContext.ctx,
        env: runtimeContext.env,
        onProgress,
        fetchFn,
    });
    return self.npmInstaller;
}
export function _envFlagDefaultOn(self, runtimeContext, name) {
    const raw = runtimeContext.env?.[name];
    if (raw === undefined || raw === null)
        return true;
    const s = String(raw).toLowerCase();
    if (s === '0' || s === '' || s === 'false' || s === 'off' || s === 'no')
        return false;
    return true;
}
export function ensureGlobalPrefixDirs(self, runtimeContext, prefix) {
    const fs = self.sqliteFs.as(CRED_SESSION_USER);
    const dirs = [
        prefix,
        `${prefix}/lib`,
        `${prefix}/lib/node_modules`,
        `${prefix}/bin`,
    ];
    for (const dir of dirs) {
        if (!fs.exists(dir))
            fs.mkdir(dir, { recursive: true });
    }
}
export function bindRuntimeServices(host, context) {
    return {
        ensureBundlePool: ensureBundlePool.bind(null, host, context),
        ensureFacetManager: ensureFacetManager.bind(null, host, context),
        _ensureWebSocketRelay: _ensureWebSocketRelay.bind(null, host, context),
        _ensureFacetProcessManager: _ensureFacetProcessManager.bind(null, host, context),
        ensureFetchProxy: ensureFetchProxy.bind(null, host, context),
        buildFetchFn: buildFetchFn.bind(null, host, context),
        ensureNpmInstaller: ensureNpmInstaller.bind(null, host, context),
        _envFlagDefaultOn: _envFlagDefaultOn.bind(null, host, context),
        ensureGlobalPrefixDirs: ensureGlobalPrefixDirs.bind(null, host, context),
    };
}
