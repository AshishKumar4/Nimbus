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
import type { ProcessLogStore } from './process-logs.js';
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
    ctx?: {
        acceptWebSocket(ws: WebSocket, tags?: string[]): void;
    } | null;
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
export declare function notifyTerminalEvent(terminal: TerminalLike | null, event: Record<string, unknown>): void;
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
export declare function handleLogsWebSocketRequest(request: Request, pid: number, deps: LogsWebSocketDeps): Response;
export declare function handleProcessesListRequest(processTable: ProcessTable, processLogs: ProcessLogStore): Response;
/**
 * Utility: does this pathname match `/api/logs/<pid>`? Returns the pid
 * or null. Kept alongside the handler so the routing regex lives in
 * exactly one place.
 */
export declare function matchLogsPath(pathname: string): number | null;
//# sourceMappingURL=process-logs-api.d.ts.map