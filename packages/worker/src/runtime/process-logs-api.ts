/**
 * process-logs-api.ts — HTTP/WS surface for the per-PID process log store.
 *
 * Extracted from nimbus-session.ts so this file owns every byte of the
 * log-tabs feature (WS handler, processes list, terminal event helper).
 * nimbus-session.ts only calls these at 4 small hook sites:
 *   - onSpawn (notify)
 *   - _rpcReportExit / _reportExternalExit / shellExecuteTracked finally (notify)
 *   - Two route branches in _handleFetch (serve)
 *
 * The WebSocket protocol (server → client):
 *   { type: 'backlog', pid, chunks: [{ stream, data, ts, binary? }] }  — once on open
 *   { type: 'chunk', stream, data, ts, binary? }                       — per append
 *   { type: 'exit', code, at, reason? }                                — on exit
 *   { type: 'notfound', pid }                                          — pid unknown; socket closes
 *
 * Client → server: ignored. Clients are output-only; close the socket to
 * unsubscribe. The ring buffer keeps state for 10 min post-exit so a tab
 * that's still open after a crash continues to show the final output.
 *
 * W9 (CF research §C.2, Lever 11): the WS now uses `ctx.acceptWebSocket`
 * (hibernatable) when a `ctx` is provided. Why the switch:
 *   - The pre-W9 `server.accept()` call pinned the actor for the full
 *     duration of the log tail. A user opening a long-running log tab
 *     and walking away kept the DO awake — accumulating co-residency-
 *     OOM risk per Section A.1 of the research doc.
 *   - With hibernatable WS, the actor sleeps when nothing else holds it.
 *     The `pid` is captured in the serialized attachment so a wake-up
 *     dispatch can re-resolve. Subscribers are NOT preserved across
 *     hibernation (per the STOR Primer: "Does not survive: All JS
 *     in-memory state"), but the client typically reconnects via a
 *     fresh WS open which triggers a new backlog frame from the now-
 *     hydrated ring (W9 hib-persist) — equivalent UX, fewer wakes.
 *   - Falls back to `server.accept()` when `ctx` is omitted (legacy
 *     callers / unit tests without a DurableObjectState).
 */

import type { ProcessLogStore, LogChunk } from './process-logs.js';
import type { ProcessTable } from './process-table.js';

/**
 * Parameters for `handleLogsWebSocketRequest`. We accept the process
 * table so the handler can distinguish "brand-new pid, not yet written
 * to" from "pid never existed". The former is common — a client that
 * opens a log WS immediately on the `{type:'spawn'}` frame races with
 * the first `_rpcStdout` RPC call and would otherwise get `notfound`.
 */
export interface LogsWebSocketDeps {
  processLogs: ProcessLogStore;
  processTable: ProcessTable;
  /**
   * W9: optional `DurableObjectState`. When provided, the upgrade uses
   * `ctx.acceptWebSocket` (hibernatable) and serializes a process-logs
   * attachment so post-hibernate dispatches can resolve the pid. When
   * omitted, falls back to `server.accept()` (non-hibernatable; pre-W9
   * behaviour, kept for unit tests).
   */
  ctx?: { acceptWebSocket(ws: WebSocket, tags?: string[]): void } | null;
}

/**
 * Minimum interface this module needs from the terminal. The real type
 * is WebSocketTerminal but typing by shape avoids a cross-file import
 * cycle and lets tests pass a plain stub.
 */
export interface TerminalLike {
  ws: WebSocket;
}

/**
 * Send a structured JSON event to the main terminal WebSocket, if one is
 * attached. Used for out-of-band process lifecycle notifications
 * (`spawn`, `exit`) that the UI's tabs panel listens for — so it can
 * auto-open a log tab when a long-running process starts and stamp an
 * exit banner when it finishes.
 *
 * Unlike WebSocketTerminal.write (which buffers + emits `{type:'output'}`
 * after a 5 ms flush), this bypasses the buffer so spawn/exit events
 * arrive immediately — the UI's tab auto-open feels snappier, and a
 * crash-and-exit race can't drop the spawn frame.
 */
export function notifyTerminalEvent(
  terminal: TerminalLike | null,
  event: Record<string, unknown>,
): void {
  if (!terminal) return;
  try {
    terminal.ws.send(JSON.stringify(event));
  } catch {
    /* socket closed or congested — dropping is the right behavior here */
  }
}

/**
 * Handle an incoming `/api/logs/<pid>` upgrade request. On success
 * returns the 101 Response; caller forwards it unchanged. Subscribes
 * to the ring buffer and streams until the client (or we) closes.
 *
 * Guarantees:
 *   - Backlog frame is always sent first if the pid exists, even if
 *     the buffer is empty (so clients can render "empty but attached").
 *   - If the process already exited, an `exit` frame is included in
 *     the handshake so UIs don't need to wait for a live event.
 *   - Subscribers are torn down on close OR error — no leaks if the
 *     client disconnects abruptly.
 */
export function handleLogsWebSocketRequest(
  request: Request,
  pid: number,
  deps: LogsWebSocketDeps,
): Response {
  const { processLogs, processTable, ctx } = deps;
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 });
  }
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  // W9: prefer hibernatable WS so an idle log-tail tab doesn't pin the
  // actor. Fallback to server.accept when ctx is absent (e.g., unit
  // tests). Either way, tag the socket with `{kind:'process-logs', pid}`
  // so the close handler can discriminate.
  if (ctx && typeof ctx.acceptWebSocket === 'function') {
    try {
      ctx.acceptWebSocket(server, ['process-logs']);
      try {
        (server as any).serializeAttachment?.({ kind: 'process-logs', pid });
      } catch { /* attachment is best-effort */ }
    } catch (e: any) {
      // If acceptWebSocket throws (e.g., older runtime), fall back.
      console.warn('[nimbus/W9] ctx.acceptWebSocket failed; falling back:', e?.message);
      server.accept();
    }
  } else {
    server.accept();
  }

  // A pid is "truly unknown" only if neither the log store nor the
  // process table has ever heard of it. The log store lags slightly
  // behind the process table — facet stdout/stderr arrives via async
  // RPC, so a log WS opened the instant the {spawn} event fires will
  // usually see `processLogs.has(pid)===false` even though the pid is
  // perfectly valid and about to start producing output.
  //
  // Subscribing in that window is safe: `subscribe` creates state via
  // _getOrCreate, so when the first chunk arrives we fan it out to
  // this client too. The only downside is a client that opens a log
  // WS for a typo'd pid gets an empty live stream instead of an
  // immediate error — acceptable tradeoff for removing the racy
  // "no log buffer for pid N" banner users saw on EVERY short-lived
  // process.
  const pidKnown = processLogs.has(pid) || !!processTable.get(pid);
  if (!pidKnown) {
    try { server.send(JSON.stringify({ type: 'notfound', pid })); } catch {}
    try { server.close(1000, 'unknown pid'); } catch {}
    return new Response(null, { status: 101, webSocket: client });
  }

  // 1. Backlog — one frame, so the client has a snapshot before any
  //    live chunks arrive. Bounded by the ring's 64 KB cap.
  const chunks = processLogs.all(pid).map((c: LogChunk) => ({
    stream: c.stream,
    data: c.data,
    ts: c.ts,
    binary: c.binary,
  }));
  try {
    server.send(JSON.stringify({ type: 'backlog', pid, chunks }));
  } catch { /* socket died during handshake — fall through, cleanup below */ }

  // 2. If the process already exited, tell the client now. Idempotent
  //    with the subscribeExit callback below (client tolerates duplicates).
  const existingExit = processLogs.getExit(pid);
  if (existingExit) {
    try {
      server.send(JSON.stringify({
        type: 'exit',
        code: existingExit.code,
        at: existingExit.at,
        reason: existingExit.reason,
      }));
    } catch {}
  }

  // 3. Live stream. `subscribe` fires synchronously from append — no
  //    buffering fights with WebSocketTerminal's 5 ms flush timer.
  let unsubChunk: (() => void) | null = null;
  let unsubExit: (() => void) | null = null;
  const cleanup = () => {
    try { unsubChunk?.(); } catch {}
    try { unsubExit?.(); } catch {}
    unsubChunk = null;
    unsubExit = null;
  };

  unsubChunk = processLogs.subscribe(pid, (c) => {
    try {
      server.send(JSON.stringify({
        type: 'chunk',
        stream: c.stream,
        data: c.data,
        ts: c.ts,
        binary: c.binary,
      }));
    } catch {
      // Socket is dead — cleanup so the subscriber set doesn't leak.
      cleanup();
    }
  });
  unsubExit = processLogs.subscribeExit(pid, (e) => {
    try {
      server.send(JSON.stringify({
        type: 'exit',
        code: e.code,
        at: e.at,
        reason: e.reason,
      }));
    } catch {}
  });

  server.addEventListener('close', cleanup);
  server.addEventListener('error', cleanup);

  return new Response(null, { status: 101, webSocket: client });
}

/**
 * GET /api/processes — lightweight listing for the tabs UI's hydrate-
 * on-refresh path. Returns every process the DO currently knows about
 * (running + recently exited, bounded by the ring buffer's 10 min
 * post-exit retention).
 *
 * The `longRunning` flag is derived from the command string so the
 * client can filter to "likely user-visible dev servers" without
 * needing ProcessTable to expose the FacetManager/Shell-level spawn
 * options (which it doesn't — the `longRunning` decision is made by
 * FacetManager for facets and by shellExecuteTracked opts for scripts).
 * A regex match is good enough because false positives cost nothing
 * (they just show an extra tab the user can close).
 */
const LONG_RUNNING_CMD_RE =
  /^(vite|wrangler|next|nuxt|astro|remix|dev|serve|start|watch|npm\s+run\s+dev)\b/;

export function handleProcessesListRequest(
  processTable: ProcessTable,
  processLogs: ProcessLogStore,
): Response {
  const processes: Array<{
    pid: number;
    command: string;
    state: string;
    exitCode: number | null;
    longRunning: boolean;
    hasLogs: boolean;
    logBytes: number;
    startTime: number;
  }> = [];

  for (const p of processTable.getAll()) {
    const snap = processLogs.snapshot(p.pid);
    processes.push({
      pid: p.pid,
      command: p.command,
      state: p.state,
      exitCode: p.exitCode,
      // arch-gaps gap #2: prefer the explicit longRunning flag set by
      // FacetManager.spawn; fall back to the command-string heuristic
      // for legacy entries that didn't go through that primitive.
      longRunning: p.longRunning === true || LONG_RUNNING_CMD_RE.test(p.command),
      hasLogs: !!snap && snap.chunks > 0,
      logBytes: snap?.bytes ?? 0,
      startTime: p.startTime,
    });
  }

  // Reaped processes with lingering log buffers (exited >60s ago, not
  // yet past the 10 min retention) are intentionally NOT listed here —
  // the ProcessTable has already purged them and ProcessLogStore has no
  // key-iteration API. Users can still access those logs via the `logs
  // <pid>` shell command, which reads directly from ProcessLogStore.
  // Audit C3: same-origin only. The session shell at /s/<id>/ polls
  // this from its own origin; no cross-origin reader is intended.
  return Response.json({ processes }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

/**
 * Utility: does this pathname match `/api/logs/<pid>`? Returns the pid
 * or null. Kept alongside the handler so the routing regex lives in
 * exactly one place.
 */
export function matchLogsPath(pathname: string): number | null {
  const m = pathname.match(/^\/api\/logs\/(\d+)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
