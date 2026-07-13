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
export function notifyTerminalEvent(terminal, event) {
    if (!terminal)
        return;
    try {
        terminal.ws.send(JSON.stringify(event));
    }
    catch {
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
export function handleLogsWebSocketRequest(request, pid, deps) {
    const { processes, ctx } = deps;
    if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    ctx.acceptWebSocket(server, ['process-logs']);
    try {
        const serializeAttachment = Reflect.get(server, 'serializeAttachment');
        if (typeof serializeAttachment === 'function') {
            serializeAttachment.call(server, { kind: 'process-logs', pid });
        }
    }
    catch {
        try {
            server.close(1011, 'process log attachment failed');
        }
        catch { }
        return new Response('Nimbus process terminal attachment failed', { status: 500 });
    }
    // A pid is "truly unknown" only if neither the log store nor the
    // process table has ever heard of it. The log store lags slightly
    // behind the process table — facet stdout/stderr arrives via async
    // RPC, so a process terminal opened the instant the {spawn} event
    // fires will usually see `hasLogs(pid)===false` even though the pid is
    // perfectly valid and about to start producing output.
    //
    // Subscribing in that window is safe: `subscribeLogs` creates state,
    // so when the first chunk arrives we fan it out to this client too.
    // The only downside is a client that opens a log WS for a typo'd pid
    // gets an empty live stream instead of an immediate error —
    // acceptable tradeoff for removing the racy "no log buffer for pid N"
    // banner users saw on EVERY short-lived process.
    const pidKnown = processes.hasLogs(pid) || !!processes.get(pid);
    if (!pidKnown) {
        // Informational only — do NOT close. A pid can be legitimately
        // unknown to THIS instance: the spawn record is in-memory, so a DO
        // instance reset between the spawn and this connect loses it while
        // the process facet keeps running. The socket stays subscribed via
        // the attachment-driven broadcast below, so output flows the moment
        // the process writes. (A typo'd pid gets a silent open socket —
        // the same tradeoff the racy spawn-vs-first-write window already
        // chose.)
        try {
            server.send(JSON.stringify({ type: 'notfound', pid }));
        }
        catch { }
        return new Response(null, { status: 101, webSocket: client });
    }
    // 1. Backlog — one frame, so the client has a snapshot before any
    //    live chunks arrive. Bounded by the ring's 64 KB cap.
    const chunks = processes.allLogs(pid).map((c) => ({
        stream: c.stream,
        data: c.data,
        ts: c.ts,
        binary: c.binary,
    }));
    try {
        server.send(JSON.stringify({ type: 'backlog', pid, chunks }));
    }
    catch { /* socket died during handshake */ }
    // 2. If the process already exited, tell the client now. Idempotent
    //    with the exit broadcast (client tolerates duplicates).
    const existingExit = processes.getExit(pid);
    if (existingExit) {
        try {
            server.send(JSON.stringify({
                type: 'exit',
                code: existingExit.code,
                at: existingExit.at,
                reason: existingExit.reason,
            }));
        }
        catch { }
    }
    // 3. Live stream: no per-connection subscription. Chunks and exits
    //    reach this socket via the instance-level broadcast installed by
    //    wireProcessLogSocketBroadcast — routed by the serialized
    //    attachment, which (unlike a subscription closure) survives DO
    //    instance resets and hibernation. Client → server frames (input /
    //    resize / signal) are routed the same attachment-driven way by the
    //    class-level webSocketMessage handler (session/ws.ts).
    return new Response(null, { status: 101, webSocket: client });
}
/**
 * Install the instance-level fan-out from the process log store to every
 * accepted process-terminal WebSocket. Called once per DO instance (from
 * the NimbusSession constructor), so sockets accepted by a PREVIOUS
 * instance — which survive resets/hibernation via the hibernation API —
 * keep streaming after the in-memory world is rebuilt.
 */
export function wireProcessLogSocketBroadcast(processes, ctx) {
    if (typeof ctx.getWebSockets !== 'function')
        return;
    const attachedPid = new WeakMap();
    const socketsFor = (pid) => {
        let sockets = [];
        try {
            sockets = ctx.getWebSockets('process-logs');
        }
        catch {
            return [];
        }
        return sockets.filter((ws) => {
            const cached = attachedPid.get(ws);
            if (cached !== undefined)
                return cached === pid;
            let wsPid = -1;
            try {
                const deserialize = Reflect.get(ws, 'deserializeAttachment');
                const att = typeof deserialize === 'function' ? deserialize.call(ws) : null;
                if (att && typeof att.pid === 'number')
                    wsPid = att.pid;
            }
            catch { /* unreadable attachment — treat as unmatched */ }
            attachedPid.set(ws, wsPid);
            return wsPid === pid;
        });
    };
    processes.setLogBroadcast((pid, chunk) => {
        for (const ws of socketsFor(pid)) {
            try {
                ws.send(JSON.stringify({
                    type: 'chunk',
                    stream: chunk.stream,
                    data: chunk.data,
                    ts: chunk.ts,
                    binary: chunk.binary,
                }));
            }
            catch { /* socket closed — hibernation API reaps it */ }
        }
    }, (pid, exit) => {
        for (const ws of socketsFor(pid)) {
            try {
                ws.send(JSON.stringify({
                    type: 'exit',
                    code: exit.code,
                    at: exit.at,
                    reason: exit.reason,
                }));
            }
            catch { /* socket closed */ }
        }
    });
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
const LONG_RUNNING_CMD_RE = /^(vite|wrangler|next|nuxt|astro|remix|dev|serve|start|watch|npm\s+run\s+dev)\b/;
export function handleProcessesListRequest(processes) {
    const listed = [];
    for (const p of processes.getAll()) {
        const snap = processes.logSnapshot(p.pid);
        listed.push({
            pid: p.pid,
            command: p.command,
            state: p.state,
            exitCode: p.exitCode,
            // child-process isolation gap #2: prefer the explicit longRunning flag set by
            // FacetManager.spawn; fall back to the command-string heuristic
            // for legacy entries that didn't go through that primitive.
            longRunning: p.longRunning === true || LONG_RUNNING_CMD_RE.test(p.command),
            attachedTty: p.attachedTty === true,
            hasLogs: !!snap && snap.chunks > 0,
            logBytes: snap?.bytes ?? 0,
            startTime: p.startTime,
        });
    }
    // Reaped processes with lingering log buffers (exited >60s ago, not
    // yet past the 10 min retention) are intentionally NOT listed here —
    // the process table has already purged them and the log store has no
    // key-iteration API. Users can still access those logs via the `logs
    // <pid>` shell command.
    // Audit C3: same-origin only. The session shell at /s/<id>/ polls
    // this from its own origin; no cross-origin reader is intended.
    return Response.json({ processes: listed }, {
        headers: { 'Cache-Control': 'no-store' },
    });
}
/**
 * Utility: does this pathname match `/api/logs/<pid>`? Returns the pid
 * or null. Kept alongside the handler so the routing regex lives in
 * exactly one place.
 */
export function matchLogsPath(pathname) {
    const m = pathname.match(/^\/api\/logs\/(\d+)$/);
    if (!m)
        return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}
