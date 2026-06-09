/**
 * process-logs-api.ts - WebSocket surface for process terminal tabs.
 *
 * The server-to-client stream starts with a bounded backlog, then sends live
 * stdout/stderr chunks and exit/notfound events. The client-to-server stream
 * carries terminal input, stdin close, resize, and signal frames.
 *
 * Client → server:
 *   { type: 'input', data }       — write stdin to an attached process
 *   { type: 'stdin-end' }         — close stdin for an attached process
 *   { type: 'resize', columns, rows }
 *   { type: 'signal', signal }
 *
 * The ring buffer keeps state for 10 min post-exit so a tab that's still
 * open after a crash continues to show the final output.
 */
import type { ProcessLogStore } from './process-logs.js';
import type { ProcessTable } from './process-table.js';
import type { ProcessInputStore } from './process-input.js';
/**
 * Parameters for `handleLogsWebSocketRequest`. We accept the process
 * table so the handler can distinguish "brand-new pid, not yet written
 * to" from "pid never existed". The former is common — a client that
 * opens a process terminal immediately on the `{type:'spawn'}` frame
 * races with the first `_rpcStdout` RPC call and would otherwise get
 * `notfound`.
 */
export interface LogsWebSocketDeps {
    processLogs: ProcessLogStore;
    processTable: ProcessTable;
    processInput?: ProcessInputStore | null;
    /**
     * Durable Object state used for hibernatable process-terminal sockets.
     * Process log sockets must use `ctx.acceptWebSocket` so hibernation,
     * attachment dispatch, and session teardown all share one lifecycle.
     */
    ctx: {
        acceptWebSocket(ws: WebSocket, tags?: string[]): void;
    };
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