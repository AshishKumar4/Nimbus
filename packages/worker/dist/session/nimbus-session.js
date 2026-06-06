/**
 * nimbus-session.ts — NimbusSession Durable Object (v2.0).
 *
 * The supervisor DO that owns the VFS, shell, and all commands.
 * `node` execution is delegated to dynamic workers via LOADER.load().
 * IPC between facets and the supervisor flows through SupervisorRPC.
 */
import { DurableObject as CloudflareDurableObject } from 'cloudflare:workers';
import { SqliteVFS } from '../vfs/sqlite-vfs.js';
import { FacetManager } from '../facets/manager.js';
import { FacetProcessManager } from '../facets/process.js';
import { ChildProcessSpawnPool } from '../loaders/child-process/spawn-pool.js';
import { ProcessTable } from '../runtime/process-table.js';
import { ProcessLogStore } from '../runtime/process-logs.js';
import { PortRegistry } from '../runtime/port-registry.js';
import { EsbuildService } from '../runtime/esbuild-service.js';
import { registerAllocObserver } from '../observability/heavy-alloc-coord.js';
import { NpmInstaller } from '../npm/installer.js';
// S10: oom-discriminator helpers (recordFailure, getFailures,
// getLastRpcFrame, getLastFacetId, snapshotForStorage, rehydrateFromStorage)
// moved to sibling modules (-rpc uses recordFailure for _reportExternalExit;
// -ws uses recordFailure for webSocketError; -diag uses getFailures +
// snapshotForStorage + rehydrateFromStorage; -routes uses getFailures +
// getLastRpcFrame + getLastFacetId for /api/_diag/memory). Class file
// no longer references any of them directly.
// S10: classifyError, LRU_MAX_ENTRIES, fetchEsbuildWasmBytes moved to
// sibling modules (-rpc, -routes, esbuild-wasm-bytes); class file no
// longer references them directly. Phase 2 A'.5 renamed the function
// (was getEsbuildWasmBytes; cached) to fetchEsbuildWasmBytes (no
// supervisor cache; goes through env.ASSETS on demand).
import { setCtxExports } from './ctx-exports.js';
import { NIMBUS_VERSION, DEFAULT_HOSTNAME, CF_COMPAT_DATE } from '../constants.js';
import { seedProject } from '../vfs/seed-project.js';
import { BASE_PATH_HEADER } from '../_shared/session-router.js';
import { notifyTerminalEvent } from '../runtime/process-logs-api.js';
// S3: tryEnableReplicas + getReplicaState extracted to ./nimbus-session-replica.ts.
import { wireReplicasOnConstruct as _w12WireReplicasOnConstruct, getReplicaState as _w12GetReplicaState, } from './replica-routes.js';
// S5: storage-key constants moved to ./nimbus-session-keys.ts; consumed by
// sibling modules (-hib, -diag, -ws). The class file itself no longer
// references any storage key directly.
// S4: W9 hibernation surface extracted.
import { wireHibernationOnConstruct as _w9WireHibernationOnConstruct, wireProcessLogPersist as _w9DoWireProcessLogPersist, ensureHibSchema as _w9DoEnsureHibSchema, scheduleHibFlush as _w9DoScheduleHibFlush, dispatchAlarm as _w9DoDispatchAlarm, maybeBumpIsolateGen as _w9DoMaybeBumpIsolateGen, flushOnClose as _w9DoFlushOnClose, } from './hibernation.js';
// S6: initSession (1875 LOC of cmd registrations + boot wiring) extracted.
import { initSession as _w11InitSession } from './init.js';
// S7: webSocket lifecycle (message, close, error, F1 discriminator,
// _w5SafePersistRing) extracted.
import { wsMessage as _wsDoMessage, wsClose as _wsDoClose, wsError as _wsDoError, safePersistRing as _wsDoSafePersistRing, } from './ws.js';
// S8: Supervisor RPC + W8 cp* + legacy VFS impls extracted.
import * as _rpc from './rpc.js';
// S9: HTTP fetch routing extracted (combined S9a + S9b).
import * as _routes from './routes.js';
// Programmatic SDK RPC surface.
import * as _programmatic from './programmatic.js';
// S10: heap probe + W5 OOM-ring persistence extracted.
import * as _diag from './diag.js';
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
import { _classifyCommand, } from './helpers.js';
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
// Re-exports preserved for callers that import from nimbus-session
// directly (the historical entry point). Each one has a dedicated
// import site elsewhere in the codebase.
export { filterWranglerFlags, detectBundlerBin, checkNodeModulesGuard, detectUnsupportedWranglerConfig, renderNoDevServerHtml, BUNDLER_BIN_PREFIXES, NIMBUS_UNSUPPORTED_BINS, WRANGLER_IGNORED_FLAGS, WRANGLER_IGNORED_FLAGS_WITH_VALUE, WRANGLER_UNSUPPORTED_CONFIG_FIELDS, } from './helpers.js';
// W10: detectCloudflareWorkersProject lives in src/project-detect.ts so
// unit-level tests can import it without pulling in cloudflare:workers.
// Re-export here so the existing import surface (callers that already
// import from nimbus-session) continues to work.
export { detectCloudflareWorkersProject } from '../runtime/project-detect.js';
/**
 * Render the welcome MOTD banner with column-counted padding so every
 * line lands the right ║ on the same column regardless of how many
 * non-ASCII characters (em-dash, middle-dot) the content contains.
 *
 * Width model: each "row" is built by left-aligning content into a
 * fixed inner-width slot, then bracketed by ║ and padded with spaces.
 * Codepoint count is used as the column count. This is correct for
 * all characters in the current banner — box-drawing (U+2500-U+257F),
 * em-dash (U+2014), and middle-dot (U+00B7) are all defined as
 * 1-cell-wide in the Unicode East Asian Width table (`Na`/`A`/`N`).
 *
 * Why this exists: pre-fix, the banner used hand-counted padding
 * literals. Adding/removing a single character (e.g. version bumping
 * from "v2.0" to "v2.0.0") shifted line 2 by one column, breaking
 * the right boundary. See user-debug-transcript.txt lines 1-5.
 */
export function renderMotdBanner(version) {
    const INNER_WIDTH = 48; // columns between the two ║
    const lines = [
        `Nimbus v${version} — Cloud Dev Environment`,
        'node · npm · vite · clang · python · ruby',
        '10 GB VFS · REPLs · nimbus install · HMR',
    ];
    const padLine = (content) => {
        // 2-space left margin inside the box, then content, then trailing
        // spaces to reach INNER_WIDTH columns total.
        const indented = '  ' + content;
        const used = [...indented].length;
        const padding = Math.max(0, INNER_WIDTH - used);
        return `║${indented}${' '.repeat(padding)}║`;
    };
    const top = '╔' + '═'.repeat(INNER_WIDTH) + '╗';
    const bot = '╚' + '═'.repeat(INNER_WIDTH) + '╝';
    return ('\x1b[1;36m' +
        top + '\r\n' +
        lines.map(padLine).join('\r\n') + '\r\n' +
        bot +
        '\x1b[0m\r\n');
}
export function renderWelcomeMarkdown(version) {
    return `# Welcome to Nimbus v${version}

Cloud-native development environment on Cloudflare Workers.

## Start Here

| Task | Command |
| --- | --- |
| Run JavaScript | \`node hello.js\` |
| Install npm packages | \`npm install <pkg>\` |
| Start the starter app | \`cd app && npm install && npm run dev\` |
| Run a Cloudflare Worker locally | \`nimbus-wrangler dev\` |

## Install More Runtimes

Nimbus installs language runtimes on demand:

\`\`\`bash
nimbus install clang       # then: clang hello.c -o hello && ./hello
nimbus install python      # then: python -c 'print("hi")'
nimbus install ruby        # then: ruby -e 'puts "hi"'
\`\`\`

\`python3\`, \`ruby3\`, and \`wasm-ld\` are command aliases. If an
installable command is missing, Nimbus prints the matching install command.

## Interactive REPLs

| Runtime | REPL |
| --- | --- |
| Python | \`python\` or \`python3\` - Pyodide CPython 3.13 |
| Ruby | \`ruby\` or \`ruby3\` - ruby.wasm 3.3 |
| Node | \`node\` - workerd Node compatibility runtime |

## System Commands

\`\`\`bash
nimbus install --list       # show installed runtimes
nimbus install --available  # show catalog
df                          # filesystem + cache stats
\`\`\`

The editor opens this file in Markdown preview mode by default. Use
\`Ctrl+P\` to open files and \`Ctrl+S\` to save edits.
`;
}
export class NimbusSession extends CloudflareDurableObject {
    // this.ctx and this.env are provided by the DurableObject base class
    sqliteFs = null;
    kernel = null;
    shell = null;
    terminal = null;
    facetManager = null;
    /** W8: child_process broker. Lazy — only constructed when first cp* RPC arrives. */
    facetProcessManager = null;
    esbuildService = null;
    viteDevServer = null;
    /**
     * runtime primitive support (P5): PID + port the default-Cirrus vite shim is
     * registered under. Cleared on `vite stop`. See
     * `runtime/long-running-handle.ts` and the vite handler in
     * `session/init.ts`.
     */
    _viteShimPid = null;
    _viteShimPort = null;
    /**
     * Opt-in real-vite mode (Phase 0 spike). Activated when the user sets
     * NIMBUS_REAL_VITE=1 in the shell env or `nimbusDevServer: 'real'` in
     * vite.config.ts. Runs real Vite in a dynamic-worker facet, bypassing
     * the in-process Cirrus shim. Coexists with viteDevServer — only one
     * is live per session.
     */
    cirrusReal = null;
    /**
     * Map of HMR WebSocket (server-side) → clientId. Populated when the
     * browser's @vite/client opens a connection at /preview/__nimbus_hmr;
     * consumed by the message+close handlers on the WS itself.
     * Non-hibernatable (we use server.accept(), not ctx.acceptWebSocket).
     */
    _cirrusHmrWsClients = null;
    /** file-tree-watch (2026-05-15): per-WS fs-watch subscriptions.
     *  Lazily created on first fs-watch-subscribe by src/session/fs-watch.ts;
     *  cleaned up unconditionally in src/session/ws.ts on wsClose / wsError.
     *  Optional (undefined) until first subscribe so sessions that never
     *  open the file tree carry no watch state. */
    _fsWatchSubs;
    nimbusWrangler = null;
    npmInstaller = null;
    /** Singleton fetch proxy entrypoint — created once, reused for all npm fetches. */
    fetchProxyEntrypoint = null;
    processTable;
    portRegistry;
    // S4: visibility relaxed (was `private`) so ./nimbus-session-hib.ts's
    // HibHost interface can declare it. Per plan §IX.1.
    processLogs = new ProcessLogStore();
    /** W1: idempotency flag for the alarm-driven log-janitor bootstrap.
     *  Replaces the pre-W1 `processLogsTimer` setTimeout handle (which
     *  prevented hibernation per CF DO docs). The alarm itself lives in
     *  DO storage at key `w1_next_alarm_reasons`. */
    processLogsJanitorWired = false;
    // ── W9 — hibernation persistence + auto-response config ───────────────
    /**
     * Result of `configureWsHibernation` at constructor time. Exposed via
     * `/api/_diag/memory` under `hib.autoResponseConfigured`,
     * `hib.timeoutSetMs` etc. `null` until the constructor's wiring runs
     * (which it does unconditionally — left null only on a defensive
     * catch-all).
     */
    // S4: visibility relaxed (was `private`) so ./nimbus-session-hib.ts's
    // free functions can read/write via the HibHost interface. Per plan
    // §IX.1 (refined option b'). Sigil `_w9*` flags it as internal.
    _w9WsConfig = null;
    /**
     * Monotonic isolate generation counter. Each fresh isolate (cold start
     * or post-hibernation wake) increments this and persists to storage.
     * Lets `/api/_diag/memory` confirm whether a wake actually happened
     * between two probe calls.
     */
    _w9IsolateGen = 0;
    /** True once we've persisted the bumped gen counter to storage. */
    _w9IsolateGenPersisted = false;
    /** SQL DDL — idempotent; run on first fetch. */
    _w9SchemaInit = false;
    /** Have we wired the persist adapter into ProcessLogStore yet? */
    _w9PersistWired = false;
    /**
     * Debounced flush state. Append marks the timer; the timer fires
     * after W9_FLUSH_DEBOUNCE_MS and calls `processLogs.flush()`. We
     * also flush eagerly when `dirtyChunks * pidCount` crosses a threshold
     * — but the debounce handles the steady-state case.
     *
     * S5: storage keys + the debounce constant moved to ./nimbus-session-keys.ts.
     */
    _w9FlushTimer = null;
    // ── Heap-pressure probe state ───────────────────────────────────────────
    /**
     * Peak supervisor heap (rss + heapUsed) seen since process start. Updated
     * by `_diagSampleMemory()` on every call to `/api/_diag/memory`. Used to
     * confirm OOM hypotheses without re-running the failure: a peak that
     * grew toward 128 MB during pre-bundle is direct evidence the supervisor
     * isolate is the one being killed. Survives the lifetime of THIS isolate
     * only — a DO reboot resets it to 0, which is itself a useful signal
     * (peak == 0 immediately after the banner re-printed = the killed
     * isolate took its peak with it).
     */
    _diagPeakRss = 0;
    _diagPeakHeapUsed = 0;
    _diagPeakAt = 0;
    _diagSampleCount = 0;
    /**
     * Fix 5: toggled by env NIMBUS_DEBUG=1 (checked each call; cheap enough).
     * When true: spawn banners and exit traces are unconditional (not just
     * long-running facets), RPC envelope errors are surfaced to the terminal
     * with a [rpc-error] prefix, and the exit trace includes duration_ms.
     *
     * The flag is derived from `this.env.NIMBUS_DEBUG` — the binding comes
     * from wrangler's var declaration or a test harness.
     */
    get nimbusDebug() {
        try {
            const e = this.env;
            return e?.NIMBUS_DEBUG === '1' || e?.NIMBUS_DEBUG === 'true';
        }
        catch {
            return false;
        }
    }
    // ── W12 — DO read replicas state ────────────────────────────────────
    /**
     * Result of `tryEnableReplicas(this.ctx)` at constructor time. Surfaced
     * via `/api/_diag/memory.replica` so operators can confirm whether the
     * runtime accepted the SPEC API. Stays `null` if the constructor's
     * call ran before this assignment (defensive — should never happen).
     */
    // S3: visibility relaxed (was `private`) so ./nimbus-session-replica.ts's
    // free functions can read/write via the ReplicaHost interface. Per plan
    // §IX.1 (refined option b'). Sigil `_w12*` still flags it as internal.
    _w12EnableResult = null;
    /**
     * Public URL prefix this DO is mounted at (e.g. `/s/nimble-otter-4271`).
     * Set from the `X-Nimbus-Base` request header on the first forwarded
     * request and persisted so it survives hibernation. Empty string means
     * "unknown" (e.g. direct DO stub call from legacy callers) — in that
     * case ViteDevServer falls back to the bare `/preview` default.
     *
     * NOTE: this is the SESSION prefix, not the vite preview prefix. The
     * full vite basePath is `sessionBasePath + '/preview'`.
     */
    sessionBasePath = '';
    /** Have we attempted to hydrate sessionBasePath from storage yet? */
    sessionBasePathHydrated = false;
    /**
     * Has the "wrangler is aliased to nimbus-wrangler" banner been shown
     * this session? Reset on WebSocket close/reopen so a reconnecting user
     * sees it once per terminal attach. Purely cosmetic; no persistence.
     */
    wranglerAliasBannerShown = false;
    constructor(ctx, env) {
        super(ctx, env); // enables RPC on the DO
        // In `wrangler dev`, the outer Worker and this DO share a single
        // workerd process, so the `setCtxExports(ctx.exports)` call in the
        // outer fetch handler (src/index.ts) is visible here via the
        // module-level singleton in ctx-exports.ts. In PROD they run in
        // separate isolates — that outer setter never reaches us, so
        // getCtxExports() returns null, the facet pool falls back silently,
        // and facets get `env.SUPERVISOR === undefined` → writeBatch throws.
        //
        // DurableObjectState.exports is exposed at compat date ≥ 2025-11-17.
        // We're on 2026-04-01, so `ctx.exports` is present. Capture it here
        // so the DO's own loopback bindings are available to the facet-pool
        // and facet-manager in prod as well as dev.
        const ctxExports = ctx?.exports;
        if (ctxExports)
            setCtxExports(ctxExports);
        this.processTable = new ProcessTable();
        this.portRegistry = new PortRegistry();
        // W1: log-janitor moved to alarm-driven scheduling (was a
        // self-renewing setTimeout chain at rpc.ts:_ensureLogJanitor;
        // per CF DO docs that prevented hibernation, billing duration
        // continuously). The delegator below forwards `this.ctx` so
        // scheduleAlarm can write to ctx.storage.
        this._ensureLogJanitor();
        // ── W9 (CF research §C.3 + §C.4) ──────────────────────────────────
        //
        // Configure WS auto-response (`ping`/`pong`) so vite HMR + xterm
        // idle pings don't wake the actor from hibernation. ~95% drop in
        // billable wakes per the research doc. Auto-response config and
        // hibernation event timeout both survive hibernation per the
        // STOR/Durable Objects WebSocket Primer ("Survives: Auto-response
        // configuration") — set once, forget.
        //
        // Failures are non-fatal — older workerd builds may lack the APIs.
        // The result lands in /api/_diag/memory.hib for verification.
        // S4: extracted to ./nimbus-session-hib.ts.
        this._w9WsConfig = _w9WireHibernationOnConstruct(this.ctx);
        // Wire the ProcessLogStore to its persist adapter (CF research §C.2,
        // Lever 11). Idempotent: only runs once per isolate. The DDL +
        // adapter run lazily on first append/read, but the wiring itself
        // happens here so any subsequent call (including initSession) sees
        // the adapter in place.
        this._w9WireProcessLogPersist();
        // ── W12 — Lever 12 / G3 / H1 — DO read replicas (best-effort).
        //
        // Constructor runs on EVERY isolate (primary + replica alike). Replicas
        // get a stub at `ctx.storage.primary` from the runtime; primaries get
        // `undefined`. We call `enableReplicas()` defensively — pre-GA runtimes
        // lacking the API surface get `state: 'unsupported'` and the DO behaves
        // exactly as pre-W12 (single-primary). Result is captured for the
        // `/api/_diag/memory.replica` block.
        // S3: extracted to ./nimbus-session-replica.ts. Passes ctx
        // explicitly because `protected ctx` can't be put on a public
        // interface (per nimbus-session-replica.ts ReplicaHost docs).
        this._w12EnableResult = _w12WireReplicasOnConstruct(this.ctx);
    }
    // ── W9 hibernation methods extracted to ./nimbus-session-hib.ts (S4) ──
    //
    // The class retains the public method NAMES (delegator pattern per plan
    // §IX.4 R1: delegators are immortal until S13). Bodies live in -hib.ts.
    // Methods _w9*-prefixed dropped `private` because the diag handler at
    // /api/_diag/memory + sibling modules need to call them (or because the
    // free function signature requires `host` typed as HibHost which can't
    // see `private` members).
    _w9WireProcessLogPersist() {
        return _w9DoWireProcessLogPersist(this, this.ctx);
    }
    _w9EnsureSchema() {
        return _w9DoEnsureHibSchema(this, this.ctx);
    }
    _w9ScheduleFlush() {
        return _w9DoScheduleHibFlush(this, this.ctx);
    }
    /**
     * W1: multi-reason alarm handler. Routes via a `w1_next_alarm_reasons`
     * storage map managed by `scheduleAlarm` (see ./hibernation.ts).
     * Dispatches every pending reason whose deadline has passed, then
     * re-arms `ctx.storage.setAlarm` at the earliest remaining deadline.
     * Today's reasons: 'w9-flush' (process-log SQL drain) and
     * 'log-janitor' (dropOlderThan sweep). The janitor body needs an
     * orphan-pid predicate so we close over `processTable` here.
     */
    async alarm() {
        return _w9DoDispatchAlarm(this, this.ctx, _rpc._logJanitorOrphanCheck(this));
    }
    /** W9: increment + persist isolate-gen counter once per fresh isolate. */
    async _w9MaybeBumpIsolateGen() {
        return _w9DoMaybeBumpIsolateGen(this, this.ctx);
    }
    /**
     * Convenience: the full URL prefix for the Vite dev server inside this
     * session (e.g. `/s/nimble-otter-4271/preview`). Falls back to the
     * historical default when sessionBasePath is unknown so legacy callers
     * and unit tests keep working.
     */
    get viteBasePath() {
        return (this.sessionBasePath || '') + '/preview';
    }
    /**
     * Lazily hydrate sessionBasePath from storage, then overwrite with the
     * current request's `X-Nimbus-Base` header if present. Call at the top
     * of `_handleFetch` before any HTML rendering or ViteDevServer spawn.
     *
     * We always trust the most recent header over storage, because a DO
     * instance is always pinned to one session ID (via idFromName) but the
     * URL prefix COULD change across deploys (e.g. if we ever rename `/s/`).
     */
    async hydrateSessionBasePath(request) {
        if (!this.sessionBasePathHydrated) {
            try {
                const saved = await this.ctx.storage.get('session-base-path');
                if (typeof saved === 'string')
                    this.sessionBasePath = saved;
            }
            catch { /* storage unavailable — stay empty */ }
            this.sessionBasePathHydrated = true;
        }
        const fromHeader = request.headers.get(BASE_PATH_HEADER);
        if (fromHeader && fromHeader !== this.sessionBasePath) {
            this.sessionBasePath = fromHeader;
            try {
                await this.ctx.storage.put('session-base-path', fromHeader);
            }
            catch { }
        }
    }
    // ── Supervisor RPC + W8 cp* + legacy VFS extracted to
    // ── ./nimbus-session-rpc.ts (S8). See plan §B.3.4.
    //
    // The class retains every method NAME so the DO RPC fabric (which
    // dispatches by name from the stub) keeps working. Method bodies are
    // 1-line delegators that pass `this as any` (per plan §IX rec 1 +
    // DEFECT-D1: ctx is protected and not on a public interface).
    // Supervisor RPC (file/log/HMR/batch)
    async _rpcReadFile(path) { return _rpc._rpcReadFile(this, path); }
    async _rpcReadFileBytes(path) { return _rpc._rpcReadFileBytes(this, path); }
    async _rpcInnerDoFetch(req) { return _rpc._rpcInnerDoFetch(this, req); }
    async _rpcWriteFile(path, content) { return _rpc._rpcWriteFile(this, path, content); }
    async _rpcStat(path) { return _rpc._rpcStat(this, path); }
    async _rpcReaddir(path) { return _rpc._rpcReaddir(this, path); }
    async _rpcExists(path) { return _rpc._rpcExists(this, path); }
    async _rpcMkdir(path) { return _rpc._rpcMkdir(this, path); }
    async _rpcRmdir(path) { return _rpc._rpcRmdir(this, path); }
    async _rpcRename(from, to) { return _rpc._rpcRename(this, from, to); }
    async _rpcReadlink(path) { return _rpc._rpcReadlink(this, path); }
    async _rpcSymlink(target, path) { return _rpc._rpcSymlink(this, target, path); }
    async _rpcFsRevision(path) { return _rpc._rpcFsRevision(this, path); }
    async _rpcFsOpen(path, flags) { return _rpc._rpcFsOpen(this, path, flags); }
    async _rpcFsRead(handleId, offset, length) {
        return _rpc._rpcFsRead(this, handleId, offset, length);
    }
    async _rpcFsWrite(handleId, offset, bytes) {
        return _rpc._rpcFsWrite(this, handleId, offset, bytes);
    }
    async _rpcFsClose(handleId) { return _rpc._rpcFsClose(this, handleId); }
    async _rpcHmrRelay(clientId, msg) { return _rpc._rpcHmrRelay(this, clientId, msg); }
    async _rpcUnlink(path) { return _rpc._rpcUnlink(this, path); }
    async _rpcWriteBatch(payload) { return _rpc._rpcWriteBatch(this, payload); }
    async _rpcWriteBatchStream(stream) { return _rpc._rpcWriteBatchStream(this, stream); }
    async _rpcPutRegistryEntries(entries) { return _rpc._rpcPutRegistryEntries(this, entries); }
    async _rpcRecordCacheStats(events) { return _rpc._rpcRecordCacheStats(this, events); }
    async _rpcStdout(pid, data) { return _rpc._rpcStdout(this, pid, data); }
    async _rpcStderr(pid, data) { return _rpc._rpcStderr(this, pid, data); }
    async _rpcReportExit(pid, code, tail) { return _rpc._rpcReportExit(this, pid, code, tail); }
    // W3 emitters / external-exit / log janitor
    _emitExitDump(pid, code) { return _rpc._emitExitDump(this, pid, code); }
    _emitShellExecDone(pid, cmd, code, durationMs) { return _rpc._emitShellExecDone(this, pid, cmd, code, durationMs); }
    _reportExternalExit(pid, code, reason) { return _rpc._reportExternalExit(this, pid, code, reason); }
    _ensureLogJanitor() { return _rpc._ensureLogJanitor(this, this.ctx); }
    // Misc supervisor RPC
    async _rpcPrefetch(cwd, entryCode) { return _rpc._rpcPrefetch(this, cwd, entryCode); }
    async _rpcRegisterPort(pid, port) { return _rpc._rpcRegisterPort(this, pid, port); }
    async _rpcUnregisterPort(port) { return _rpc._rpcUnregisterPort(this, port); }
    async _rpcTransform(code, loader) { return _rpc._rpcTransform(this, code, loader); }
    // two-tier-fanout: peer-DO execute leg of NimbusFanoutPool's peer-DO fanout topology.
    async _rpcFanoutExecute(fnSource, args, poolOpts) {
        return _rpc._rpcFanoutExecute(this, fnSource, args, poolOpts);
    }
    // W8 child_process RPC
    async _rpcCpSpawn(req) { return _rpc._rpcCpSpawn(this, req); }
    async _rpcCpStdinWrite(childPid, data) { return _rpc._rpcCpStdinWrite(this, childPid, data); }
    async _rpcCpStdinEnd(childPid) { return _rpc._rpcCpStdinEnd(this, childPid); }
    async _rpcCpReadStdin(childPid, waitMs) { return _rpc._rpcCpReadStdin(this, childPid, waitMs); }
    async _rpcCpReadOutput(childPid, fd, sinceSeq, waitMs) { return _rpc._rpcCpReadOutput(this, childPid, fd, sinceSeq, waitMs); }
    async _rpcCpDrainOutput(childPid) { return _rpc._rpcCpDrainOutput(this, childPid); }
    async _rpcCpKill(childPid, signal) { return _rpc._rpcCpKill(this, childPid, signal); }
    async _rpcCpWait(childPid, waitMs) { return _rpc._rpcCpWait(this, childPid, waitMs); }
    // child-process isolation gap #1: per-spawn fresh-isolate dispatch.
    async _rpcCpDispatchInline(req, kind) { return _rpc._rpcCpDispatchInline(this, req, kind); }
    // Programmatic sandbox SDK RPC
    async _rpcReady(options) { return _programmatic.ensureProgrammaticReady(this, options); }
    async _rpcExec(command, options) { return _programmatic.rpcExec(this, command, options); }
    async _rpcStartProcess(command, options) { return _programmatic.rpcStartProcess(this, command, options); }
    async _rpcRunCode(code, options) {
        return _programmatic.rpcRunCode(this, code, options);
    }
    async _rpcInstallRuntime(spec, options) { return _programmatic.rpcInstallRuntime(this, spec, options); }
    async _rpcEnsureRuntimes(specs, options) { return _programmatic.rpcEnsureRuntimes(this, specs, options); }
    async _rpcListRuntimes() { return _programmatic.rpcListRuntimes(this); }
    async _rpcListProcesses() { return _programmatic.rpcListProcesses(this); }
    async _rpcKillProcess(pid) { return _programmatic.rpcKillProcess(this, pid); }
    async _rpcProcessLogs(pid, options) { return _programmatic.rpcProcessLogs(this, pid, options); }
    async _rpcListPorts() { return _programmatic.rpcListPorts(this); }
    async _rpcExposePort(port) { return _programmatic.rpcExposePort(this, port); }
    async _rpcUnexposePort(port) { return _programmatic.rpcUnexposePort(this, port); }
    async _rpcDeleteFile(path, options) { return _programmatic.rpcDeleteFile(this, path, options); }
    async _rpcDestroy(options) { return _programmatic.rpcDestroy(this, options); }
    // Legacy VFS (direct method calls)
    vfsReadFile(path) { return _rpc.vfsReadFile(this, path); }
    vfsReadFileString(path) { return _rpc.vfsReadFileString(this, path); }
    vfsStat(path) { return _rpc.vfsStat(this, path); }
    vfsExists(path) { return _rpc.vfsExists(this, path); }
    vfsReaddir(path) { return _rpc.vfsReaddir(this, path); }
    vfsWriteFile(path, data) { return _rpc.vfsWriteFile(this, path, data); }
    // ── HTTP handler ──────────────────────────────────────────────────────
    async fetch(request) {
        try {
            return await this._handleFetch(request);
        }
        catch (e) {
            console.error('[nimbus] Unhandled fetch error:', e?.message, e?.stack);
            return new Response(`Internal Error: ${e?.message}`, { status: 500 });
        }
    }
    // ── HTTP fetch routing extracted to ./nimbus-session-routes.ts (S9).
    // The class retains the DO-contract `fetch` method + `_handleFetch`
    // delegator (per plan §IX.4 R1).
    async _handleFetch(request) {
        return _routes.handleFetch(this, request);
    }
    /**
     * Read process.memoryUsage() if nodejs_compat exposes it. Returns null
     * on environments where the binding is absent (older compat dates,
     * non-Workers test harnesses). Never throws — heap probes must be
     * fault-tolerant so a probe that fails in prod doesn't take the
     * request handler down with it.
     */
    // ── W12 — getReplicaState() — exposed via /api/_diag/memory.replica.
    //
    // Delegator. Impl extracted to ./nimbus-session-replica.ts (S3).
    // Stays public-by-name so the diag handler at /api/_diag/memory keeps
    // working unchanged. The CT1 drift detector reads the result.
    getReplicaState() {
        return _w12GetReplicaState(this, this.ctx);
    }
    // Heap probe + W5 ring helpers extracted to ./nimbus-session-diag.ts (S10).
    // The class retains delegator methods because the diag handler at
    // /api/_diag/memory + the ws lifecycle + ensureSqliteFs all call them.
    _diagReadNodeMem() {
        return _diag.readNodeMem();
    }
    _diagReadPerfMem() {
        return _diag.readPerfMem();
    }
    _diagSampleMemory() {
        return _diag.sampleMemory(this);
    }
    ensureSqliteFs() {
        if (!this.sqliteFs) {
            this.sqliteFs = new SqliteVFS(this.ctx.storage.sql, this.ctx);
            // Audit C1: surface deferred-flush failures. SqliteVFS.writeFile()
            // is synchronous (fire-and-forget by design — see LIFO MountProvider
            // contract) so it can't return an error to the caller. Instead the
            // VFS retries once and then calls these handlers for chunks that
            // failed twice. We log to the user's terminal (non-spammy — the
            // VFS also logs to the Worker console for operator triage) and
            // make the error visible in /api/stats via getStats().
            this.sqliteFs.onWriteError((err) => {
                try {
                    if (this.terminal) {
                        this.terminal.write(`\x1b[31m[vfs] write failed: ${err.path} chunk ${err.chunkId} ` +
                            `(attempts=${err.attempts}): ${err.error}\x1b[0m\r\n`);
                    }
                }
                catch { /* handler must not throw back into the flush path */ }
            });
            // W5 Lever 8: shrinkForInstall() during heavy-alloc windows.
            // The observer fires only on 0→1 / ≥1→0 edges (registerAllocObserver
            // in heavy-alloc-coord.ts handles the refcount). Default shrink
            // target 128 entries × 64 KB = 8 MiB; +24 MiB heap headroom
            // during install / clone / pre-bundle. See W5-plan.md §2.
            const vfs = this.sqliteFs;
            registerAllocObserver({
                onAcquire: () => {
                    try {
                        vfs.shrinkForInstall();
                    }
                    catch (e) {
                        console.warn('[nimbus/W5] shrinkForInstall threw:', e?.message);
                    }
                },
                onRelease: () => {
                    try {
                        vfs.restoreAfterInstall();
                    }
                    catch (e) {
                        console.warn('[nimbus/W5] restoreAfterInstall threw:', e?.message);
                    }
                },
            });
            // W5 Lever 5: rehydrate the OOM ring from storage (best-effort).
            // Survives DO hibernation; lets cf-tail-style forensics include
            // pre-hibernate failures. Fail-soft on garbage / missing — the
            // rehydrate function's own contract.
            this._w5RehydrateRingFromStorage().catch((e) => {
                console.warn('[nimbus/W5] ring rehydrate failed:', e?.message);
            });
        }
    }
    // ── W5 Lever 5: ring buffer persistence on DO storage ─────────────────
    // Storage key W5_RING_STORAGE_KEY lives in ./nimbus-session-keys.ts (S5).
    // Bounded ≤20 KB by oom-discriminator.ts; one async put per
    // webSocketClose where the ring is non-empty.
    /** Track when we last persisted to avoid redundant writes. */
    _w5LastPersistAt = 0;
    /** Track ring size at last persist; skip write if unchanged. */
    _w5LastPersistRingSize = -1;
    /** B'.4 — live initSession phase. Surfaced via
     *  /api/_diag/session.phase. null pre-first-init. */
    _b4Phase = null;
    /** B'.5 — count of warm-rejoin /ws upgrades. Increments each
     *  time the join path is taken (Phase B skipped). 0 means no
     *  warm rejoins yet. Surfaced via /api/_diag/session.warmJoinCount. */
    _b4WarmJoinCount = 0;
    async _w5RehydrateRingFromStorage() {
        return _diag.rehydrateRingFromStorage(this, this.ctx);
    }
    /** Snapshot + persist OOM ring. Delegator → ./nimbus-session-diag.ts (S10). */
    _w5PersistRing() {
        return _diag.persistRing(this, this.ctx);
    }
    ensureFacetManager() {
        if (!this.facetManager) {
            this.facetManager = new FacetManager(this.ctx, this.env, this.processTable, this.portRegistry, {
                onExternalExit: (pid, code, reason) => this._reportExternalExit(pid, code, reason),
                onSpawn: (pid, command, longRunning) => {
                    // Only surface long-running / user-visible spawns to keep
                    // the terminal uncluttered. Short `node <file>` evals also
                    // get a line because users want the pid for `logs`/`kill`.
                    if (!this.terminal)
                        return;
                    const label = longRunning ? 'started (long-running)' : 'started';
                    this.terminal.write(`\x1b[2m[facet ${label}: pid=${pid} cmd="${command}"]\x1b[0m\r\n`);
                    // Structured event so the tabs UI can auto-open a log tab
                    // for long-running processes (vite, wrangler dev, etc.).
                    notifyTerminalEvent(this.terminal, { type: 'spawn', pid, command, longRunning });
                },
            });
        }
        if (this.facetManager && this.sqliteFs) {
            this.facetManager.setVfs(this.sqliteFs);
            // W3.5 Fix B: share the session's lazy esbuildService with the
            // FacetManager so the bundle's ESM→CJS pre-pass doesn't pay
            // wasm-init twice. If the session hasn't constructed one yet,
            // FacetManager will lazy-create its own on first exec — same
            // wasm bytes, same ~10ms init cost, just paid once per surface.
            if (this.esbuildService) {
                this.facetManager.setEsbuildService(this.esbuildService);
            }
        }
    }
    /**
     * W8: lazily construct the FacetProcessManager when the first cp* RPC
     * arrives. Wired with adapters that bridge the Nimbus shell command
     * registry to the FacetProcessManager's CommandRegistryLike contract.
     */
    _ensureFacetProcessManager() {
        if (this.facetProcessManager)
            return this.facetProcessManager;
        this.ensureSqliteFs();
        this.ensureFacetManager();
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
                    payload = JSON.parse(codeJson);
                }
                catch {
                    payload = { command: '', args: [], env: {}, cwd: '/' };
                }
                const registry = this._cpRegistry;
                if (!registry) {
                    hooks.onStderr('child_process: command registry unavailable\n');
                    return 127;
                }
                const commandName = normalizeCpCommandName(payload.command);
                const cmd = await registry.resolve(commandName);
                if (!cmd) {
                    hooks.onStderr(`${payload.command}: command not found\n`);
                    return 127;
                }
                // Synthesize a CommandContext compatible with @lifo-sh/core.
                const stdoutStream = { write: (d) => hooks.onStdout(String(d)) };
                const stderrStream = { write: (d) => hooks.onStderr(String(d)) };
                const ac = new AbortController();
                const ctx = {
                    args: payload.args || [],
                    env: payload.env || {},
                    cwd: payload.cwd || '/home/user',
                    vfs: this.sqliteFs,
                    stdout: stdoutStream,
                    stderr: stderrStream,
                    signal: ac.signal,
                    // For commands that need stdin we pass a tiny adapter.
                    stdin: {
                        read: async () => null,
                        readAll: async () => payload.stdin || '',
                    },
                    __nimbusCaptureOutput: true,
                };
                try {
                    const code = await cmd(ctx);
                    return typeof code === 'number' ? code : 0;
                }
                catch (e) {
                    hooks.onStderr(`${payload.command}: ${e?.message || String(e)}\n`);
                    return 1;
                }
            },
            abort: (facetName) => {
                // Best-effort: relay to ctx.facets.abort, mirroring FacetManager.kill.
                try {
                    this.ctx.facets?.abort?.(facetName, new Error('SIGKILL'));
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
            // commands (registerUnixCommands / registerGitCommands / npm /
            // wrangler etc.) are seen even if they're not in the static
            // _CP_PURE_BUILTIN allow-list. Falls back to the static
            // facet-direct table for known facet-only commands. Returns null
            // (→ exit 127) for everything unknown.
            resolve: (name) => {
                const commandName = normalizeCpCommandName(name);
                const registry = this._cpRegistry;
                if (registry && typeof registry.has === 'function' && registry.has(commandName)) {
                    // Registered — classify by name. Reuse the static table so
                    // facet-direct commands (node/npm/git/...) keep their kind
                    // even when they ALSO happen to be registry entries.
                    return _classifyCommand(commandName) || { kind: 'pure-builtin' };
                }
                return _classifyCommand(commandName);
            },
            runPureBuiltin: async (name, args, env, cwd, stdin, hooks) => {
                const registry = this._cpRegistry;
                if (!registry) {
                    hooks.onStderr('cp: registry unavailable\n');
                    return 127;
                }
                const commandName = normalizeCpCommandName(name);
                const cmd = await registry.resolve(commandName);
                if (!cmd) {
                    hooks.onStderr(`${name}: command not found\n`);
                    return 127;
                }
                const ac = new AbortController();
                const ctx = {
                    args, env, cwd,
                    vfs: this.sqliteFs,
                    stdout: { write: (d) => hooks.onStdout(String(d)) },
                    stderr: { write: (d) => hooks.onStderr(String(d)) },
                    signal: ac.signal,
                    stdin: { read: async () => null, readAll: async () => stdin },
                    __nimbusCaptureOutput: true,
                };
                try {
                    const code = await cmd(ctx);
                    return typeof code === 'number' ? code : 0;
                }
                catch (e) {
                    hooks.onStderr(`${name}: ${e?.message || String(e)}\n`);
                    return 1;
                }
            },
        };
        // child-process isolation gap #1: per-spawn fresh-isolate envelope. The pool wraps
        // NimbusFanoutPool — auto-routes <5 → in-DO fanout in-DO, ≥5 → peer-DO fanout
        // peer-DO. Hard-fails at construction if env.LOADER missing (no
        // fallback). The pool is constructed lazily on the same path that
        // builds FacetProcessManager so unit tests that don't supply
        // env.LOADER still work via the legacy in-supervisor dispatch.
        let spawnPool;
        try {
            const envAny = this.env;
            if (envAny?.LOADER && typeof envAny.LOADER.get === 'function') {
                spawnPool = new ChildProcessSpawnPool(this.env, this.ctx);
            }
        }
        catch {
            spawnPool = undefined;
        }
        this.facetProcessManager = new FacetProcessManager({
            facetMgr: facetMgrAdapter,
            processTable: this.processTable,
            processLogs: this.processLogs,
            vfs: this.sqliteFs,
            commandRegistry: cmdRegistryAdapter,
            shellExecutor: {
                execute: async (commandLine, env, cwd, stdin, hooks) => {
                    if (!this.shell) {
                        hooks.onStderr('sh: shell unavailable\n');
                        return 127;
                    }
                    const result = await this.shell.execute(String(commandLine), {
                        cwd: cwd || '/home/user',
                        env: { ...this.shell.env, ...(env || {}) },
                        onStdout: (d) => hooks.onStdout(String(d)),
                        onStderr: (d) => hooks.onStderr(String(d)),
                        stdin,
                    });
                    return typeof result?.exitCode === 'number' ? result.exitCode : 0;
                },
            },
            ctx: this.ctx,
            spawnPool,
        });
        return this.facetProcessManager;
    }
    /**
     * Set the shell command registry for the W8 broker to dispatch
     * resolved commands. Called from the shell-init path right after
     * `registerUnixCommands(registry, sqliteFs)`.
     */
    _cpRegistry = null;
    _setCpRegistry(r) { this._cpRegistry = r; }
    /**
     * Get or create the singleton fetch proxy entrypoint.
     * ONE dynamic worker is created via LOADER.load() and reused for ALL npm
     * fetch calls across the lifetime of this DO instance. This prevents
     * ephemeral port exhaustion from creating a new worker per fetch.
     */
    ensureFetchProxy(log) {
        if (this.fetchProxyEntrypoint)
            return this.fetchProxyEntrypoint;
        try {
            const env = this.env;
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
            this.fetchProxyEntrypoint = worker.getEntrypoint();
            log?.('Fetch proxy worker created (singleton)');
            return this.fetchProxyEntrypoint;
        }
        catch (e) {
            log?.(`Fetch proxy creation failed: ${e?.message}`);
            return null;
        }
    }
    /**
     * Build a FetchFn that routes through the singleton proxy entrypoint.
     * All concurrent fetches share ONE worker — no port exhaustion.
     */
    buildFetchFn(log) {
        const entrypoint = this.ensureFetchProxy(log);
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
    ensureNpmInstaller(onProgress) {
        this.ensureSqliteFs();
        if (!this.esbuildService) {
            this.esbuildService = new EsbuildService(this.sqliteFs);
        }
        // ── Lazy fetch-proxy ────────────────────────────────────────────
        // The fetch-proxy is a singleton dynamic worker (LOADER.load) that
        // buffers registry responses to dodge wrangler-local-dev port
        // exhaustion. It is ONLY needed by the legacy in-supervisor
        // resolveTree path (src/npm-resolver.ts). With NIMBUS_FACET_RESOLVER
        // default-on (commit 9194998) the resolver runs in a facet that
        // uses bare globalThis.fetch — no proxy needed. Same for the
        // install-batch-facet path (commit c285025) — uses bare fetch.
        //
        // workerd has a per-DO cap on concurrent dynamic workers (~5-6
        // empirically). A permanent live proxy worker eats one of those
        // slots for the entire DO lifetime. Skipping the proxy in the
        // default-on configuration buys us back a slot.
        //
        // Proxy is only built when ANY legacy fallback is active — this
        // way `NIMBUS_FACET_RESOLVER=0` (rolling back the resolver) or
        // `NIMBUS_FACET_NPM_INSTALL_BATCH=0` (rolling back install-batch)
        // still works exactly as before. Same emergency-rollback contract.
        const useFacetResolver = this._envFlagDefaultOn('NIMBUS_FACET_RESOLVER');
        const useFacetInstall = this._envFlagDefaultOn('NIMBUS_FACET_NPM_INSTALL');
        const useBatchFacet = this._envFlagDefaultOn('NIMBUS_FACET_NPM_INSTALL_BATCH');
        const needProxy = !(useFacetResolver && useFacetInstall && useBatchFacet);
        const fetchFn = needProxy ? this.buildFetchFn(onProgress) : undefined;
        if (!needProxy) {
            onProgress?.(`[npm] Lazy fetch-proxy: skipped (all facet paths default-on)`);
        }
        this.npmInstaller = new NpmInstaller(this.sqliteFs, this.ctx.storage.sql, {
            esbuild: this.esbuildService,
            ctx: this.ctx,
            env: this.env,
            onProgress,
            fetchFn,
        });
    }
    /**
     * Read an environment flag with default-on semantics. Mirrors the
     * shouldUseFacetPool / shouldUseFacetResolver / shouldUseBatchFacet
     * gates inside NpmInstaller — kept here as a private helper so the
     * lazy-proxy decision uses identical semantics without leaking that
     * private API across modules.
     */
    _envFlagDefaultOn(name) {
        const raw = this.env?.[name];
        if (raw === undefined || raw === null)
            return true;
        const s = String(raw).toLowerCase();
        if (s === '0' || s === '' || s === 'false' || s === 'off' || s === 'no')
            return false;
        return true;
    }
    // ── Session initialization ────────────────────────────────────────────
    // ── Session initialization ────────────────────────────────────────────
    //
    // S6: body extracted to ./nimbus-session-init.ts (1875 LOC of registry
    // command registrations + boot wiring). The class retains `initSession`
    // as a delegator per plan §IX.4 R1. Visibility relaxed (was `private`)
    // so the SessionInternal interface declares it.
    initSession(ws) {
        // Cast pattern (per plan §IX recommendation 1, used here only because
        // initSession reads this.ctx + this.env extensively; siblings that need
        // ctx/env take them as separate explicit args per DEFECT-D1).
        return _w11InitSession(this, ws);
    }
    // ── Filesystem seeding ────────────────────────────────────────────────
    seedFilesystem() {
        const fs = this.sqliteFs;
        const dirs = [
            'bin', 'etc', 'home', 'home/user', 'home/user/.config',
            'tmp', 'var', 'var/log', 'usr', 'usr/bin', 'usr/lib',
            'usr/lib/node_modules', 'usr/share', 'usr/share/pkg',
            'usr/share/pkg/node_modules', 'opt',
            'home/user/projects',
        ];
        for (const dir of dirs) {
            if (!fs.exists(dir))
                fs.mkdir(dir, { recursive: true });
        }
        if (!fs.exists('etc/hostname')) {
            fs.writeFile('etc/hostname', DEFAULT_HOSTNAME + '\n');
        }
        if (!fs.exists('etc/os-release')) {
            fs.writeFile('etc/os-release', `NAME="Nimbus"\nVERSION="${NIMBUS_VERSION}"\nID=nimbus\n` +
                'PRETTY_NAME="Nimbus — Cloud Dev Environment"\n');
        }
        if (!fs.exists('etc/profile')) {
            fs.writeFile('etc/profile', 'export PATH=/usr/bin:/bin\nexport EDITOR=nano\n');
        }
        if (!fs.exists('home/user/.nimbusrc')) {
            fs.writeFile('home/user/.nimbusrc', '# Nimbus shell config\nalias ll="ls -la"\nalias la="ls -a"\nalias l="ls -1"\n');
        }
        {
            // [BANNER ALIGNMENT FIX] Always re-render the motd so existing
            // sessions whose VFS has the pre-fix mis-aligned banner get the
            // corrected version on next reconnect. Cheap (~200 bytes); no
            // user-edit collision concern (the file isn't user-owned).
            const expectedMotd = renderMotdBanner(NIMBUS_VERSION);
            let needsWrite = !fs.exists('etc/motd');
            if (!needsWrite) {
                try {
                    const existing = fs.readFileString('etc/motd');
                    if (existing !== expectedMotd)
                        needsWrite = true;
                }
                catch {
                    needsWrite = true;
                }
            }
            if (needsWrite)
                fs.writeFile('etc/motd', expectedMotd);
        }
        if (!fs.exists('home/user/hello.js')) {
            fs.writeFile('home/user/hello.js', 'console.log("Hello from Nimbus!");\n' +
                'console.log("Executed in a Dynamic Worker isolate");\n' +
                'console.log("Platform:", process.platform, "| PID:", process.pid);\n' +
                'console.log("2 + 2 =", 2 + 2);\n');
        }
        // seed-refresh (2026-05-15): symmetric to hello.js — give new users
        // a starter C file so the clang demo in README.md / Docs.tsx works
        // without typing the source by hand.
        if (!fs.exists('home/user/hello.c')) {
            fs.writeFile('home/user/hello.c', '#include <stdio.h>\n' +
                '\n' +
                'int main(void) {\n' +
                '  printf("Hello from Nimbus C!\\n");\n' +
                '  return 0;\n' +
                '}\n');
        }
        if (!fs.exists('home/user/welcome.md')) {
            fs.writeFile('home/user/welcome.md', renderWelcomeMarkdown(NIMBUS_VERSION));
        }
        // ── Starter app (Vite + React + TS + Tailwind + Router) ──
        // Idempotent: guarded by shouldSeedProject() which checks both a
        // sentinel file and the project dir. Safe to call on every boot.
        try {
            seedProject(fs, { log: (msg) => console.log(msg) });
        }
        catch (e) {
            console.error('[nimbus] seedProject failed:', e?.message || e);
        }
    }
    // ── WebSocket lifecycle ───────────────────────────────────────────────
    //
    // S7: bodies extracted to ./nimbus-session-ws.ts. Class retains the
    // method NAMES per plan §IX.4 R1 (DO RPC fabric needs them). Visibility
    // relaxed for the methods (default-public; was async/private).
    async webSocketMessage(ws, message) {
        return _wsDoMessage(this, ws, message);
    }
    async webSocketClose(ws, code, reason, wasClean) {
        return _wsDoClose(this, ws, code, reason, wasClean);
    }
    async webSocketError(ws, error) {
        return _wsDoError(this, ws, error);
    }
    /** W9: synchronous flush on close. Delegator → ./nimbus-session-hib.ts (S4). */
    _w9FlushOnClose() {
        return _w9DoFlushOnClose(this);
    }
    /** W5: bridge _w5PersistRing → ctx.waitUntil. Delegator → ./nimbus-session-ws.ts (S7). */
    _w5SafePersistRing() {
        return _wsDoSafePersistRing(this);
    }
}
// ── W10 Inner-Worker + assets bindings extracted to
// ── ./nimbus-session-bindings.ts (S2). See plan §B.3.9.
// ── Re-exported here so src/index.ts's wrangler entry-graph
// ── reachability is preserved.
export { NimbusAssetsRPC, NimbusLoaderRPC, NimbusLoadedWorker, NimbusLoadedEntrypoint, NimbusDurableObjectNamespace, NimbusDOStub, } from './bindings.js';
