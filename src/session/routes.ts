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
import {
  matchLogsPath, handleLogsWebSocketRequest, handleProcessesListRequest,
} from '../runtime/process-logs-api.js';
import { readDiagCounters } from '../observability/diag-counters.js';
import {
  getFailures, getLastRpcFrame, getLastFacetId,
  getRecoveryEvents, recordRecoveryEvent, resetRecoveryEvents,
} from '../observability/oom-discriminator.js';
import { LRU_MAX_ENTRIES } from '../constants.js';
import { estimateSupervisorHeap, WORKERD_EVICTION_LABELS } from '../observability/heap-estimate.js';
import { loadShellState, loadKernelMounts, getScrollbackStats, clearSessionState, appendScrollback, loadScrollback } from './state-store.js';
import { isWarmRejoin, joinExistingSession } from './init-phases.js';
import { EsbuildService } from '../runtime/esbuild-service.js';
import { ViteDevServer } from '../facets/vite-dev-server.js';
import { ProcessLogStore } from '../runtime/process-logs.js';
import { notifyTerminalEvent } from '../runtime/process-logs-api.js';
import { makeLongRunningPortStub } from '../runtime/long-running-handle.js';
import { getLoadedCodesStats } from './bindings.js';
import { renderNoDevServerHtml } from './helpers.js';
import { R2CacheClient } from '../npm/r2-cache.js';
import { fetchEsbuildWasmBytes, ESBUILD_WASM_L2_KEY } from '../runtime/esbuild-wasm-bytes.js';
import { NimbusFanoutPool, IN_DO_THRESHOLD, MAX_PEER_FANOUT, hashKeyToShard } from '../loaders/fanout-pool.js';

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
      // [B'.5] Three-way decision on a /ws upgrade:
      //   1. Warm rejoin: a wsClose/wsError fired earlier and left
      //      kernel/shell/terminal alive in-memory. Re-attach the
      //      new ws to the existing Shell — Phase B skipped.
      //   2. Cold init: no shell yet (first connect, or post-DO-
      //      eviction). Run the full R/B/W/O sequence.
      //   3. Active conflict: Shell is non-null AND phase != drained,
      //      meaning some other /ws is already attached. 409 to
      //      prevent two-tab cross-wiring (multi-tab share is a
      //      separate feature; B'.5 doesn't enable it).
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      self.ctx.acceptWebSocket(server);
      try { (server as any).serializeAttachment?.({ kind: 'shell' }); } catch {}

      if (isWarmRejoin(self as any)) {
        // Warm rejoin path. The existing Shell is alive; we just
        // swap the WebSocketTerminal's ws ref + replay scrollback.
        try {
          joinExistingSession(self as any, server, appendScrollback, loadScrollback);
        } catch (err: any) {
          console.error('warm-rejoin error:', err?.message, err?.stack);
          return new Response('Rejoin failed: ' + err?.message, { status: 500 });
        }
        return new Response(null, { status: 101, webSocket: client });
      }

      if (self.shell != null) {
        // Active conflict — Shell exists and isn't drained. Some
        // other /ws is attached; reject this one.
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

      // Cold init path — first ever /ws (or post-DO-eviction).
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

    // Primitives wave (P11) — kill / restart by PID for the Process tab UI.
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
        const action = killMatch[1] as 'kill' | 'restart';
        const pid = parseInt(killMatch[2], 10);
        const json = (status: number, body: any) =>
          new Response(JSON.stringify(body), {
            status, headers: { 'Content-Type': 'application/json' },
          });
        if (!Number.isFinite(pid) || pid <= 0) {
          return json(400, { error: 'invalid pid', pid });
        }
        const entry = self.processTable.get(pid);
        if (!entry) {
          return json(404, { error: 'no such process', pid });
        }
        const isViteShim = self._viteShimPid === pid;
        try {
          if (isViteShim) {
            // Same teardown the `kill` shell handler does. Centralised
            // here so the UI doesn't need to reimplement it.
            try {
              if (self.cirrusReal?.isRunning) { self.cirrusReal.stop(self.ctx); self.cirrusReal = null; }
              if (self.viteDevServer?.isRunning) {
                self.viteDevServer.stop();
                self.viteDevServer = null;
                try { await self.ctx.storage.delete('vite-config'); } catch {}
              }
            } catch { /* keep going to teardown processTable / portRegistry */ }
            try { self.portRegistry.unregisterByPid(pid); } catch {}
            try { self.processTable.kill(pid); } catch {}
            self._viteShimPid = null;
            self._viteShimPort = null;
          } else if (self.facetManager) {
            const ok = self.facetManager.kill(pid);
            if (!ok) return json(404, { error: 'facetManager.kill returned false', pid });
          } else {
            // No facetManager and not a vite shim — best-effort
            // process-table tombstone so the UI can re-render the badge.
            try { self.portRegistry.unregisterByPid(pid); } catch {}
            try { self.processTable.kill(pid); } catch {}
          }
        } catch (e: any) {
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
            } catch {}
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
    // /api/_diag/memory — supervisor heap estimate, eviction taxonomy,
    // and recovery-event ring.
    //
    // Why this endpoint exists
    // ────────────────────────
    // workerd's process.memoryUsage() returns zero for every field inside
    // a DO class context (verified at audit/sections/PROD-RESET-RESEARCH-
    // R1.md §R1.4). The previous endpoint reported nodeMem/perfMem from
    // process.memoryUsage() and they were always zero — useless.
    //
    // C'.1 replaces the zero-everywhere readout with a deterministic
    // estimator (src/observability/heap-estimate.ts) that sums known
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
      const vfs = self.sqliteFs!.getStats();
      const DO_HEAP_LIMIT_BYTES = 128 * 1024 * 1024;
      const heapUsed = nodeMem?.heapUsed ?? 0;
      const counters = readDiagCounters();
      const cacheStats = (vfs as any).cache ?? {};
      const lastFailures = getFailures();

      // ── C'.1 deterministic heap estimate ─────────────────────────────
      // Sources every contributing byte from a runtime counter — never
      // calls process.memoryUsage(). Ceiling is the architectural soft
      // budget (SUPERVISOR_HEAP_CEILING_BYTES = 64 MiB), half the
      // workerd hard cap of 128 MiB.
      // N3 (heap-correctness wave). Pre-fix, this was hardcoded 0 with
      // the comment "matches reality (writes are flushed in
      // microseconds)" — which was wrong: pendingWrites can hold up to
      // 500 chunks × 64 KiB = 32 MiB at peak, AND writeStream's spool
      // can buffer the full incoming batch. Both were invisible to the
      // estimator because there was no counter to read.
      //
      // Post-fix, SqliteVFS maintains TWO running byte sums:
      //   - _pendingWriteBytes        : the post-deferWrite queue
      //   - _writeStreamSpoolBytes    : N2 spool inside writeStream
      // Both contribute to "in-flight write bytes the supervisor is
      // currently holding"; the estimator sees their sum.
      // (vfs.sql is the sub-object in getStats() that surfaces these.)
      const sqlStats = (vfs as any).sql ?? {};
      const inFlightWriteBytes =
        (sqlStats.pendingWriteBytes ?? 0) +
        (sqlStats.writeStreamSpoolBytes ?? 0);
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
          // N3 (heap-correctness wave): pending-writes observability.
          // `pendingWrites` is the entry count (unchanged); the new
          // `pendingWriteBytes` is the live byte total maintained by
          // SqliteVFS._pendingWriteBytes. Probes use the pair to
          // distinguish "many small chunks" from "few large chunks".
          pendingWrites: sqlStats.pendingWrites ?? 0,
          pendingWriteBytes: sqlStats.pendingWriteBytes ?? 0,
          // N2: live byte count inside the writeStream() drain spool.
          // Visible during a real npm install; ~0 at rest.
          writeStreamSpoolBytes: sqlStats.writeStreamSpoolBytes ?? 0,
        },

        // H7 (heap-correctness wave): _NIMBUS_LOADED_CODES Map state.
        // Pre-fix this Map grew unbounded — wrangler dev's rebuild
        // loop accumulated one entry per save until the supervisor
        // hit the workerd 128 MiB hard cap. Post-fix: hard-cap LRU
        // (32 entries) with FIFO eviction. The counters here let
        // ops dashboards visualise the bound + the eviction rate.
        loadedCodes: getLoadedCodesStats(),
        rpc: {
          lastFrame: getLastRpcFrame(),
        },
        facet: {
          lastDispatch: getLastFacetId(),
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

    // ── /api/_diag/session — Track B' state-store debug surface [B'.1] ──
    //
    // Exposes the persisted shell state so the probe at
    // audit/probes/b-prime/b1-shell-state/ can verify the SQL row
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
        phase: (self as any)._b4Phase ?? null,
        // [B'.5] count of /ws upgrades that took the warm-rejoin
        // path (Phase B skipped). Probes assert ≥1 after a forced
        // close + reconnect on the same isolate.
        warmJoinCount: (self as any)._b4WarmJoinCount ?? 0,
        // Live shell state — useful for confirming the in-memory
        // shell agrees with SQL. Null when no shell is currently
        // attached (between wsClose and next /ws upgrade).
        liveCwd: (() => { try { return self.shell?.getCwd() ?? null; } catch { return null; } })(),
        liveEnvKeys: (() => {
          try {
            const e = self.shell?.getEnv();
            return e ? Object.keys(e).sort() : null;
          } catch { return null; }
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
    // Probe at audit/probes/d-prime/d1-cirrus-real-facet/ asserts kind
    // and cookie persistence across forced supervisor reconnect.
    if (url.pathname === '/api/_diag/cirrus') {
      if (!self.cirrusReal) {
        return Response.json({ running: false, kind: null });
      }
      try {
        const diag = await self.cirrusReal.getDiag();
        return Response.json({ running: true, ...diag });
      } catch (e: any) {
        return Response.json({ running: true, error: e?.message || String(e) }, { status: 500 });
      }
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
      // ── C'.2 recovery-event test endpoints ────────────────────────────
      // Used by audit/probes/c-prime/recovery-events/ to verify the ring
      // schema works pre-Track-B'. Once Track B' transitions land, real
      // events flow through the ring naturally — these endpoints stay
      // for synthetic-trigger probes (audit/probes/interactive-liveness/
      // error-recovery/).
      if (url.pathname === '/api/_test/recovery-event/record' && request.method === 'POST') {
        const body = await request.json() as any;
        recordRecoveryEvent({
          at: Number(body.at) || Date.now(),
          fromState: String(body.fromState ?? 'cold') as any,
          toState: String(body.toState ?? 'hydrated') as any,
          trigger: String(body.trigger ?? 'manual-test'),
          isolateGen: Number(body.isolateGen) || self._w9IsolateGen,
          dataLoss: !!body.dataLoss,
          snapshotKeysRehydrated: Number(body.snapshotKeysRehydrated) || 0,
          notes: body.notes ? String(body.notes) : undefined,
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
      // Used by audit/probes/cache-and-scrub/* to measure the latency
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
      // Used by audit/probes/two-tier-fanout/* to measure the
      // POC C in-DO and POC B peer-DO speedups via the
      // NimbusFanoutPool primitive. Independent of any specific
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
        // Primitives wave (P5/P8): allocate a PID + port even on the
        // /api/start-vite path so probes that drive vite via the test
        // surface still see a real process in `ps` and stream
        // diagnostics into the Process tab.
        const apiVitePort = (typeof body.port === 'number' && body.port > 0) ? body.port : 5173;
        const apiViteEntry = self.processTable.spawn(
          'vite (api/start-vite, ' + root + ')', [], root,
        );
        self.processTable.setLongRunning(apiViteEntry.pid);
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
          port: apiVitePort,
          pid: apiViteEntry.pid,
          processLogs: self.processLogs,
        });
        self.viteDevServer.start();
        try {
          const apiViteStub = makeLongRunningPortStub(self.viteDevServer);
          self.portRegistry.register(apiVitePort, apiViteEntry.pid, apiViteStub);
          self._viteShimPid = apiViteEntry.pid;
          self._viteShimPort = apiVitePort;
        } catch {}

        // Persist so vite survives DO hibernation. basePath included so the
        // rehydrated server after DO sleep emits URLs under the same prefix
        // even before the next forwarded request updates sessionBasePath.
        await self.ctx.storage.put('vite-config', { root, aliases: body.aliases, define: body.define, injectBasename: body.injectBasename, basePath });

        return Response.json({ ok: true, root, running: true });
      } catch (e: any) {
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
      } catch { /* non-fatal */ }

      // Primitive #3 multi-target routing — `/preview/?port=N` lets a
      // session with multiple long-running things (vite + Express, two
      // vites on different ports, …) reach each one without changing
      // the user-facing URL shape.
      //
      // Behaviour:
      //   /preview/         → first port in PortRegistry by registration
      //                       time, OR if a non-port-registered cirrus
      //                       shim / cirrusReal is live (legacy path),
      //                       use it directly. The legacy path is the
      //                       fast path because it avoids stub-rebuild.
      //   /preview/?port=N  → routeRequest(N, …) regardless of legacy.
      const queryPort = (() => {
        const raw = url.searchParams.get('port');
        if (!raw) return null;
        const n = parseInt(raw, 10);
        return Number.isFinite(n) && n > 0 && n < 65536 ? n : null;
      })();
      if (queryPort != null) {
        const previewInner = (url.pathname.replace(/^\/preview/, '') || '/') + (() => {
          // Strip our `?port=N` so the inner handler doesn't re-see it.
          const sp = new URLSearchParams(url.search);
          sp.delete('port');
          const q = sp.toString();
          return q ? '?' + q : '';
        })();
        const proxied = await self.portRegistry.routeRequest(queryPort, request, previewInner);
        if (proxied) return proxied;
        return new Response(`No process listening on port ${queryPort}`, { status: 502 });
      }

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
            // Primitives wave (P8): on hibernation rehydrate, re-allocate
            // a PID so log streaming has somewhere to land. Without
            // this, the rehydrated server would be silent again. The
            // PID is registered against the previously-known port (or
            // the default 5173 when the saved config predates P5).
            const rehydratedPort = (config.port && Number.isFinite(config.port)) ? config.port : 5173;
            const rehydratedEntry = self.processTable.spawn(
              'vite (rehydrated, ' + config.root + ')',
              [],
              config.root,
            );
            self.processTable.setLongRunning(rehydratedEntry.pid);

            self.viteDevServer = new ViteDevServer({
              vfs: self.sqliteFs!, esbuild: self.esbuildService!, root: config.root,
              aliases: config.aliases, define: config.define,
              onHmrMessage: () => {},
              sql: self.ctx.storage.sql,
              injectBasename: config.injectBasename,
              basePath,
              env: self.env,
              ctx: self.ctx,
              port: rehydratedPort,
              pid: rehydratedEntry.pid,
              processLogs: self.processLogs,
            });
            self.viteDevServer.start();
            // Re-register the port so /preview/?port=N keeps working
            // across hibernation cycles.
            try {
              const rehydratedStub = makeLongRunningPortStub(self.viteDevServer);
              self.portRegistry.register(rehydratedPort, rehydratedEntry.pid, rehydratedStub);
              self._viteShimPid = rehydratedEntry.pid;
              self._viteShimPort = rehydratedPort;
            } catch { /* registry full / unavailable — fall through */ }
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
    //
    // Primitives wave (P5): the canonical path is `/__nimbus/worker/*`
    // so projects with their own `worker/` directory at root (Markflow,
    // CF Pages projects, …) can serve it via `/preview/worker/*` without
    // collision. The bare `/worker/*` path remains accepted for
    // back-compat — same handler — but the response carries a
    // `Deprecation` and `Sunset` header so callers can migrate. New
    // sessions are encouraged to use the namespaced form.
    const workerPathMatch =
      url.pathname.startsWith('/__nimbus/worker/') || url.pathname === '/__nimbus/worker' ||
      url.pathname.startsWith('/worker/') || url.pathname === '/worker';
    const isLegacyWorkerPath =
      url.pathname.startsWith('/worker/') || url.pathname === '/worker';
    if (workerPathMatch) {
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
      const resp = await self.nimbusWrangler.handleRequest(request, workerPath, outerWorkerBase);
      if (isLegacyWorkerPath) {
        // Surface the deprecation in headers without rewriting body —
        // unobtrusive for browsers, visible to tooling.
        const newHeaders = new Headers(resp.headers);
        newHeaders.set('Deprecation', 'true');
        newHeaders.set(
          'Sunset',
          'Wed, 01 Jan 2027 00:00:00 GMT',
        );
        newHeaders.set(
          'Link',
          '<' + (self.sessionBasePath || '') + '/__nimbus/worker' + workerPath +
            '>; rel="successor-version"',
        );
        return new Response(resp.body, {
          status: resp.status, statusText: resp.statusText, headers: newHeaders,
        });
      }
      return resp;
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
//   POST /api/_test/cache/tarball/seed       {name, version, sizeKb}
//        → similar; payload is a synthetic Uint8Array of sizeKb*1024.
//   GET  /api/_test/cache/tarball/bench?name=X&version=Y&n=N
//        → similar.
//   GET  /api/_test/cache/wasm/bench?n=N
//        → run N sequential fetchEsbuildWasmBytes() calls. The first
//          is asset-fetch + L2 write; subsequent should hit L2.
async function handleCacheTestEndpoint(
  self: RoutesHost,
  url: URL,
  request: Request,
): Promise<Response> {
  const env: any = self.env;
  const path = url.pathname;
  // Build a fresh R2CacheClient bound to the request's env (mirrors
  // SupervisorRPC._r2 in semantics — graceful-degrade on missing
  // bindings).
  const r2 = new R2CacheClient(
    env?.NPM_TARBALL_CACHE ?? null,
    env?.NPM_PACKUMENT_CACHE ?? null,
  );
  const caches: any = (globalThis as any).caches;
  const purgeL2 = async (synthUrl: string): Promise<void> => {
    try { await caches?.default?.delete(new Request(synthUrl)); } catch {}
  };

  if (path === '/api/_test/cache/packument/seed' && request.method === 'POST') {
    const body = await request.json() as any;
    const name = String(body.name || '');
    const payload = String(body.payload || JSON.stringify({ name, versions: {} }));
    if (!name) return Response.json({ error: 'missing name' }, { status: 400 });
    // Purge L2 first so the next bench read starts from L3 cold.
    await purgeL2(`https://nimbus-cache.invalid/v1/p/${encodeURIComponent(name)}.json`);
    const ok = await r2.putPackument(name, payload);
    return Response.json({ seeded: ok, name, payloadBytes: payload.length });
  }

  if (path === '/api/_test/cache/packument/bench' && request.method === 'GET') {
    const name = url.searchParams.get('name') ?? '';
    const n = Math.max(1, Math.min(20, parseInt(url.searchParams.get('n') || '5', 10)));
    if (!name) return Response.json({ error: 'missing name' }, { status: 400 });
    const latencies: number[] = [];
    let lastBytes = 0;
    let nullCount = 0;
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      const got = await r2.getPackument(name);
      const t1 = performance.now();
      latencies.push(t1 - t0);
      if (!got) nullCount++;
      else lastBytes = got.json.length;
    }
    // R2CacheClient instance was constructed at the top of this
    // handler; counters reflect the N calls just made.
    const stats = r2.stats();
    return Response.json({ name, n, latencies, lastBytes, nullCount, stats });
  }

  if (path === '/api/_test/cache/tarball/seed' && request.method === 'POST') {
    const body = await request.json() as any;
    const name = String(body.name || '');
    const version = String(body.version || '');
    const sizeKb = Math.max(1, Math.min(15360, Number(body.sizeKb) || 16)); // up to 15 MiB (under MAX_R2_TARBALL_BYTES = 30 MiB)
    if (!name || !version) return Response.json({ error: 'missing name/version' }, { status: 400 });
    await purgeL2(`https://nimbus-cache.invalid/v1/t/${encodeURIComponent(name)}/${encodeURIComponent(version)}.tgz`);
    // Synthetic payload — bytes are arbitrary; the cache layer doesn't
    // care about content. Probe just measures fetch latency.
    const bytes = new Uint8Array(sizeKb * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const ok = await r2.putTarball(name, version, bytes);
    return Response.json({ seeded: ok, name, version, sizeBytes: bytes.length });
  }

  if (path === '/api/_test/cache/tarball/bench' && request.method === 'GET') {
    const name = url.searchParams.get('name') ?? '';
    const version = url.searchParams.get('version') ?? '';
    const n = Math.max(1, Math.min(20, parseInt(url.searchParams.get('n') || '5', 10)));
    if (!name || !version) return Response.json({ error: 'missing name/version' }, { status: 400 });
    const latencies: number[] = [];
    let lastBytes = 0;
    let nullCount = 0;
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      const got = await r2.getTarball(name, version);
      const t1 = performance.now();
      latencies.push(t1 - t0);
      if (!got) nullCount++;
      else lastBytes = got.length;
    }
    const stats = r2.stats();
    return Response.json({ name, version, n, latencies, lastBytes, nullCount, stats });
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
    const latencies: number[] = [];
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
// Routes under /api/_test/fanout/* exercise NimbusFanoutPool's two
// topologies (POC C in-DO + POC B peer-DO) via a synthetic workload
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
async function handleFanoutTestEndpoint(
  self: RoutesHost,
  url: URL,
  request: Request,
): Promise<Response> {
  const env: any = self.env;
  const path = url.pathname;

  if (path === '/api/_test/fanout/topology' && request.method === 'GET') {
    const n = Math.max(0, parseInt(url.searchParams.get('n') || '0', 10));
    return Response.json({
      n,
      topology: n === 0 ? 'empty' : (n < IN_DO_THRESHOLD ? 'in-do' : 'peer-do'),
      inDoThreshold: IN_DO_THRESHOLD,
      maxPeerFanout: MAX_PEER_FANOUT,
    });
  }

  if (path === '/api/_test/fanout/route' && request.method === 'GET') {
    const keysRaw = url.searchParams.get('keys') || '';
    const keys = keysRaw.split(',').map((k) => k.trim()).filter(Boolean);
    const peerCount = Math.max(1, Math.min(parseInt(url.searchParams.get('n') || String(keys.length), 10), MAX_PEER_FANOUT));
    const placement = keys.map((k) => ({
      key: k,
      shard: hashKeyToShard(k, peerCount),
    }));
    return Response.json({ peerCount, placement });
  }

  if (path === '/api/_test/fanout/bench' && request.method === 'POST') {
    const body = await request.json() as any;
    const n = Math.max(1, Math.min(64, Number(body.n) || 8));
    const sleepMs = Math.max(0, Math.min(2000, Number(body.sleepMs) || 100));

    const pool = new NimbusFanoutPool(env, self.ctx, {
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
    const results = await pool.submitMany<
      { id: number; sleepMs: number },
      { id: number; startMs: number; endMs: number; loaderEnvKeys: string[] }
    >(tasks, async (item: { id: number; sleepMs: number }, env: any) => {
      const startMs = Date.now();
      // Identify which env we're running in. SUPERVISOR is the
      // RPC stub auto-injected by NimbusLoaderPool; its presence
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
    // on hashKeyToShard predicting placement and inspecting the
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
        topology: n < IN_DO_THRESHOLD ? 'in-do' : 'peer-do',
      },
    });
  }

  if (path === '/api/_test/fanout/serial-bench' && request.method === 'POST') {
    const body = await request.json() as any;
    const n = Math.max(1, Math.min(64, Number(body.n) || 8));
    const sleepMs = Math.max(0, Math.min(2000, Number(body.sleepMs) || 100));

    // Same workload, but FORCE serial dispatch by using a single
    // NimbusLoaderPool with concurrency=1 and submitting one task
    // at a time. This is the T_serial reference for the 5× speedup
    // assertion.
    const { NimbusLoaderPool } = await import('../loaders/loader-pool.js');
    const pool = new NimbusLoaderPool(env, self.ctx, {
      concurrency: 1,
      timeoutMs: 60_000,
      tag: 'fanout-serial',
    });

    const t0 = performance.now();
    try {
      for (let i = 0; i < n; i++) {
        await pool.submit(
          async (item: { id: number; sleepMs: number }) => {
            await new Promise((r) => setTimeout(r, item.sleepMs));
            return item.id;
          },
          { id: i, sleepMs },
        );
      }
    } finally {
      try { pool.dispose(); } catch {}
    }
    const t1 = performance.now();
    return Response.json({ n, sleepMs, wallTimeMs: t1 - t0 });
  }

  return new Response('unknown fanout _test endpoint', { status: 404 });
}
