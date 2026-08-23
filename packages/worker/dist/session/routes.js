/**
 * session/routes.ts — HTTP/WS fetch routing for the supervisor DO.
 *
 * One handleRequest function for everything the DO speaks:
 *   /ws upgrade        → cold-init / warm-rejoin (B'.5) / 409
 *   /preview/*         → cirrus-real or vite-dev-server forward
 *   /port/:n/*         → user http-server proxy via port-registry
 *   /worker/*          → nimbus-wrangler dev forward
 *   /api/_diag/*       → forensic surfaces (memory, session, cirrus)
 *   /api/_test/*       → NIMBUS_DEBUG-gated probe endpoints
 *   /api/* (other)     → small JSON endpoints (write-file, mkdir, ...)
 *
 * The dispatcher is one big if/else by design — pattern-matching
 * URL paths cleanly is easier to read than a Map-based router for
 * this many one-off shapes, and grep-ability matters when debugging.
 *
 * Surfaces:
 *   - handleFetch(self, request) — top-level dispatcher; was _handleFetch.
 *
 * The class retains `fetch` (DO contract) + `_handleFetch` as delegators
 * per plan §IX.4 R1.
 *
 * Per DEFECT-D1: route handlers read self.ctx + self.env extensively
 * (~30 sites). RoutesHost = any pragmatic deviation, like InitHost in S6.
 */
import { handleReplicaPreflight as _w12HandleReplicaPreflight } from '../replica/routing.js';
import { replicasSuspended as _w12ReplicasSuspended } from '../replica/suspension.js';
import { sanitizeUntrustedRequest } from '@nimbus-sh/core/_shared/untrusted-request.js';
import { matchLogsPath, handleLogsWebSocketRequest, handleProcessesListRequest, } from '../runtime/process-logs-api.js';
import { readDiagCounters } from '@nimbus-sh/platform/diag-counters.js';
import { getFailures, getLastRpcFrame, getLastFacetId, getRecoveryEvents, recordRecoveryEvent, resetRecoveryEvents, } from '@nimbus-sh/platform/oom-discriminator.js';
import { DEFAULT_VITE_PORT, LRU_MAX_ENTRIES } from '@nimbus-sh/core/constants.js';
import { BASE_PATH_HEADER } from '../_shared/session-router.js';
import { VITE_CONFIG_KEY } from './keys.js';
import { estimateSupervisorHeap, WORKERD_EVICTION_LABELS } from '@nimbus-sh/platform/heap-estimate.js';
import { loadShellState, loadKernelMounts, getScrollbackStats, clearSessionState, appendScrollback, loadScrollback } from './state-store.js';
import { classifyWsUpgrade, joinExistingSession } from './init-phases.js';
import { closeStaleShellSockets, tagShellSocket } from './shell-socket.js';
import { EsbuildService } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { ViteDevServer } from '../facets/vite-dev-server.js';
import { notifyTerminalEvent, wireProcessLogSocketBroadcast } from '../runtime/process-logs-api.js';
import { makeLongRunningPortStub } from '@nimbus-sh/core/runtime/long-running-handle.js';
import { startRealVite } from './start-real-vite.js';
import { getLoadedCodesStats } from '@nimbus-sh/fabric/bindings.js';
import { generation } from '@nimbus-sh/fabric/generation.js';
import { facetIdBudget } from '@nimbus-sh/fabric/budgets.js';
import { loaderLedgerStats } from '@nimbus-sh/fabric/budgets.js';
import { HOSTED_WEBSOCKET_CAPABILITY_HEADER, HOSTED_WEBSOCKET_KEY_HEADER, } from '@nimbus-sh/fabric/process-host.js';
import { routeHostedWebSocket } from './rpc.js';
import { clearPortCapability, persistPortCapability, readPortCapability, restorePortCapability, } from './port-capability.js';
import { PREVIEW_CAPABILITY_HEADER } from '../_shared/session-router.js';
import { renderNoDevServerHtml } from './helpers.js';
import { handleAgentRequest } from './agent.js';
import { captureSessionAiCredential } from './ai.js';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
// The L2 key builders are imported rather than re-derived so the bench
// endpoints below can never drift from the key shape the cache actually
// uses (they did: the packument purge used a stale `/p/` segment).
import { R2CacheClient, packumentL2Url, tarballL2Url, parseTarballAddress } from '../npm/r2-cache.js';
import { fetchEsbuildWasmBytes, ESBUILD_WASM_L2_KEY } from '../runtime/esbuild-wasm-bytes.js';
import { Fanout, IN_DO_THRESHOLD, MAX_PEER_FANOUT } from '@nimbus-sh/fabric/fanout.js';
import { z } from 'zod/v4';
const TestSpawnEmitterBodySchema = z.object({
    lines: z.coerce.number().optional(),
    lineText: z.unknown().optional().transform((value) => value == null ? 'line' : String(value)),
}).passthrough();
const RecoverySessionStateSchema = z.enum([
    'cold',
    'hydrated',
    'active',
    'drained',
    'rehydrate',
    'build',
    'wire',
    'online',
]);
function normalizeForwardedHttpPath(path) {
    const text = path || '/';
    return '/' + text.replace(/^\/+/, '');
}
/**
 * Restore the dev server a previous isolate left behind.
 *
 * Hibernation takes the ViteDevServer and the whole port registry with it;
 * only the `vite-config` blob survives in DO storage. Restoring it is the
 * first thing every route that can reach that server does, so a woken session
 * serves on all of them rather than on whichever one happened to carry the
 * restore.
 *
 * `onlyPort` scopes the restore to a config that would listen there: a
 * request for a port nothing ever persisted stays an honest 502, and a port
 * something else already holds is left alone.
 *
 * Idempotent, and silent on failure — a session with no dev server to restore
 * is the normal case, not an error.
 */
async function restorePersistedDevServer(self, onlyPort) {
    if (self.cirrusReal?.isRunning || self.viteDevServer?.isRunning)
        return;
    if (onlyPort != null && self.portRegistry.has(onlyPort))
        return;
    try {
        const config = await self.ctx.storage.get(VITE_CONFIG_KEY);
        // A parallel request may have restored the server while this one waited
        // on storage — a woken page fetches several URLs at once. Everything
        // below runs without yielding UNTIL the first await, so re-check there.
        if (self.viteDevServer?.isRunning || self.cirrusReal?.isRunning)
            return;
        if (!config?.root)
            return;
        // The port the saved config listens on; configs written before ports
        // were recorded predate P5 and are vite's default.
        const port = (config.port && Number.isFinite(config.port)) ? config.port : DEFAULT_VITE_PORT;
        if (onlyPort != null && onlyPort !== port)
            return;
        // Read BEFORE the restore: bringing the server back re-registers the port,
        // and a fresh registration mints a capability nobody was ever handed.
        const persistedCapability = await readPortCapability(self, port);
        // A cirrus-real session rebuilds the real-vite facet, not the Cirrus shim —
        // same key, same starter the `vite` builtin uses, so a woken real-vite
        // session comes back as real-vite rather than degrading to the shim.
        if (config.devServer === 'real') {
            // Booting the facet yields (heavy-alloc gate, ASSETS fetch), so a woken
            // page's parallel requests could each start one. Coalesce onto a single
            // in-flight boot; the ViteDevServer path below needs no such guard
            // because it runs to completion without yielding.
            if (self._realViteRestore) {
                await self._realViteRestore;
                return;
            }
            self.ensureSqliteFs();
            self._realViteRestore = startRealVite(self, {
                root: config.root,
                port,
                basePath: config.basePath || self.viteBasePath,
                configDir: config.configDir || config.root,
            }).finally(() => { self._realViteRestore = null; });
            await self._realViteRestore;
            await readoptCapability(self, port, persistedCapability);
            return;
        }
        self.ensureSqliteFs();
        if (!self.esbuildService)
            self.esbuildService = new EsbuildService(self.sqliteFs);
        // Prefer the current request's basePath (just captured from the
        // X-Nimbus-Base header) over the stored one — the latter is only
        // a fallback for cold rehydrates that precede any header hit.
        const basePath = self.viteBasePath || config.basePath;
        // process diagnostics support: re-allocate a PID so log streaming has
        // somewhere to land. Without this, the restored server would be silent.
        const entry = self.processes.spawn('vite (rehydrated, ' + config.root + ')', [], config.root, { longRunning: true });
        self.viteDevServer = new ViteDevServer({
            vfs: self.sqliteFs, esbuild: self.esbuildService, root: config.root,
            aliases: config.aliases, define: config.define,
            onHmrMessage: () => { },
            sql: self.ctx.storage.sql,
            injectBasename: config.injectBasename,
            basePath,
            env: self.env,
            ctx: self.ctx,
            port,
            pid: entry.pid,
            processes: self.processes,
        });
        self.viteDevServer.start();
        // Re-register the port so every port-addressed route reaches the
        // restored server across hibernation cycles.
        try {
            self.portRegistry.bindFacetStub(entry.pid, makeLongRunningPortStub(self.viteDevServer));
            await clearPortCapability(self, port);
            self.portRegistry.register(port, entry.pid);
            await readoptCapability(self, port, persistedCapability);
            self._viteShimPid = entry.pid;
            self._viteShimPort = port;
        }
        catch { /* registry full / unavailable — the server still serves /preview/ */ }
    }
    catch { /* nothing to restore — callers fall through to their own empty-state response */ }
}
/**
 * Route a request to whatever is listening on a session port.
 *
 * The one implementation behind every port-addressed surface: `/port/<n>/`,
 * `/preview/?port=N`, and the `<port>--<sid>` preview hostname, which the
 * router forwards as `/port/<n>/`. They differ only in how the port and the
 * inner path are spelled, so they must not differ in what answers.
 *
 * `mountBase` is the public URL prefix the served app is mounted at for THIS
 * request — '' for a root-mounted `<port>--<sid>` host, '/s/<sid>/preview' for
 * the preview path. The in-process Cirrus dev server rewrites base-relative
 * URLs (module URLs, <base href>, BASE_URL, router basename), so it is handed
 * the base directly: the generic port proxy strips the Nimbus base header at
 * the untrusted-code boundary and cannot carry it, and a plain user server on
 * any other port is mounted at root and needs no rewriting.
 */
async function routeToSessionPort(self, port, request, innerPath, mountBase, capability) {
    await restorePersistedDevServer(self, port);
    if (capability !== undefined) {
        // A rebuilt supervisor holds a capability nobody was handed; the durable
        // one is the value in circulation, so it wins before the check.
        await restorePortCapability(self, port);
        if (!self.portRegistry.hasCapability(port, capability)) {
            // 404, not 403: a wrong capability must not confirm that the port is
            // listening at all.
            return new Response('Not found', { status: 404 });
        }
    }
    if (port === self._viteShimPort) {
        // The preview HMR WebSocket can't cross the port-registry RPC, so it is
        // accepted in-DO for both dev servers — the same handling `/preview/` uses.
        if (self.cirrusReal?.isRunning && isCirrusHmrPath(innerPath)) {
            return acceptCirrusHmrWs(self, request);
        }
        // The Cirrus dev server rewrites base-relative URLs per request and the
        // generic proxy strips the base header, so hand it the request directly.
        if (self.viteDevServer?.isRunning) {
            return self.viteDevServer.handleRequest(request, innerPath, mountBase);
        }
    }
    const proxied = capability === undefined
        ? await self.portRegistry.routeRequest(port, request, innerPath)
        : await self.portRegistry.routeCapabilityRequest(port, capability, request, innerPath);
    if (proxied)
        return proxied;
    return new Response(`No process listening on port ${port}`, { status: 502 });
}
/**
 * Re-adopt a preview capability the embedder already holds, after a restore
 * re-registered the port under a freshly minted one.
 */
async function readoptCapability(self, port, capability) {
    if (!capability)
        return;
    if (self.portRegistry.restoreCapability(port, capability)) {
        await persistPortCapability(self, port, capability);
    }
}
/** Route a capability-authenticated embedder request to a guest HTTP server. */
export function routeCapabilityPort(self, port, capability, request, innerPath) {
    return routeToSessionPort(self, port, request, normalizeForwardedHttpPath(innerPath), '', capability);
}
/**
 * The public URL prefix a port-routed request is mounted at. `<port>--<sid>`
 * hosts arrive with an empty base header (mounted at the origin root); the
 * path form `/s/<sid>/port/<n>/` arrives with `/s/<sid>` and mounts under
 * `/s/<sid>/port/<n>`. Either way the base is a property of the door, read
 * from the header the router set — never the sticky sessionBasePath, which a
 * concurrent path request could have left pointing elsewhere.
 */
function portRouteMountBase(request, port) {
    const header = request.headers.get(BASE_PATH_HEADER);
    return header ? `${header}/port/${port}` : '';
}
/** True if `innerPath` targets the cirrus-real HMR socket, under any mount
 *  base — the client opens `<base>/__nimbus_hmr`, and on a `<port>--<sid>` host
 *  the router forwards the whole path, base and all, under `/port/N`. */
function isCirrusHmrPath(innerPath) {
    const p = innerPath.split('?')[0];
    return p === '/__nimbus_hmr' || p.endsWith('/__nimbus_hmr');
}
/**
 * Accept a Vite HMR WebSocket for the running cirrus-real facet and wire it
 * into the facet's HMR bridge.
 *
 * Handled in the DO, never through the port-registry proxy: that proxy moves a
 * Request/Response over RPC and drops the `webSocket` handshake, so a HMR
 * upgrade routed through it hangs. This is the ONE place a preview HMR socket
 * is accepted — shared by the `/preview/` path and the `<port>--<sid>` host's
 * `/port/N` route, so HMR works the same on both.
 *
 * ctx.acceptWebSocket (hibernatable) is required because HMR messages arrive
 * from a DIFFERENT request context (the facet's long-poll RPC), and workerd
 * forbids cross-request I/O on a `server.accept()`'d socket.
 */
function acceptCirrusHmrWs(self, request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    self.ctx.acceptWebSocket(server, ['cirrus-hmr']);
    const clientId = self.cirrusReal.attachHmrClient(server);
    server.serializeAttachment?.({ kind: 'cirrus-hmr', clientId });
    const hmrClients = (self._cirrusHmrWsClients ||= new Map());
    hmrClients.set(server, clientId);
    // Echo the vite-hmr subprotocol.
    const wantedProto = request.headers.get('Sec-WebSocket-Protocol') || '';
    const useProto = wantedProto.split(',').map((s) => s.trim()).find((p) => p === 'vite-hmr' || p === 'vite-ping');
    const respHeaders = {};
    if (useProto)
        respHeaders['Sec-WebSocket-Protocol'] = useProto;
    return new Response(null, { status: 101, webSocket: client, headers: respHeaders });
}
const RecoveryEventRecordBodySchema = z.object({
    at: z.coerce.number().optional(),
    fromState: RecoverySessionStateSchema.default('cold'),
    toState: RecoverySessionStateSchema.default('hydrated'),
    trigger: z.unknown().optional().transform((value) => value == null ? 'manual-test' : String(value)),
    isolateGen: z.coerce.number().optional(),
    dataLoss: z.boolean().optional(),
    snapshotKeysRehydrated: z.coerce.number().optional(),
    notes: z.unknown().optional().transform((value) => value == null || value === '' ? undefined : String(value)),
}).passthrough();
const WriteFileBodySchema = z.object({
    path: z.string().min(1),
    content: z.unknown().transform((value) => value == null ? '' : String(value)),
}).passthrough();
const MkdirBodySchema = z.object({
    path: z.string().min(1),
}).passthrough();
const StartViteBodySchema = z.object({
    root: z.string().optional(),
    port: z.number().optional(),
    aliases: z.record(z.string(), z.string()).optional(),
    define: z.record(z.string(), z.string()).optional(),
    injectBasename: z.boolean().optional(),
}).passthrough();
const CachePackumentSeedBodySchema = z.object({
    name: z.unknown().optional().transform((value) => value == null ? '' : String(value)),
    payload: z.unknown().optional(),
}).passthrough();
const CacheTarballSeedBodySchema = z.object({
    sizeKb: z.coerce.number().optional(),
}).passthrough();
const FanoutBenchBodySchema = z.object({
    n: z.coerce.number().optional(),
    sleepMs: z.coerce.number().optional(),
}).passthrough();
async function parseJsonBody(request, schema) {
    const value = await request.json();
    const parsed = schema.safeParse(value);
    if (!parsed.success)
        throw new Error('invalid request body');
    return parsed.data;
}
export async function handleFetch(self, request) {
    const url = new URL(request.url);
    // The peer end of the fetch-semantic WebSocket hop, before anything else:
    // this request is a sibling coordinator's, not a browser's, and it names
    // the hosted process rather than a route on this session. Both headers are
    // stripped so the process never sees the transport that carried it.
    const hostedWebSocket = request.headers.get(HOSTED_WEBSOCKET_KEY_HEADER);
    if (hostedWebSocket) {
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
            return new Response('Expected WebSocket', { status: 426 });
        }
        const capability = request.headers.get(HOSTED_WEBSOCKET_CAPABILITY_HEADER);
        if (!capability)
            return new Response('Not found', { status: 404 });
        const headers = new Headers(request.headers);
        headers.delete(HOSTED_WEBSOCKET_KEY_HEADER);
        headers.delete(HOSTED_WEBSOCKET_CAPABILITY_HEADER);
        return routeHostedWebSocket(self, hostedWebSocket, capability, new Request(request.url, { method: request.method, headers }));
    }
    // Capture session basePath from the routing header (if forwarded by the
    // Worker's session-router). Threaded through to ViteDevServer so the
    // served app's module URLs, HMR paths, <base href>, and router basename
    // all resolve under `/s/<id>/preview/...`.
    await self.hydrateSessionBasePath(request);
    // Adopt the Cloudflare credential the browser is carrying, before any
    // route can return. The nimbus_agent_oauth cookie is scoped to /s/<sid>,
    // so the session's first page load hands it over and in-session inference
    // works from then on — no need to open the agent panel first. Costs a
    // header read when there is nothing new to adopt. See session/ai.ts.
    await captureSessionAiCredential(self, request);
    // ── W12 — DO read replica preflight ─────────────────────────────────
    //
    // If THIS isolate is a replica AND the route policy says delegate, we
    // forward the Request to the primary via `ctx.storage.primary.fetch()`
    // and return the primary's Response. Single intra-region RPC hop:
    // the replica was placed near the primary, so this is fast; the user
    // experiences edge-RTT-to-replica + RPC + primary-handle, which is
    // strictly less than user-RTT-to-far-region for cross-region tenants.
    //
    // On the primary OR for replica-eligible routes (with cold/warm
    // distinction handled), `delegated === false` and we fall through to
    // the existing route handlers unchanged.
    //
    // Graceful-degrade: if `inspectReplicaState` reports isReplica but the
    // primary stub is unusable, `handleReplicaPreflight` returns
    // `delegated: false` and we handle locally — correctness > latency.
    //
    // Performance note: the preflight is <1ms (pure pathname classification
    // + a `typeof` check on `ctx.storage.primary`). Hot path.
    try {
        const w12Pre = await _w12HandleReplicaPreflight(self.ctx, request, {
            isWarm: !!(self.viteDevServer?.isRunning || self.cirrusReal?.isRunning),
            suspended: _w12ReplicasSuspended(),
        });
        if (w12Pre.delegated && w12Pre.response) {
            return w12Pre.response;
        }
    }
    catch (e) {
        // Preflight should never throw, but never let a routing helper kill
        // request handling. Log + continue with local handling.
        console.warn('[nimbus/W12] preflight threw:', e?.message);
    }
    if (url.pathname === '/ws') {
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('Expected WebSocket', { status: 426 });
        }
        const wsKind = url.searchParams.get('kind') || url.searchParams.get('mode');
        if (wsKind === 'fs-watch') {
            self.ensureSqliteFs();
            const pair = new WebSocketPair();
            const [client, server] = Object.values(pair);
            self.ctx.acceptWebSocket(server);
            try {
                server.serializeAttachment?.({ kind: 'fs-watch' });
            }
            catch { }
            return new Response(null, { status: 101, webSocket: client });
        }
        // [B'.5] Three-way decision on a /ws upgrade — see
        // classifyWsUpgrade. Decide before accepting/tagging the incoming
        // server socket so it cannot be mistaken for the incumbent.
        const priorSockets = self.ctx.getWebSockets();
        const wsUpgrade = classifyWsUpgrade(self, priorSockets);
        if (wsUpgrade === 'conflict') {
            return new Response(JSON.stringify({
                error: 'session already has active terminal',
                hint: 'open a new /new session',
            }), {
                status: 409,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        // This upgrade is taking the terminal, so no shell socket in
        // `priorSockets` still has a peer. Close them: a socket whose tab
        // is gone, or one a failed upgrade accepted and never handed to a
        // client, otherwise stays accepted for the life of the object and
        // refuses every later reconnect.
        closeStaleShellSockets(self.ctx, priorSockets);
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        self.ctx.acceptWebSocket(server);
        tagShellSocket(server);
        if (wsUpgrade === 'warm-join') {
            // Warm rejoin path. The existing Shell is alive; we just
            // swap the WebSocketTerminal's ws ref + replay scrollback.
            try {
                joinExistingSession(self, server, appendScrollback, loadScrollback);
            }
            catch (err) {
                console.error('warm-rejoin error:', err?.message, err?.stack);
                try {
                    server.close(1011, 'rejoin failed');
                }
                catch { /* already closing */ }
                return new Response('Rejoin failed: ' + err?.message, { status: 500 });
            }
            return new Response(null, { status: 101, webSocket: client });
        }
        // Cold init path — first ever /ws (or post-DO-eviction).
        try {
            await self.initSession(server);
        }
        catch (err) {
            console.error('initSession error:', err?.message, err?.stack);
            try {
                server.close(1011, 'init failed');
            }
            catch { /* already closing */ }
            return new Response('Init failed: ' + err?.message, { status: 500 });
        }
        return new Response(null, { status: 101, webSocket: client });
    }
    // ── Process log streaming / listing — see src/process-logs-api.ts ──
    const logsPid = matchLogsPath(url.pathname);
    if (logsPid !== null) {
        return handleLogsWebSocketRequest(request, logsPid, {
            processes: self.processes,
            // W9: pass ctx so the upgrade uses ctx.acceptWebSocket (hibernatable).
            ctx: self.ctx,
        });
    }
    if (url.pathname === '/api/processes') {
        return handleProcessesListRequest(self.processes);
    }
    if (url.pathname.startsWith('/api/agent/')) {
        return handleAgentRequest(self, request, url);
    }
    // runtime primitive support (P11) — kill / restart by PID for the Process tab UI.
    //
    // Both endpoints accept POST only. The body is empty; the PID is in the
    // URL. Same authorization model as the rest of /api/* (session-scoped
    // via the /s/<id>/ prefix).
    //
    // Behaviour:
    //   POST /api/kill/<pid>     — equivalent to typing `kill <pid>` in
    //                              the shell. Tears down a vite-shim PID
    //                              cleanly (stops viteDevServer, deletes
    //                              vite-config) OR delegates to
    //                              facetManager.kill for real facets.
    //   POST /api/restart/<pid>  — kill + (if it was the vite shim)
    //                              re-run `vite` with the same argv to
    //                              boot a fresh server. For real facets,
    //                              currently only kills (caller must
    //                              re-issue spawn). Same response shape.
    //
    // Response: 200 {ok, pid, action} on success; 404 {error, pid} when
    // PID isn't tracked; 502 on internal failure.
    {
        const killMatch = url.pathname.match(/^\/api\/(kill|restart)\/(\d+)$/);
        if (killMatch && request.method === 'POST') {
            const action = killMatch[1];
            const pid = parseInt(killMatch[2], 10);
            const json = (status, body) => new Response(JSON.stringify(body), {
                status, headers: { 'Content-Type': 'application/json' },
            });
            if (!Number.isFinite(pid) || pid <= 0) {
                return json(400, { error: 'invalid pid', pid });
            }
            const entry = self.processes.get(pid);
            if (!entry) {
                return json(404, { error: 'no such process', pid });
            }
            const isViteShim = self._viteShimPid === pid;
            try {
                if (isViteShim) {
                    // Same teardown the `kill` shell handler does. Centralised
                    // here so the UI doesn't need to reimplement it.
                    try {
                        if (self.cirrusReal?.isRunning) {
                            self.cirrusReal.stop(self.ctx);
                            self.cirrusReal = null;
                        }
                        if (self.viteDevServer?.isRunning) {
                            self.viteDevServer.stop();
                            self.viteDevServer = null;
                            try {
                                await self.ctx.storage.delete(VITE_CONFIG_KEY);
                            }
                            catch { }
                        }
                    }
                    catch { /* keep going to teardown process + port state */ }
                    try {
                        self.portRegistry.unregisterByPid(pid);
                    }
                    catch { }
                    try {
                        self.processes.kill(pid);
                    }
                    catch { }
                    self._viteShimPid = null;
                    self._viteShimPort = null;
                }
                else if (self.facetManager) {
                    const ok = self.facetManager.kill(pid);
                    if (!ok)
                        return json(404, { error: 'facetManager.kill returned false', pid });
                }
                else {
                    // No facetManager and not a vite shim — best-effort
                    // process-table tombstone so the UI can re-render the badge.
                    try {
                        self.portRegistry.unregisterByPid(pid);
                    }
                    catch { }
                    try {
                        self.processes.kill(pid);
                    }
                    catch { }
                }
            }
            catch (e) {
                return json(502, { error: String(e?.message || e), pid });
            }
            // For 'restart', re-issue the equivalent of `vite` in the shell
            // when the killed PID was the vite shim. We do NOT generically
            // restart arbitrary processes — the supervisor doesn't keep
            // enough argv/env state to do that safely for real facets.
            if (action === 'restart' && isViteShim) {
                // Send a synthetic 'vite' command line to the terminal so the
                // existing registry handler runs. This is the simplest way to
                // re-trigger the SAME code path the user originally invoked,
                // without duplicating its 100-line setup here.
                if (self.terminal?.ws) {
                    try {
                        self.terminal.ws.send(JSON.stringify({ type: 'output', data: '\r\n' }));
                    }
                    catch { }
                }
                // Drop a marker so a future probe can assert on the action.
                notifyTerminalEvent(self.terminal, {
                    type: 'restart-requested', pid, command: entry.command || 'vite',
                });
            }
            return json(200, { ok: true, pid, action });
        }
    }
    if (url.pathname === '/api/memory') {
        // Minimal memory probe for stability investigations (WORKERD-CRASH
        // hypotheses). Reports whatever we can measure inside workerd:
        //   - vfs.{totalFiles, totalBytes} from the SQLite VFS
        //   - process.memoryUsage() if nodejs_compat exposes it (else zeros)
        //   - performance.memory when present (Chromium-style heap info)
        self.ensureSqliteFs();
        let nodeMem = null;
        try {
            const g = globalThis;
            if (g.process && typeof g.process.memoryUsage === 'function') {
                const mu = g.process.memoryUsage();
                nodeMem = {
                    rss: mu.rss | 0,
                    heapTotal: mu.heapTotal | 0,
                    heapUsed: mu.heapUsed | 0,
                    external: mu.external | 0,
                    arrayBuffers: mu.arrayBuffers | 0,
                };
            }
        }
        catch { /* ignore */ }
        let perfMem = null;
        try {
            const g = globalThis;
            if (g.performance && g.performance.memory) {
                perfMem = {
                    jsHeapSizeLimit: g.performance.memory.jsHeapSizeLimit | 0,
                    totalJSHeapSize: g.performance.memory.totalJSHeapSize | 0,
                    usedJSHeapSize: g.performance.memory.usedJSHeapSize | 0,
                };
            }
        }
        catch { /* ignore */ }
        const vfs = self.sqliteFs.getStats();
        return Response.json({
            vfs: { files: vfs.files, usedBytes: vfs.usedBytes },
            nodeMem,
            perfMem,
            ts: Date.now(),
        });
    }
    // ── Diagnostic memory probe ──────────────────────────────────────────
    // /api/_diag/memory — supervisor heap estimate, eviction taxonomy,
    // and recovery-event ring.
    //
    // Why this endpoint exists
    // ────────────────────────
    // workerd's process.memoryUsage() returns zero for every field inside
    // R1.md §R1.4). The previous endpoint reported nodeMem/perfMem from
    // process.memoryUsage() and they were always zero — useless.
    //
    // C'.1 replaces the zero-everywhere readout with a deterministic
    // estimator (src/@nimbus-sh/platform/heap-estimate.js) that sums known
    // supervisor allocations from runtime counters. Every byte has a
    // named contributor.
    //
    // C'.2 adds a recovery_event ring (src/oom-discriminator.ts) so
    // probes can assert that lifecycle transitions preserve session
    // state without data loss.
    //
    // Schema (v3, additive over v2):
    //   - heap: deterministic estimate + per-source breakdown + ceiling.
    //   - evictionLabels: workerd taxonomy (5 reasons).
    //   - recoveryEvents: ring of session lifecycle transitions.
    //   - All v1/v2 fields preserved for back-compat with existing tools.
    if (url.pathname === '/api/_diag/memory') {
        self.ensureSqliteFs();
        self._diagSampleMemory();
        const nodeMem = self._diagReadNodeMem();
        const perfMem = self._diagReadPerfMem();
        const vfs = self.sqliteFs.getStats();
        const DO_HEAP_LIMIT_BYTES = 128 * 1024 * 1024;
        const heapUsed = nodeMem?.heapUsed ?? 0;
        const counters = readDiagCounters();
        const cacheStats = vfs.cache;
        const lastFailures = getFailures();
        // ── C'.1 deterministic heap estimate ─────────────────────────────
        // Sources every contributing byte from a runtime counter — never
        // calls process.memoryUsage(). Ceiling is the architectural soft
        // budget (SUPERVISOR_HEAP_CEILING_BYTES = 64 MiB), half the
        // workerd hard cap of 128 MiB.
        // Stage 3 retains logical write bytes only for incomplete writeStream
        // files. SQL binding copies and object overhead are deliberately not
        // presented as measured heap.
        const sqlStats = vfs.sql;
        const inFlightWriteBytes = sqlStats.retainedWriteBytes.current;
        const heap = estimateSupervisorHeap(counters, {
            cacheHotBytes: cacheStats.hotBytes ?? 0,
            inFlightWriteBytes,
        });
        return Response.json({
            // ── v1 fields (preserved) ─────────────────────────────────
            vfs: { files: vfs.files, usedBytes: vfs.usedBytes },
            nodeMem,
            perfMem,
            peak: {
                rssBytes: self._diagPeakRss,
                heapUsedBytes: self._diagPeakHeapUsed,
                atMs: self._diagPeakAt,
                samples: self._diagSampleCount,
            },
            counters,
            limitBytes: DO_HEAP_LIMIT_BYTES,
            usagePctOfLimit: heapUsed > 0
                ? Math.round((heapUsed / DO_HEAP_LIMIT_BYTES) * 1000) / 10
                : 0,
            ts: Date.now(),
            // ── v2 / W5 additions (preserved) ─────────────────────────
            lastFailures,
            vfsDetail: {
                lruBytes: cacheStats.hotBytes ?? 0,
                lruMaxEntries: cacheStats.maxEntries ?? LRU_MAX_ENTRIES,
                lruMaxBytes: cacheStats.maxBytes ?? (LRU_MAX_ENTRIES * 65536),
                lruShrunk: cacheStats.lruShrunk ?? false,
                evictions: cacheStats.evictions ?? 0,
                hitRate: cacheStats.hitRate ?? 0,
                // N2: live bytes retained for incomplete writeStream() files.
                // Visible during a real npm install; ~0 at rest.
                writeStreamSpoolBytes: sqlStats.writeStreamSpoolBytes ?? 0,
                retainedWriteBytes: sqlStats.retainedWriteBytes,
                decoderRetainedBytes: sqlStats.decoderRetainedBytes,
                creditRetainedBytes: sqlStats.creditRetainedBytes,
                stagedBytes: sqlStats.stagedBytes,
                gcBytes: sqlStats.gcBytes,
                phases: sqlStats.phases,
                transactions: sqlStats.transactions,
            },
            // H7 (memory accounting cleanup): _NIMBUS_LOADED_CODES Map state.
            // Pre-fix this Map grew unbounded — wrangler dev's rebuild
            // loop accumulated one entry per save until the supervisor
            // hit the workerd 128 MiB hard cap. Post-fix: hard-cap LRU
            // (32 entries) with FIFO eviction. The counters here let
            // ops dashboards visualise the bound + the eviction rate.
            loadedCodes: getLoadedCodesStats(),
            // Per-DO Worker Loader accounting: distinct loader ids ever gotten
            // (each permanently holds one of the ~5-6 dynamic-worker slots) and
            // live/peak concurrent Loader fetches.
            loader: loaderLedgerStats(self.ctx),
            rpc: {
                lastFrame: getLastRpcFrame(),
            },
            facet: {
                lastDispatch: getLastFacetId(),
                // Facet IDs consumed over this DO's LIFETIME against the 65,536 the
                // platform will ever grant it. Append-only and never reclaimed;
                // crossing the wall is unrecoverable for the object.
                idBudget: await facetIdBudget(self.ctx),
            },
            // ── v3 / C' observability foundation ──────────────────────
            heap,
            evictionLabels: WORKERD_EVICTION_LABELS,
            recoveryEvents: getRecoveryEvents(),
            // ── W9: hibernation observability ───────────────────────────
            // `hib.isolateGen` increments per fresh isolate (cold start or
            // post-hibernation wake). Two probe calls a minute apart with
            // different gens means a hibernation/wake cycle ran in between.
            // `rehydrated*` counters are >0 only on the first hydrate after
            // a wake. `flushed*` counters track the alarm-driven SQL writes.
            // `autoResponseConfigured` reports the runtime's actual
            // capability (older workerd builds report false).
            hib: {
                isolateGen: generation(self.ctx),
                autoResponseConfigured: self._w9WsConfig?.autoResponseConfigured ?? false,
                autoResponseError: self._w9WsConfig?.autoResponseError ?? null,
                hibernationEventTimeoutMs: self._w9WsConfig?.timeoutSetMs ?? null,
                timeoutError: self._w9WsConfig?.timeoutError ?? null,
                ...self.processes.logHibStats(),
            },
            // ── W12: replica observability ──────────────────────────────
            // `replica.state` is one of 'enabled' / 'enabled-via-configure' /
            // 'unsupported' / 'error' / 'unknown' (per tryEnableReplicas
            // result; pre-GA runtimes get 'unsupported' graceful-degrade).
            // `isReplica` is true when this isolate is a regional read
            // replica (its `ctx.storage.primary` is an RpcStub). `bookmark`
            // reflects ctx.storage.getCurrentBookmark() if the API surfaces
            // it — used by future read-your-writes wait-for-bookmark wiring.
            // `suspended` reflects the global write-burst guard (npm install
            // / git clone in flight) per CF research §G.4 + ~lambros feedback.
            replica: self.getReplicaState(),
        });
    }
    // ── /api/_diag/session — Track B' state-store debug surface [B'.1] ──
    //
    // Exposes the persisted shell state so the probe at
    // shape directly. Read-only; no side effects. Always returns
    // 200 even when no row exists (the snapshot just shows
    // hasPersistedState=false).
    if (url.pathname === '/api/_diag/session') {
        const snap = loadShellState(self.ctx);
        const mounts = loadKernelMounts(self.ctx);
        const sbStats = getScrollbackStats(self.ctx);
        return Response.json({
            cwd: snap.cwd,
            env: snap.env,
            hydratedAt: snap.hydratedAt,
            hasPersistedState: snap.hasPersistedState,
            // [B'.2] persisted kernel mount list — empty before first
            // initSession, populated after.
            mounts,
            // [B'.3] scrollback stats — rows, total bytes, byte cap.
            scrollbackRows: sbStats.rows,
            scrollbackBytes: sbStats.bytes,
            scrollbackMaxBytes: sbStats.maxBytes,
            // [B'.4] live initSession phase. null pre-first-init;
            // 'rehydrate'/'build'/'wire'/'online' during init progress;
            // 'hydrated' after init completes; 'drained' after wsClose.
            phase: self._b4Phase ?? null,
            // [B'.5] count of /ws upgrades that took the warm-rejoin
            // path (Phase B skipped). Probes assert ≥1 after a forced
            // close + reconnect on the same isolate.
            warmJoinCount: self._b4WarmJoinCount ?? 0,
            // Live shell state — useful for confirming the in-memory
            // shell agrees with SQL. Null when no shell is currently
            // attached (between wsClose and next /ws upgrade).
            liveCwd: (() => { try {
                return self.shell?.getCwd() ?? null;
            }
            catch {
                return null;
            } })(),
            liveEnvKeys: (() => {
                try {
                    const e = self.shell?.getEnv();
                    return e ? Object.keys(e).sort() : null;
                }
                catch {
                    return null;
                }
            })(),
            ts: Date.now(),
        });
    }
    // ── [D'.1] /api/_diag/cirrus — cirrus-real DO Facet diagnostics ─────
    //
    // Returns null when cirrus-real is not running (no NIMBUS_REAL_VITE
    // session yet). When running, returns the supervisor-side dispatch
    // shape (kind = 'do-facet') + the in-facet identity cookie (proves
    // own-SQLite is working and survives ctx.facets warm reuse).
    //
    // and cookie persistence across forced supervisor reconnect.
    if (url.pathname === '/api/_diag/cirrus') {
        if (!self.cirrusReal) {
            return Response.json({ running: false, kind: null });
        }
        try {
            const diag = await self.cirrusReal.getDiag();
            return Response.json({ running: true, ...diag });
        }
        catch (e) {
            return Response.json({ running: true, error: e?.message || String(e) }, { status: 500 });
        }
    }
    // ── W9: hibernation simulation + diagnostic spawn (NIMBUS_DEBUG=1) ──
    //
    // These endpoints exist to let local probes exercise the cross-
    // hibernation code path. Real DO hibernation only happens in prod;
    // wrangler dev keeps state across requests. So we simulate the
    // "fresh isolate per dispatch" rule by clearing the in-memory
    // log store — the next read MUST hydrate from SQL.
    //
    // 404 when NIMBUS_DEBUG isn't set, so prod isn't a free vector.
    if (url.pathname.startsWith('/api/_test/')) {
        if (!self.nimbusDebug) {
            return new Response('not found', { status: 404 });
        }
        if (url.pathname === '/api/_test/hib/simulate' && request.method === 'POST') {
            // Drain any pending writes first so SQL is the source of truth,
            // then nuke the in-memory ring. The next read on any pid will
            // re-hydrate via the adapter.
            try {
                self.processes.flushLogs();
            }
            catch { }
            self.processes.resetLogStore();
            // Re-wire persist + WS broadcast on the new store (mirrors the
            // constructor path).
            self._w9PersistWired = false;
            self._w9WireProcessLogPersist();
            wireProcessLogSocketBroadcast(self.processes, self.ctx);
            return Response.json({ cleared: true, ts: Date.now() });
        }
        if (url.pathname === '/api/_test/spawn-emitter' && request.method === 'POST') {
            // Spawns a synthetic emitter directly into the process
            // supervisor without going through FacetManager. Lets the e2e
            // probe drive the W9 code path without a real long-running
            // facet (which the test environment may not support).
            try {
                const body = await parseJsonBody(request, TestSpawnEmitterBodySchema);
                const lines = Math.max(1, Math.min(1000, body.lines || 50));
                const text = body.lineText;
                const entry = self.processes.spawn(`_test:${text}`, ['_test'], '/');
                const pid = entry.pid;
                for (let i = 0; i < lines; i++) {
                    self.processes.appendOutput(pid, 'stdout', `${text} ${i}\n`);
                }
                // Force-flush so SQL reflects state before the next request.
                try {
                    self.processes.flushLogs();
                }
                catch { }
                return Response.json({ pid, lines });
            }
            catch (e) {
                return Response.json({ error: e?.message }, { status: 400 });
            }
        }
        if (url.pathname === '/api/_test/log-tail' && request.method === 'GET') {
            const pid = parseInt(url.searchParams.get('pid') || '', 10);
            const linesQ = parseInt(url.searchParams.get('lines') || '0', 10) || undefined;
            if (!Number.isFinite(pid) || pid <= 0) {
                return Response.json({ error: 'bad pid' }, { status: 400 });
            }
            const chunks = self.processes.tailLogs(pid, linesQ ? { lines: linesQ } : {});
            const allText = chunks.map((c) => c.data).join('');
            const lines = allText.split('\n').filter((l) => l !== '');
            return Response.json({ pid, lines, chunkCount: chunks.length });
        }
        // ── C'.2 recovery-event test endpoints ────────────────────────────
        // schema works pre-Track-B'. Once Track B' transitions land, real
        // events flow through the ring naturally — these endpoints stay
        // error-recovery/).
        if (url.pathname === '/api/_test/recovery-event/record' && request.method === 'POST') {
            const body = await parseJsonBody(request, RecoveryEventRecordBodySchema);
            recordRecoveryEvent({
                at: body.at || Date.now(),
                fromState: body.fromState,
                toState: body.toState,
                trigger: body.trigger,
                isolateGen: body.isolateGen || generation(self.ctx),
                dataLoss: body.dataLoss === true,
                snapshotKeysRehydrated: body.snapshotKeysRehydrated || 0,
                notes: body.notes,
            });
            return Response.json({ recorded: true, ringSize: getRecoveryEvents().length });
        }
        if (url.pathname === '/api/_test/recovery-event/reset' && request.method === 'POST') {
            resetRecoveryEvents();
            return Response.json({ reset: true });
        }
        // ── B'.1 session-state reset ─────────────────────────────────────
        // Drops every nimbus_session_kv / nimbus_kernel_mounts /
        // nimbus_terminal_scrollback row so the next /ws upgrade
        // takes the cold-start path (Phase O fires; banner reprints).
        // Used by probes to start each scenario from a known-empty state.
        if (url.pathname === '/api/_test/session/reset' && request.method === 'POST') {
            clearSessionState(self.ctx);
            return Response.json({ reset: true });
        }
        // ── cache-and-scrub L2 cache benchmark ───────────────────────────
        // contrast between a cold L3-only path and a warm L2-served
        // path. The probe asserts the warm path is ≥5× faster than the
        // cold path (the wave's hard ship-gate).
        //
        // Pattern (per cache-layer probe):
        //   1. POST /api/_test/cache/<layer>/reset    — purge L2 entry
        //   2. POST /api/_test/cache/<layer>/seed     — write L3 entry
        //   3. GET  /api/_test/cache/<layer>/bench?n=N — N timed reads
        //
        // The bench endpoint returns latencies[] in ms (high-res via
        // `performance.now()`) so the probe can compute median, ratios,
        // hit-flag from response headers, etc.
        if (url.pathname.startsWith('/api/_test/cache/')) {
            return await handleCacheTestEndpoint(self, url, request);
        }
        // ── two-tier-fanout primitive probe ──────────────────────────────
        // in-DO fanout in-DO and peer-DO fanout peer-DO speedups via the
        // Fanout primitive. Independent of any specific
        // production site (install-batch, pre-bundle, etc.) so the
        // primitive's behavior can be measured cleanly without
        // confounders.
        if (url.pathname.startsWith('/api/_test/fanout/')) {
            return await handleFanoutTestEndpoint(self, url, request);
        }
        return new Response('unknown _test endpoint', { status: 404 });
    }
    if (url.pathname === '/api/stats') {
        self.ensureSqliteFs();
        const vfsStats = self.sqliteFs.getStats();
        const processStats = self.processes.stats;
        const logStoreStats = self.processes.logStats;
        // Preview UI polls vite.running to decide between /preview/ and
        // the "no dev server" placeholder. We report running:true if
        // EITHER the Cirrus in-process ViteDevServer OR the opt-in
        // real-vite facet (cirrusReal) is live. Without this merge, a
        // session on NIMBUS_REAL_VITE=1 saw vite.running=false even
        // while real-vite was happily serving on /preview/.
        const legacyViteStats = self.viteDevServer?.stats || null;
        const cirrusRealRunning = !!self.cirrusReal?.isRunning;
        const cirrusRealStats = cirrusRealRunning ? self.cirrusReal?.stats : null;
        const viteStats = cirrusRealRunning
            ? {
                ...(cirrusRealStats || {}),
                running: true,
                root: legacyViteStats?.root ?? cirrusRealStats?.root ?? 'home/user/app',
                backend: 'real',
            }
            : legacyViteStats;
        const wranglerStats = self.nimbusWrangler?.stats || null;
        const portStats = self.portRegistry.stats;
        // Audit C3: same-origin only. The UI shell at /s/<id>/ polls this
        // from its own origin; no cross-origin reader is intended. If
        // future embeds need cross-origin reads, add an explicit origin
        // allowlist — not a wildcard.
        return Response.json({
            ...vfsStats,
            processes: processStats,
            logStore: logStoreStats,
            ports: portStats,
            vite: viteStats,
            wrangler: wranglerStats,
        });
    }
    // ── File write API: bypasses shell for fast bulk seeding ──
    // Audit C3: mutation endpoints do NOT advertise any CORS policy.
    // A cross-origin page that learns a session ID would otherwise be
    // able to write arbitrary files through the user's logged-in tab.
    // Same-origin POSTs from the session shell still work — SOP (not
    // CORS) governs them, so no preflight is emitted; cross-origin
    // requests are rejected by the browser before reaching the Worker.
    if (url.pathname === '/api/write-file' && request.method === 'POST') {
        self.ensureSqliteFs();
        try {
            const vfs = self.sqliteFs.as(CRED_KERNEL);
            const body = await parseJsonBody(request, WriteFileBodySchema);
            const path = body.path.replace(/^\/+/, '');
            // Ensure parent dirs
            const parts = path.split('/');
            for (let i = 1; i < parts.length; i++) {
                const dir = parts.slice(0, i).join('/');
                if (dir && !vfs.exists(dir))
                    vfs.mkdir(dir, { recursive: true });
            }
            vfs.writeFile(path, body.content);
            return Response.json({ ok: true, path });
        }
        catch (e) {
            return Response.json({ error: e?.message }, { status: 400 });
        }
    }
    if (url.pathname === '/api/mkdir' && request.method === 'POST') {
        self.ensureSqliteFs();
        try {
            const body = await parseJsonBody(request, MkdirBodySchema);
            const path = body.path.replace(/^\/+/, '');
            self.sqliteFs.as(CRED_KERNEL).mkdir(path, { recursive: true });
            return Response.json({ ok: true, path });
        }
        catch (e) {
            return Response.json({ error: e?.message }, { status: 400 });
        }
    }
    // ── Start vite via HTTP API (survives WS disconnects) ──
    if (url.pathname === '/api/start-vite' && request.method === 'POST') {
        self.ensureSqliteFs();
        try {
            const body = await parseJsonBody(request, StartViteBodySchema);
            const root = (body.root || 'home/user').replace(/^\/+/, '');
            // Stop existing server
            if (self.viteDevServer?.isRunning)
                self.viteDevServer.stop();
            // Start in-process ViteDevServer
            if (!self.esbuildService)
                self.esbuildService = new EsbuildService(self.sqliteFs);
            const basePath = self.viteBasePath;
            // process metadata support: allocate a PID + port even on the
            // /api/start-vite path so probes that drive vite via the test
            // surface still see a real process in `ps` and stream
            // diagnostics into the Process tab.
            const apiVitePort = (typeof body.port === 'number' && body.port > 0) ? body.port : 5173;
            const apiViteEntry = self.processes.spawn('vite (api/start-vite, ' + root + ')', [], root, { longRunning: true });
            self.viteDevServer = new ViteDevServer({
                vfs: self.sqliteFs, esbuild: self.esbuildService, root,
                aliases: body.aliases, define: body.define,
                onHmrMessage: () => { },
                sql: self.ctx.storage.sql,
                injectBasename: body.injectBasename,
                basePath,
                // env+ctx enable the on-demand facet bundle path. Without
                // these, ViteDevServer falls back to in-supervisor esbuild
                // for /preview/@modules/<spec> cold-path bundles — which OOMs
                // on large packages (lucide-react). See vite-dev-server.ts:
                // ensureOnDemandPool / serveModule.
                env: self.env,
                ctx: self.ctx,
                port: apiVitePort,
                pid: apiViteEntry.pid,
                processes: self.processes,
            });
            self.viteDevServer.start();
            try {
                const apiViteStub = makeLongRunningPortStub(self.viteDevServer);
                self.portRegistry.bindFacetStub(apiViteEntry.pid, apiViteStub);
                await clearPortCapability(self, apiVitePort);
                self.portRegistry.register(apiVitePort, apiViteEntry.pid);
                self._viteShimPid = apiViteEntry.pid;
                self._viteShimPort = apiVitePort;
            }
            catch { }
            // Persist so vite survives DO hibernation. basePath included so the
            // rehydrated server after DO sleep emits URLs under the same prefix
            // even before the next forwarded request updates sessionBasePath;
            // port so a server started here on a non-default port comes back on
            // the port it was actually listening on rather than vite's default.
            await self.ctx.storage.put(VITE_CONFIG_KEY, {
                root, aliases: body.aliases, define: body.define,
                injectBasename: body.injectBasename, basePath, port: apiVitePort,
            });
            return Response.json({ ok: true, root, running: true });
        }
        catch (e) {
            return Response.json({ error: e?.message }, { status: 400 });
        }
    }
    // [cleanup] /api/supervisor-rpc removed. The fetch-based fallback
    // pre-dated the ctx.exports-driven SupervisorRPC class; once D'.1
    // landed (cirrus-real on DO Facet) every facet ↔ supervisor RPC
    // flows through service bindings. The HTTP fallback was quarantined
    // under ARC-A-P3 with on-entry warnings; no caller ever hit it
    // post-rebuild. Removed in this cleanup along with the
    // handleSupervisorRpc body in src/session/supervisor-rpc.ts.
    // CORS preflight for API endpoints (audit C3).
    // Respond 204 with NO Access-Control-Allow-Origin. The browser
    // treats a missing ACAO as "cross-origin denied," which is what
    // we want for every endpoint in this DO: same-origin requests
    // from the session shell skip preflight entirely (SOP governs
    // them, not CORS); cross-origin callers are rejected.
    //
    // This handler matches only /api/* — the /preview, /worker, and
    // /port proxies retain their own header handling (some of those
    // still set wildcard ACAO in sibling modules like vite-dev-server
    // and nimbus-wrangler; tightening those is tracked as follow-up
    // since they serve user-controlled content and require separate
    // review of each consumer).
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
        return new Response(null, { status: 204 });
    }
    // ── Preview route: serves the Vite dev server output ──
    // Uses in-process ViteDevServer (synchronous VFS access + esbuild transforms).
    // This is reliable and avoids facet lifecycle issues.
    if (url.pathname.startsWith('/preview/') || url.pathname === '/preview') {
        // Ensure the starter project exists even if the user hits /preview/
        // before opening a terminal session. Idempotent — no-op if already seeded.
        try {
            self.ensureSqliteFs();
            self.seedFilesystem();
        }
        catch { /* non-fatal */ }
        // Primitive #3 multi-target routing — `/preview/?port=N` lets a
        // session with multiple long-running things (vite + Express, two
        // vites on different ports, …) reach each one without changing
        // the user-facing URL shape.
        //
        // `/preview/?port=N` routes to an explicitly registered process;
        // bare `/preview/` continues through the Vite/Cirrus paths below.
        const queryPort = (() => {
            const raw = url.searchParams.get('port');
            if (!raw)
                return null;
            const n = parseInt(raw, 10);
            return Number.isFinite(n) && n > 0 && n < 65536 ? n : null;
        })();
        if (queryPort != null) {
            const previewInner = normalizeForwardedHttpPath(url.pathname.replace(/^\/preview/, '') || '/') + (() => {
                // Strip our `?port=N` so the inner handler doesn't re-see it.
                const sp = new URLSearchParams(url.search);
                sp.delete('port');
                const q = sp.toString();
                return q ? '?' + q : '';
            })();
            // `/preview/?port=N` is the session preview path: assets it serves
            // are fetched relative to `/s/<sid>/preview/`, so that is the mount.
            return routeToSessionPort(self, queryPort, request, previewInner, self.viteBasePath);
        }
        // Rebuild whatever dev server a previous isolate left behind BEFORE the
        // serving checks below — a woken real-vite session must be restored (and
        // then served) through the cirrus-real branch, and a woken Cirrus-shim
        // session through the branch after it. Restoring only before the shim
        // check (as it once was) left a rehydrated real-vite server unserved.
        await restorePersistedDevServer(self);
        // ── Real-vite takes precedence if running ───────────────────────
        // Cirrus shim and real-vite are mutually exclusive per session.
        // cirrusReal is checked first since users explicitly opted in via
        // NIMBUS_REAL_VITE=1 or `nimbusDevServer: 'real'`.
        if (self.cirrusReal?.isRunning) {
            const previewPath = (url.pathname.replace(/^\/preview/, '') || '/') + url.search;
            // HMR WebSocket upgrade. Vite's @vite/client opens a WS against
            // `<base>/__nimbus_hmr` (our custom HMR path); accept it in-DO and
            // plug it into cirrusReal.hmr so the facet's ws-shim sees a
            // 'connection' event on its next long-poll.
            if (isCirrusHmrPath(previewPath)) {
                return acceptCirrusHmrWs(self, request);
            }
            return self.cirrusReal.handleRequest(sanitizeUntrustedRequest(request), previewPath);
        }
        if (self.viteDevServer?.isRunning) {
            const previewPath = (url.pathname.replace(/^\/preview/, '') || '/') + url.search;
            // Bare `/preview/` is the session preview path — mounted at
            // `/s/<sid>/preview`.
            return self.viteDevServer.handleRequest(request, previewPath, self.viteBasePath);
        }
        // Polished placeholder — auto-reloads when vite starts.
        // Checks the VFS for the starter app so we can offer a context-aware hint.
        const hasSeed = (() => {
            try {
                const vfs = self.sqliteFs.as(CRED_KERNEL);
                return vfs.exists('home/user/app') &&
                    vfs.exists('home/user/app/package.json');
            }
            catch {
                return false;
            }
        })();
        const hint = hasSeed
            ? 'cd app &amp;&amp; npm install &amp;&amp; npm run dev'
            : 'vite';
        // The placeholder JS polls the session's /api/stats. If this DO was
        // reached directly (no session prefix), fall back to a relative path.
        const statsUrl = (self.sessionBasePath || '') + '/api/stats';
        return new Response(renderNoDevServerHtml({ hint, polled: statsUrl, liveKey: 'vite' }), 
        // Audit C3: HTML served same-origin to the session shell.
        // No wildcard ACAO — the page's own fetch to /api/stats is
        // same-origin and needs no CORS header.
        { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    // ── Worker route: serves the nimbus-wrangler dev worker output ──
    //
    // runtime primitive support (P5): the canonical path is `/__nimbus/worker/*`
    // so projects with their own `worker/` directory at root (Markflow,
    // CF Pages projects, …) can serve it via `/preview/worker/*` without
    // collision. The bare `/worker/*` path remains accepted for
    // back-compat — same handler — but the response carries a
    // `Deprecation` and `Sunset` header so callers can migrate. New
    // sessions are encouraged to use the namespaced form.
    const workerPathMatch = url.pathname.startsWith('/__nimbus/worker/') || url.pathname === '/__nimbus/worker' ||
        url.pathname.startsWith('/worker/') || url.pathname === '/worker';
    const isLegacyWorkerPath = url.pathname.startsWith('/worker/') || url.pathname === '/worker';
    if (workerPathMatch) {
        if (!self.nimbusWrangler?.isRunning) {
            // Mirror the polished /preview/ placeholder — auto-reloads when
            // nimbus-wrangler starts. The placeholder references BOTH command
            // names so users coming from either `wrangler dev` or
            // `nimbus-wrangler dev` see a familiar hint.
            const hasWranglerConfig = (() => {
                try {
                    self.ensureSqliteFs();
                    const vfs = self.sqliteFs.as(CRED_KERNEL);
                    return vfs.exists('home/user/wrangler.jsonc') ||
                        vfs.exists('home/user/wrangler.json') ||
                        vfs.exists('home/user/wrangler.toml');
                }
                catch {
                    return false;
                }
            })();
            const hint = hasWranglerConfig
                ? 'npm run dev'
                : 'wrangler dev';
            return new Response(renderNoDevServerHtml({ hint, polled: (self.sessionBasePath || '') + '/api/stats', liveKey: 'wrangler' }), 
            // Audit C3: same-origin HTML, no ACAO needed (see /preview/).
            { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
        }
        // Strip the matched prefix to compute the inner worker path.
        // `/__nimbus/worker/*` and `/worker/*` collapse to the same
        // inner path so the dispatcher logic doesn't need to branch.
        const innerPrefix = isLegacyWorkerPath ? '/worker' : '/__nimbus/worker';
        const workerPath = url.pathname.replace(new RegExp('^' + innerPrefix), '') || '/';
        // Full outer-facing prefix for the proxy (e.g.
        // "/s/nimble-otter-4271/__nimbus/worker"). Used to rewrite
        // Location headers emitted by the inner Worker so cross-redirects
        // (POST /new → /s/<inner>/) land back on the correctly-prefixed
        // outer URL rather than a bare /s/<inner>/ path that would spawn
        // a different outer session.
        const outerWorkerBase = (self.sessionBasePath || '') + innerPrefix;
        const resp = await self.nimbusWrangler.handleRequest(sanitizeUntrustedRequest(request), workerPath, outerWorkerBase);
        if (isLegacyWorkerPath) {
            // Surface the deprecation in headers without rewriting body —
            // unobtrusive for browsers, visible to tooling.
            const newHeaders = new Headers(resp.headers);
            newHeaders.set('Deprecation', 'true');
            newHeaders.set('Sunset', 'Wed, 01 Jan 2027 00:00:00 GMT');
            newHeaders.set('Link', '<' + (self.sessionBasePath || '') + '/__nimbus/worker' + workerPath +
                '>; rel="successor-version"');
            return new Response(resp.body, {
                status: resp.status, statusText: resp.statusText, headers: newHeaders,
            });
        }
        return resp;
    }
    // ── Port route: routes to facet HTTP servers ──
    // PortRegistry returns a proxied response when the facet handler is
    // attached and an explicit 501 for a reserved port without a handler.
    // Also the landing point for the `<port>--<sid>` preview hostname, which
    // the router forwards here.
    const portMatch = url.pathname.match(/^\/port\/(\d+)(\/.*)?$/);
    if (portMatch) {
        const port = parseInt(portMatch[1]);
        const path = normalizeForwardedHttpPath(portMatch[2] || '/');
        // An embedder that authenticated a preview capability at its own edge
        // forwards it here; the guest's Authorization then survives the hop.
        const capability = request.headers.get(PREVIEW_CAPABILITY_HEADER);
        return routeToSessionPort(self, port, request, path, portRouteMountBase(request, port), capability ?? undefined);
    }
    // ── /api/_diag/cache — per-tier cache observability ───────────────
    //
    // Cache-observability wave: surfaces the L1/L2/L3/L4 × tarball/
    // packument/asset hit/miss/bytes grid maintained by
    // src/_shared/cache-stats.ts. Pre-wave the only observability was
    // /api/_diag/memory.r2.* (RPC-call level), which conflated L2 and
    // L3 and missed L1 entirely.
    //
    // Added at the END of handleFetch so future wave additions to the
    // diag cluster (typically inserted near other /api/_diag/* routes)
    // don't cause merge conflicts in the cache-observability commit.
    // POST /reset zeros the counters in-place for fresh measurement
    // windows; the dual-endpoint pattern mirrors /api/_test/* reset
    // helpers used by the recovery-event probe.
    if (url.pathname === '/api/_diag/exec' && request.method === 'GET') {
        const { readExecTelemetry } = await import('../facets/exec-telemetry.js');
        return Response.json({ records: readExecTelemetry() });
    }
    // Write surfaces gated like /api/_test/*: zeroing telemetry from prod
    // would erase the evidence an investigation is standing on, so without
    // NIMBUS_DEBUG these 404 rather than being a free reset vector.
    if (url.pathname === '/api/_diag/exec/reset' && request.method === 'POST') {
        if (!self.nimbusDebug)
            return new Response('not found', { status: 404 });
        const { resetExecTelemetry } = await import('../facets/exec-telemetry.js');
        resetExecTelemetry();
        return new Response(null, { status: 204 });
    }
    if (url.pathname === '/api/_diag/cache' && request.method === 'GET') {
        const { snapshot } = await import('@nimbus-sh/core/_shared/cache-stats.js');
        const snap = snapshot();
        return Response.json(snap);
    }
    if (url.pathname === '/api/_diag/cache/reset' && request.method === 'POST') {
        if (!self.nimbusDebug)
            return new Response('not found', { status: 404 });
        const { reset } = await import('@nimbus-sh/core/_shared/cache-stats.js');
        reset();
        return new Response(null, { status: 204 });
    }
    return new Response('Not found', { status: 404 });
}
// ── cache-and-scrub L2 benchmark endpoint ───────────────────────────────
//
// Routes under /api/_test/cache/* exercise the L2 (`caches.default`)
// layer that wraps R2 packument/tarball reads + the env.ASSETS
// esbuild-wasm fetch. Probes assert the L2 hit path is ≥5× faster
// than the cold path (the wave's hard ship-gate).
//
// Endpoint surface (all NIMBUS_DEBUG-gated by the parent router):
//
//   POST /api/_test/cache/packument/seed    {name, payload}
//        → write the packument to R2 (so cold reads have something to
//          serve) AND purge any stale L2 entry (so the first bench
//          read is guaranteed L3-only).
//   GET  /api/_test/cache/packument/bench?name=X&n=N
//        → run N sequential getPackument(X) calls, return latencies[].
//   POST /api/_test/cache/tarball/seed       {sizeKb}
//        → similar; payload is a synthetic Uint8Array of sizeKb*1024.
//          Tarballs are content-addressed, so the seed returns the
//          integrity string to bench against.
//   GET  /api/_test/cache/tarball/bench?integrity=sha512-...&n=N
//        → similar.
//   GET  /api/_test/cache/wasm/bench?n=N
//        → run N sequential fetchEsbuildWasmBytes() calls. The first
//          is asset-fetch + L2 write; subsequent should hit L2.
async function handleCacheTestEndpoint(self, url, request) {
    const env = self.env;
    const path = url.pathname;
    // Build a fresh R2CacheClient bound to the request's env (mirrors
    // SupervisorRPC._r2 in semantics — graceful-degrade on missing
    // bindings).
    const r2 = new R2CacheClient(env?.NPM_TARBALL_CACHE ?? null, env?.NPM_PACKUMENT_CACHE ?? null);
    const caches = globalThis.caches;
    const purgeL2 = async (synthUrl) => {
        try {
            await caches?.default?.delete(new Request(synthUrl));
        }
        catch { }
    };
    if (path === '/api/_test/cache/packument/seed' && request.method === 'POST') {
        const body = await parseJsonBody(request, CachePackumentSeedBodySchema);
        const name = body.name;
        const payload = body.payload == null ? JSON.stringify({ name, versions: {} }) : String(body.payload);
        if (!name)
            return Response.json({ error: 'missing name' }, { status: 400 });
        // Purge L2 first so the next bench read starts from L3 cold.
        await purgeL2(packumentL2Url(name));
        const ok = await r2.putPackument(name, payload);
        return Response.json({ seeded: ok, name, payloadBytes: payload.length });
    }
    if (path === '/api/_test/cache/packument/bench' && request.method === 'GET') {
        const name = url.searchParams.get('name') ?? '';
        const n = Math.max(1, Math.min(20, parseInt(url.searchParams.get('n') || '5', 10)));
        if (!name)
            return Response.json({ error: 'missing name' }, { status: 400 });
        const latencies = [];
        let lastBytes = 0;
        let nullCount = 0;
        for (let i = 0; i < n; i++) {
            const t0 = performance.now();
            const got = await r2.getPackument(name);
            const t1 = performance.now();
            latencies.push(t1 - t0);
            if (!got)
                nullCount++;
            else
                lastBytes = got.json.length;
        }
        // R2CacheClient instance was constructed at the top of this
        // handler; counters reflect the N calls just made.
        const stats = r2.stats();
        return Response.json({ name, n, latencies, lastBytes, nullCount, stats });
    }
    if (path === '/api/_test/cache/tarball/seed' && request.method === 'POST') {
        const body = await parseJsonBody(request, CacheTarballSeedBodySchema);
        const sizeKb = Math.max(1, Math.min(15360, body.sizeKb || 16)); // up to 15 MiB (under MAX_R2_TARBALL_BYTES = 30 MiB)
        // Synthetic payload — content is arbitrary but must be addressed by
        // its own digest, same as a real tarball. Deterministic in sizeKb so
        // a bench run can be repeated against the same address.
        const bytes = new Uint8Array(sizeKb * 1024);
        for (let i = 0; i < bytes.length; i++)
            bytes[i] = i & 0xff;
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', bytes));
        let bin = '';
        for (let i = 0; i < digest.length; i++)
            bin += String.fromCharCode(digest[i]);
        const integrity = `sha512-${btoa(bin)}`;
        const address = parseTarballAddress(integrity);
        await purgeL2(tarballL2Url(address));
        const ok = await r2.putTarball(integrity, bytes);
        return Response.json({ seeded: ok, integrity, sizeBytes: bytes.length });
    }
    if (path === '/api/_test/cache/tarball/bench' && request.method === 'GET') {
        const integrity = url.searchParams.get('integrity') ?? '';
        const n = Math.max(1, Math.min(20, parseInt(url.searchParams.get('n') || '5', 10)));
        if (!parseTarballAddress(integrity)) {
            return Response.json({ error: 'missing/unparseable integrity' }, { status: 400 });
        }
        const latencies = [];
        let lastBytes = 0;
        let nullCount = 0;
        for (let i = 0; i < n; i++) {
            const t0 = performance.now();
            const got = await r2.getTarball(integrity);
            const t1 = performance.now();
            latencies.push(t1 - t0);
            if (!got)
                nullCount++;
            else
                lastBytes = got.length;
        }
        const stats = r2.stats();
        return Response.json({ integrity, n, latencies, lastBytes, nullCount, stats });
    }
    if (path === '/api/_test/cache/wasm/reset' && request.method === 'POST') {
        // Purge the L2 entry so the next bench call goes cold (re-runs
        // env.ASSETS.fetch + L2 write-back). The L2 key is exported
        // from esbuild-wasm-bytes.ts so the test endpoint stays in
        // lockstep with the runtime module's key shape across any
        // future ESBUILD_VERSION bump.
        await purgeL2(ESBUILD_WASM_L2_KEY);
        return Response.json({ purged: true });
    }
    if (path === '/api/_test/cache/wasm/bench' && request.method === 'GET') {
        const n = Math.max(1, Math.min(10, parseInt(url.searchParams.get('n') || '3', 10)));
        const latencies = [];
        let lastBytes = 0;
        for (let i = 0; i < n; i++) {
            const t0 = performance.now();
            const ab = await fetchEsbuildWasmBytes(env);
            const t1 = performance.now();
            latencies.push(t1 - t0);
            lastBytes = ab.byteLength;
        }
        return Response.json({ n, latencies, lastBytes });
    }
    return new Response('unknown cache _test endpoint', { status: 404 });
}
// ── two-tier-fanout primitive benchmark endpoint ────────────────────────
//
// Routes under /api/_test/fanout/* exercise Fanout's two
// topologies (in-DO fanout in-DO + peer-DO fanout peer-DO) via a synthetic workload
// that's independent of the production install-batch / pre-bundle
// sites. The probe measures speedup, peer-DO routing determinism,
// and backpressure behavior in isolation.
//
// Endpoint surface (all NIMBUS_DEBUG-gated by the parent router):
//
//   GET /api/_test/fanout/topology?n=N
//        → returns which topology N would route to (no dispatch).
//   GET /api/_test/fanout/route?n=N&keys=k1,k2,...
//        → returns the deterministic peer-DO sibling-id per key.
//   POST /api/_test/fanout/bench {n, sleepMs}
//        → runs N synthetic tasks, each sleeping `sleepMs` inside
//          its loader isolate. Returns total wall time + per-peer
//          ledger of how many tasks each peer DO handled.
//   POST /api/_test/fanout/serial-bench {n, sleepMs}
//        → runs N synthetic tasks SERIALLY (concurrency=1) inside
//          ONE loader isolate. Used to compute T_serial for the
//          5× speedup assertion.
//
// The synthetic worker function intentionally doesn't import npm
// packages or do real I/O — it just sleeps, so the parallelism
// floor is the loader/RPC overhead, not network jitter.
async function handleFanoutTestEndpoint(self, url, request) {
    const env = self.env;
    const path = url.pathname;
    if (path === '/api/_test/fanout/topology' && request.method === 'GET') {
        const n = Math.max(0, parseInt(url.searchParams.get('n') || '0', 10));
        const pool = new Fanout(env, self.ctx, {
            tag: 'fanout-bench',
            timeoutMs: 60_000,
        });
        return Response.json({
            n,
            topology: pool.topologyFor(n),
            inDoThreshold: IN_DO_THRESHOLD,
            maxPeerFanout: MAX_PEER_FANOUT,
        });
    }
    if (path === '/api/_test/fanout/route' && request.method === 'GET') {
        const keysRaw = url.searchParams.get('keys') || '';
        const keys = keysRaw.split(',').map((k) => k.trim()).filter(Boolean);
        const peerCount = Math.max(1, Math.min(parseInt(url.searchParams.get('n') || String(keys.length), 10), MAX_PEER_FANOUT));
        const pool = new Fanout(env, self.ctx, {
            tag: 'fanout-bench',
            timeoutMs: 60_000,
        });
        const placement = keys.map((k) => ({
            key: k,
            siblingId: pool.peerSiblingId(k, peerCount),
        }));
        return Response.json({ peerCount, placement });
    }
    if (path === '/api/_test/fanout/bench' && request.method === 'POST') {
        const body = await parseJsonBody(request, FanoutBenchBodySchema);
        const n = Math.max(1, Math.min(64, body.n || 8));
        const sleepMs = Math.max(0, Math.min(2000, body.sleepMs || 100));
        const pool = new Fanout(env, self.ctx, {
            tag: 'fanout-bench',
            timeoutMs: 60_000,
        });
        const tasks = Array.from({ length: n }, (_, i) => ({
            key: `task-${i}`,
            args: { id: i, sleepMs },
        }));
        const t0 = performance.now();
        // The function runs INSIDE each loader isolate; we use Date.now()
        // (millisecond resolution is fine; we're sleeping for ms-scale)
        // to record per-task start/end so the supervisor can compute the
        // distribution after the fact.
        const results = await pool.submitMany(tasks, async (item, env) => {
            const startMs = Date.now();
            // Identify which env we're running in. SUPERVISOR is the
            // RPC stub auto-injected by IsolatePool; its presence
            // tells us we're inside a loader isolate (not the supervisor).
            const loaderEnvKeys = Object.keys(env || {}).sort();
            // Sleep entirely inside the isolate — no external network.
            await new Promise((r) => setTimeout(r, item.sleepMs));
            const endMs = Date.now();
            return { id: item.id, startMs, endMs, loaderEnvKeys };
        });
        const t1 = performance.now();
        // Aggregate per-peer ledger from the response shape. Each task's
        // result includes its loaderEnvKeys; the SUPERVISOR binding's
        // doId is observable to confirm peer routing (if peer-DO topology
        // is in use, each task's SUPERVISOR.doId differs from the
        // coordinator's). We don't expose doId here directly — we rely
        // on peerSiblingId predicting placement and inspecting the
        // overlap in start/end timestamps to infer parallelism.
        const startTimes = results.map((r) => r.startMs);
        const endTimes = results.map((r) => r.endMs);
        const minStart = Math.min(...startTimes);
        const maxEnd = Math.max(...endTimes);
        const totalDurations = results.map((r) => r.endMs - r.startMs);
        return Response.json({
            n,
            sleepMs,
            wallTimeMs: t1 - t0,
            results,
            analysis: {
                minStart,
                maxEnd,
                spanMs: maxEnd - minStart,
                sumDurations: totalDurations.reduce((a, b) => a + b, 0),
                topology: pool.topologyFor(n),
            },
        });
    }
    if (path === '/api/_test/fanout/serial-bench' && request.method === 'POST') {
        const body = await parseJsonBody(request, FanoutBenchBodySchema);
        const n = Math.max(1, Math.min(64, body.n || 8));
        const sleepMs = Math.max(0, Math.min(2000, body.sleepMs || 100));
        // Same workload, but FORCE serial dispatch by using a single
        // IsolatePool with concurrency=1 and submitting one task
        // at a time. This is the T_serial reference for the 5× speedup
        // assertion.
        const { IsolatePool } = await import('@nimbus-sh/fabric/isolate-pool.js');
        const pool = new IsolatePool(env, self.ctx, {
            concurrency: 1,
            timeoutMs: 60_000,
            tag: 'fanout-serial',
        });
        const t0 = performance.now();
        try {
            for (let i = 0; i < n; i++) {
                await pool.submit(async (item) => {
                    await new Promise((r) => setTimeout(r, item.sleepMs));
                    return item.id;
                }, { id: i, sleepMs });
            }
        }
        finally {
            try {
                pool.dispose();
            }
            catch { }
        }
        const t1 = performance.now();
        return Response.json({ n, sleepMs, wallTimeMs: t1 - t0 });
    }
    return new Response('unknown fanout _test endpoint', { status: 404 });
}
