/**
 * nimbus-session-routes.ts — HTTP fetch routing.
 *
 * Extracted from src/nimbus-session.ts per
 * audit/sections/SESSION-REFACTOR-PLAN.md §B.3.5 + S9 (combining S9a + S9b
 * into a single commit because the static-analysis gates verify byte-equivalent
 * extraction regardless of split granularity).
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

import { handleReplicaPreflight as _w12HandleReplicaPreflight } from './replica-routing.js';
import { replicasSuspended as _w12ReplicasSuspended } from './replica-suspension.js';
import {
  matchLogsPath, handleLogsWebSocketRequest, handleProcessesListRequest,
} from './process-logs-api.js';
import { readDiagCounters } from './diag-counters.js';
import { getFailures, getLastRpcFrame, getLastFacetId } from './oom-discriminator.js';
import { LRU_MAX_ENTRIES } from './constants.js';
import { handleSupervisorRpc } from './supervisor-rpc.js';
import { EsbuildService } from './esbuild-service.js';
import { ViteDevServer } from './vite-dev-server.js';
import { ProcessLogStore } from './process-logs.js';
import { renderNoDevServerHtml } from './nimbus-session-helpers.js';

type RoutesHost = any;

export async function handleFetch(self: RoutesHost, request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Capture session basePath from the routing header (if forwarded by the
    // Worker's session-router). Threaded through to ViteDevServer so the
    // served app's module URLs, HMR paths, <base href>, and router basename
    // all resolve under `/s/<id>/preview/...`.
    await self.hydrateSessionBasePath(request);
    // W9: bump the isolate generation counter on the FIRST request of a
    // new isolate (cold start or post-hibernation wake). Cheap — one
    // storage.get + one storage.put per isolate. Subsequent calls in the
    // same isolate are a fast no-op (gated by _w9IsolateGenPersisted).
    await self._w9MaybeBumpIsolateGen();

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
    } catch (e: any) {
      // Preflight should never throw, but never let a routing helper kill
      // request handling. Log + continue with local handling.
      console.warn('[nimbus/W12] preflight threw:', e?.message);
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      // Audit F2 (STABILITY-AUDIT.md C-S2): reject a second /ws upgrade
      // while the session already has an attached terminal. Previously
      // initSession unconditionally overwrote self.terminal / self.shell
      // / self.kernel, silently cross-wiring two browser tabs to the
      // same session DO (tab A's keystrokes routed to tab B's shell).
      // There is no per-ws terminal map today, so the safe behaviour
      // is to keep one-at-a-time and tell the client.
      if (self.shell != null) {
        return new Response(
          JSON.stringify({
            error: 'session already has active terminal',
            hint: 'open a new /new session',
          }),
          {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      self.ctx.acceptWebSocket(server);
      // Audit F1: tag the shell socket so webSocketClose/webSocketError
      // can discriminate it from HMR sockets (which tag themselves
      // 'cirrus-hmr' at :1239). Without this, a hibernation-attached
      // shell socket's attachment is undefined — indistinguishable
      // from any other untagged hibernation socket — and the close
      // handler can't tell whether to null the terminal.
      try { (server as any).serializeAttachment?.({ kind: 'shell' }); } catch {}
      try {
        self.initSession(server);
      } catch (err: any) {
        console.error('initSession error:', err?.message, err?.stack);
        return new Response('Init failed: ' + err?.message, { status: 500 });
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    // ── Process log streaming / listing — see src/process-logs-api.ts ──
    const logsPid = matchLogsPath(url.pathname);
    if (logsPid !== null) {
      return handleLogsWebSocketRequest(request, logsPid, {
        processLogs: self.processLogs,
        processTable: self.processTable,
        // W9: pass ctx so the upgrade uses ctx.acceptWebSocket (hibernatable).
        ctx: self.ctx as any,
      });
    }
    if (url.pathname === '/api/processes') {
      return handleProcessesListRequest(self.processTable, self.processLogs);
    }

    if (url.pathname === '/api/memory') {
      // Minimal memory probe for stability investigations (WORKERD-CRASH
      // hypotheses). Reports whatever we can measure inside workerd:
      //   - vfs.{totalFiles, totalBytes} from the SQLite VFS
      //   - process.memoryUsage() if nodejs_compat exposes it (else zeros)
      //   - performance.memory when present (Chromium-style heap info)
      self.ensureSqliteFs();
      let nodeMem: any = null;
      try {
        const g: any = globalThis as any;
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
      } catch { /* ignore */ }
      let perfMem: any = null;
      try {
        const g: any = globalThis as any;
        if (g.performance && g.performance.memory) {
          perfMem = {
            jsHeapSizeLimit: g.performance.memory.jsHeapSizeLimit | 0,
            totalJSHeapSize: g.performance.memory.totalJSHeapSize | 0,
            usedJSHeapSize: g.performance.memory.usedJSHeapSize | 0,
          };
        }
      } catch { /* ignore */ }
      const vfs = self.sqliteFs!.getStats();
      return Response.json({
        vfs: { files: vfs.files, usedBytes: vfs.usedBytes },
        nodeMem,
        perfMem,
        ts: Date.now(),
      });
    }

    // ── Diagnostic memory probe ──────────────────────────────────────────
    // /api/_diag/memory — supervisor heap pressure with peak tracking.
    //
    // Why a second endpoint when /api/memory already exists:
    //   1. /api/memory is a snapshot only. To prove an OOM hypothesis
    //      we need the PEAK heap during a workload, captured even if
    //      the kill happens microseconds after the high-water mark.
    //   2. Peak survives across many polls; one poll right after the
    //      crash's reboot will report peak=0 (this isolate just started),
    //      itself a positive signal that the prior isolate was killed.
    //   3. Never colocate diagnostic state with the prod /api/memory
    //      contract — keep behavioural endpoints stable, evolve
    //      /api/_diag/* freely.
    //
    // Returns the same nodeMem/perfMem fields as /api/memory plus:
    //   - peak: { rssBytes, heapUsedBytes, atMs, samples } — high-water
    //     marks observed since this isolate started. Updated on every
    //     call to this endpoint (cheap; pre-bundle and install paths
    //     can call it themselves to record their own peaks).
    //   - limitBytes: workerd's hard DO heap cap (128 MiB) for context.
    //   - usagePctOfLimit: heapUsed / limit, for at-a-glance reading.
    //
    // Permanent infra: keep this endpoint even after the prebundle OOM
    // is fixed. Future memory regressions will use it the same way.
    if (url.pathname === '/api/_diag/memory') {
      self.ensureSqliteFs();
      self._diagSampleMemory();
      const nodeMem = self._diagReadNodeMem();
      const perfMem = self._diagReadPerfMem();
      const vfs = self.sqliteFs!.getStats();
      const DO_HEAP_LIMIT_BYTES = 128 * 1024 * 1024;
      const heapUsed = nodeMem?.heapUsed ?? 0;
      // Application-level counters from src/diag-counters.ts. workerd's
      // process.memoryUsage() returns 0 for all fields inside DO class
      // contexts (only dynamic-worker isolates under nodejs_compat get
      // the real implementation). These deterministic counters are the
      // primary signal for OOM-hypothesis verification —
      // `cumulativePackumentBytesDecoded` in particular is the smoking
      // gun for the resolver-phase OOM. Pre-fix it climbs into hundreds
      // of MB on the supervisor; post-fix (resolver moved to facet) it
      // stays near 0.
      const counters = readDiagCounters();
      // W5 Lever 5: cause-discriminated last-failures + last-RPC-frame
      // + last-facet-id + LRU shrink state. Back-compat with v1: every
      // existing field preserved; new fields are additive. See
      // audit/sections/W5-plan.md §5.
      // `vfs` here is the getStats() result (line 1268). vfs.cache holds
      // the LRU stats including the W5-augmented maxEntries/lruShrunk.
      const cacheStats = (vfs as any).cache ?? {};
      const lastFailures = getFailures();
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

        // ── v2 / W5 additions ─────────────────────────────────────
        lastFailures,
        vfsDetail: {
          lruBytes: cacheStats.hotBytes ?? 0,
          lruMaxEntries: cacheStats.maxEntries ?? LRU_MAX_ENTRIES,
          lruMaxBytes: cacheStats.maxBytes ?? (LRU_MAX_ENTRIES * 65536),
          lruShrunk: cacheStats.lruShrunk ?? false,
          evictions: cacheStats.evictions ?? 0,
          hitRate: cacheStats.hitRate ?? 0,
        },
        rpc: {
          lastFrame: getLastRpcFrame(),
        },
        facet: {
          lastDispatch: getLastFacetId(),
        },

        // ── W9: hibernation observability ───────────────────────────
        // `hib.isolateGen` increments per fresh isolate (cold start or
        // post-hibernation wake). Two probe calls a minute apart with
        // different gens means a hibernation/wake cycle ran in between.
        // `rehydrated*` counters are >0 only on the first hydrate after
        // a wake. `flushed*` counters track the alarm-driven SQL writes.
        // `autoResponseConfigured` reports the runtime's actual
        // capability (older workerd builds report false).
        hib: {
          isolateGen: self._w9IsolateGen,
          autoResponseConfigured: self._w9WsConfig?.autoResponseConfigured ?? false,
          autoResponseError: self._w9WsConfig?.autoResponseError ?? null,
          hibernationEventTimeoutMs: self._w9WsConfig?.timeoutSetMs ?? null,
          timeoutError: self._w9WsConfig?.timeoutError ?? null,
          ...self.processLogs.hibStats(),
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

    // ── W9: hibernation simulation + diagnostic spawn (NIMBUS_DEBUG=1) ──
    //
    // These endpoints exist to let local probes exercise the cross-
    // hibernation code path. Real DO hibernation only happens in prod;
    // wrangler dev keeps state across requests. So we simulate the
    // "fresh isolate per dispatch" rule by clearing the in-memory
    // ProcessLogStore — the next read MUST hydrate from SQL.
    //
    // 404 when NIMBUS_DEBUG isn't set, so prod isn't a free vector.
    if (url.pathname.startsWith('/api/_test/') ) {
      if (!self.nimbusDebug) {
        return new Response('not found', { status: 404 });
      }
      if (url.pathname === '/api/_test/hib/simulate' && request.method === 'POST') {
        // Drain any pending writes first so SQL is the source of truth,
        // then nuke the in-memory ring. The next read on any pid will
        // re-hydrate via the adapter.
        try { self.processLogs.flush(); } catch {}
        const fresh = new ProcessLogStore();
        // Re-wire persist on the new store (mirrors constructor path).
        self._w9PersistWired = false;
        self.processLogs = fresh;
        self._w9WireProcessLogPersist();
        return Response.json({ cleared: true, ts: Date.now() });
      }
      if (url.pathname === '/api/_test/spawn-emitter' && request.method === 'POST') {
        // Spawns a synthetic emitter directly into ProcessLogStore +
        // ProcessTable without going through FacetManager. Lets the e2e
        // probe drive the W9 code path without a real long-running
        // facet (which the test environment may not support).
        try {
          const body = await request.json() as any;
          const lines = Math.max(1, Math.min(1000, Number(body.lines) || 50));
          const text = String(body.lineText || 'line');
          const entry = self.processTable.spawn(`_test:${text}`, ['_test'], '/');
          const pid = entry.pid;
          for (let i = 0; i < lines; i++) {
            self.processLogs.append(pid, 'stdout', `${text} ${i}\n`);
          }
          // Force-flush so SQL reflects state before the next request.
          try { self.processLogs.flush(); } catch {}
          return Response.json({ pid, lines });
        } catch (e: any) {
          return Response.json({ error: e?.message }, { status: 400 });
        }
      }
      if (url.pathname === '/api/_test/log-tail' && request.method === 'GET') {
        const pid = parseInt(url.searchParams.get('pid') || '', 10);
        const linesQ = parseInt(url.searchParams.get('lines') || '0', 10) || undefined;
        if (!Number.isFinite(pid) || pid <= 0) {
          return Response.json({ error: 'bad pid' }, { status: 400 });
        }
        const chunks = self.processLogs.tail(pid, linesQ ? { lines: linesQ } : {});
        const allText = chunks.map((c: any) => c.data).join('');
        const lines = allText.split('\n').filter((l: string) => l !== '');
        return Response.json({ pid, lines, chunkCount: chunks.length });
      }
      return new Response('unknown _test endpoint', { status: 404 });
    }

    if (url.pathname === '/api/stats') {
      self.ensureSqliteFs();
      const vfsStats = self.sqliteFs!.getStats();
      const processStats = self.processTable.stats;
      const logStoreStats = self.processLogs.stats;
      // Preview UI polls vite.running to decide between /preview/ and
      // the "no dev server" placeholder. We report running:true if
      // EITHER the Cirrus in-process ViteDevServer OR the opt-in
      // real-vite facet (cirrusReal) is live. Without this merge, a
      // session on NIMBUS_REAL_VITE=1 saw vite.running=false even
      // while real-vite was happily serving on /preview/.
      const legacyViteStats = self.viteDevServer?.stats || null;
      const cirrusRealRunning = !!self.cirrusReal?.isRunning;
      const viteStats = cirrusRealRunning
        ? {
            running: true,
            root: legacyViteStats?.root ?? 'home/user/app',
            backend: 'real' as const,
          }
        : legacyViteStats;
      const wranglerStats = self.nimbusWrangler?.stats || null;
      const portStats = self.portRegistry.stats;
      // Audit C3: same-origin only. The UI shell at /s/<id>/ polls this
      // from its own origin; no cross-origin reader is intended. If
      // future embeds need cross-origin reads, add an explicit origin
      // allowlist — not a wildcard.
      return Response.json({ ...vfsStats, processes: processStats, logStore: logStoreStats, ports: portStats, vite: viteStats, wrangler: wranglerStats });
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
        const body = await request.json() as any;
        const path = String(body.path).replace(/^\/+/, '');
        // Ensure parent dirs
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) {
          const dir = parts.slice(0, i).join('/');
          if (dir && !self.sqliteFs!.exists(dir)) self.sqliteFs!.mkdir(dir, { recursive: true });
        }
        self.sqliteFs!.writeFile(path, String(body.content));
        return Response.json({ ok: true, path });
      } catch (e: any) {
        return Response.json({ error: e?.message }, { status: 400 });
      }
    }

    if (url.pathname === '/api/mkdir' && request.method === 'POST') {
      self.ensureSqliteFs();
      try {
        const body = await request.json() as any;
        const path = String(body.path).replace(/^\/+/, '');
        self.sqliteFs!.mkdir(path, { recursive: true });
        return Response.json({ ok: true, path });
      } catch (e: any) {
        return Response.json({ error: e?.message }, { status: 400 });
      }
    }

    // ── Start vite via HTTP API (survives WS disconnects) ──
    if (url.pathname === '/api/start-vite' && request.method === 'POST') {
      self.ensureSqliteFs();
      try {
        const body = await request.json() as any;
        const root = String(body.root || 'home/user').replace(/^\/+/, '');

        // Stop existing server
        if (self.viteDevServer?.isRunning) self.viteDevServer.stop();

        // Start in-process ViteDevServer
        if (!self.esbuildService) self.esbuildService = new EsbuildService(self.sqliteFs!);
        const basePath = self.viteBasePath;
        self.viteDevServer = new ViteDevServer({
          vfs: self.sqliteFs!, esbuild: self.esbuildService!, root,
          aliases: body.aliases, define: body.define,
          onHmrMessage: () => {},
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
        });
        self.viteDevServer.start();

        // Persist so vite survives DO hibernation. basePath included so the
        // rehydrated server after DO sleep emits URLs under the same prefix
        // even before the next forwarded request updates sessionBasePath.
        await self.ctx.storage.put('vite-config', { root, aliases: body.aliases, define: body.define, injectBasename: body.injectBasename, basePath });

        return Response.json({ ok: true, root, running: true });
      } catch (e: any) {
        return Response.json({ error: e?.message }, { status: 400 });
      }
    }

    // ── Supervisor RPC: facets call back for stdout/stderr/VFS ──
    // Audit C3: mutation endpoint. Same-origin only — a facet that
    // needs to reach the supervisor goes through ctx.exports RPC
    // (loopback, not HTTP), and there is no user-facing cross-origin
    // use case.
    if (url.pathname === '/api/supervisor-rpc' && request.method === 'POST') {
      self.ensureSqliteFs();
      return handleSupervisorRpc(request, {
        vfs: self.sqliteFs!,
        processTable: self.processTable,
        portRegistry: self.portRegistry,
        terminal: self.terminal,
        processLogs: self.processLogs,
      });
    }

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
      } catch { /* non-fatal */ }

      // ── Real-vite takes precedence if running ───────────────────────
      // Cirrus shim and real-vite are mutually exclusive per session.
      // cirrusReal is checked first since users explicitly opted in via
      // NIMBUS_REAL_VITE=1 or `nimbusDevServer: 'real'`.
      if (self.cirrusReal?.isRunning) {
        const previewPath = (url.pathname.replace(/^\/preview/, '') || '/') + url.search;

        // Phase 2: HMR WebSocket upgrade. Vite's @vite/client opens a
        // WS against `<base>/__nimbus_hmr` (our custom HMR path). We
        // accept it here and plug it into cirrusReal.hmr so the facet's
        // ws-shim sees a 'connection' event on its next long-poll.
        // Non-hibernatable (server.accept, not ctx.acceptWebSocket) —
        // clients auto-reconnect on DO wake.
        if (previewPath.startsWith('/__nimbus_hmr') || previewPath === '/__nimbus_hmr') {
          if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('Expected WebSocket', { status: 426 });
          }
          const pair = new WebSocketPair();
          const [client, server] = Object.values(pair);
          // Use ctx.acceptWebSocket (hibernatable) — required because
          // HMR sends messages from a DIFFERENT request context (the
          // facet's long-poll RPC). workerd forbids cross-request I/O
          // on server.accept()'d sockets.
          self.ctx.acceptWebSocket(server, ['cirrus-hmr']);
          const clientId = self.cirrusReal.attachHmrClient(server);
          (server as any).serializeAttachment?.({ kind: 'cirrus-hmr', clientId });
          const hmrClients = (self._cirrusHmrWsClients ||= new Map());
          hmrClients.set(server, clientId);
          // Echo the vite-hmr subprotocol.
          const wantedProto = request.headers.get('Sec-WebSocket-Protocol') || '';
          const useProto = wantedProto.split(',').map(s => s.trim()).find(p => p === 'vite-hmr' || p === 'vite-ping');
          const respHeaders: Record<string, string> = {};
          if (useProto) respHeaders['Sec-WebSocket-Protocol'] = useProto;
          return new Response(null, { status: 101, webSocket: client, headers: respHeaders });
        }

        return self.cirrusReal.handleRequest(request, previewPath);
      }

      // Lazy-init: if DO hibernated and ViteDevServer was GC'd, reconstruct from saved config
      if (!self.viteDevServer || !self.viteDevServer.isRunning) {
        try {
          const config = await self.ctx.storage.get('vite-config') as any;
          if (config?.root) {
            self.ensureSqliteFs();
            if (!self.esbuildService) self.esbuildService = new EsbuildService(self.sqliteFs!);
            // Prefer the current request's basePath (just captured from the
            // X-Nimbus-Base header) over the stored one — the latter is only
            // a fallback for cold rehydrates that precede any header hit.
            const basePath = self.viteBasePath || config.basePath;
            self.viteDevServer = new ViteDevServer({
              vfs: self.sqliteFs!, esbuild: self.esbuildService!, root: config.root,
              aliases: config.aliases, define: config.define,
              onHmrMessage: () => {},
              sql: self.ctx.storage.sql,
              injectBasename: config.injectBasename,
              basePath,
              env: self.env,
              ctx: self.ctx,
            });
            self.viteDevServer.start();
          }
        } catch { /* lazy-init failed, fall through to "no server" response */ }
      }
      if (self.viteDevServer?.isRunning) {
        const previewPath = (url.pathname.replace(/^\/preview/, '') || '/') + url.search;
        return self.viteDevServer.handleRequest(request, previewPath);
      }
      // Polished placeholder — auto-reloads when vite starts.
      // Checks the VFS for the starter app so we can offer a context-aware hint.
      const hasSeed = (() => {
        try {
          return self.sqliteFs!.exists('home/user/app') &&
                 self.sqliteFs!.exists('home/user/app/package.json');
        } catch { return false; }
      })();
      const hint = hasSeed
        ? 'cd app &amp;&amp; npm install &amp;&amp; npm run dev'
        : 'vite';
      // The placeholder JS polls the session's /api/stats. If this DO was
      // reached directly (no session prefix), fall back to a relative path.
      const statsUrl = (self.sessionBasePath || '') + '/api/stats';
      return new Response(
        renderNoDevServerHtml({ hint, polled: statsUrl, liveKey: 'vite' }),
        // Audit C3: HTML served same-origin to the session shell.
        // No wildcard ACAO — the page's own fetch to /api/stats is
        // same-origin and needs no CORS header.
        { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
      );
    }

    // ── Worker route: serves the nimbus-wrangler dev worker output ──
    if (url.pathname.startsWith('/worker/') || url.pathname === '/worker') {
      if (!self.nimbusWrangler?.isRunning) {
        // Mirror the polished /preview/ placeholder — auto-reloads when
        // nimbus-wrangler starts. The placeholder references BOTH command
        // names so users coming from either `wrangler dev` or
        // `nimbus-wrangler dev` see a familiar hint.
        const hasWranglerConfig = (() => {
          try {
            self.ensureSqliteFs();
            return self.sqliteFs!.exists('home/user/wrangler.jsonc') ||
                   self.sqliteFs!.exists('home/user/wrangler.json') ||
                   self.sqliteFs!.exists('home/user/wrangler.toml');
          } catch { return false; }
        })();
        const hint = hasWranglerConfig
          ? 'npm run dev'
          : 'wrangler dev';
        return new Response(
          renderNoDevServerHtml({ hint, polled: (self.sessionBasePath || '') + '/api/stats', liveKey: 'wrangler' }),
          // Audit C3: same-origin HTML, no ACAO needed (see /preview/).
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
        );
      }
      const workerPath = url.pathname.replace(/^\/worker/, '') || '/';
      // Full outer-facing prefix for the proxy (e.g.
      // "/s/nimble-otter-4271/worker"). The proxy uses this to rewrite
      // Location headers emitted by the inner Worker so cross-redirects
      // (POST /new → /s/<inner>/) land back on the correctly-prefixed
      // outer URL rather than a bare /s/<inner>/ path that would spawn
      // a different outer session.
      const outerWorkerBase = (self.sessionBasePath || '') + '/worker';
      return self.nimbusWrangler.handleRequest(request, workerPath, outerWorkerBase);
    }

    // ── Port route: routes to facet HTTP servers ──
    // Audit F3 (STABILITY-AUDIT.md C-S3): routeRequest now always
    // returns a Response — 501 when no facet has a stub registered
    // (the normal case today, since the facet-side producer was
    // never wired), or a real proxied response once wiring lands.
    // The post-routeRequest null-branch + 502 fallback below is kept
    // defensively for any future refactor that returns null for a
    // different error condition.
    const portMatch = url.pathname.match(/^\/port\/(\d+)(\/.*)?$/);
    if (portMatch) {
      const port = parseInt(portMatch[1]);
      const path = portMatch[2] || '/';
      const result = await self.portRegistry.routeRequest(port, request, path);
      if (result) return result;
      return new Response(`No process listening on port ${port}`, {
        status: 502,
      });
    }

    return new Response('Not found', { status: 404 });
}
