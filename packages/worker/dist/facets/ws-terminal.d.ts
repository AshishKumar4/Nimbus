/**
 * WebSocket-backed terminal matching Nimbus's ITerminal interface.
 * HeadlessTerminal has: write, writeln, onData, sendData, cols, rows, focus, clear
 *
 * [B'.5] The `ws` ref is no longer readonly: a wsClose leaves the
 * Shell + this terminal alive in-memory; the next /ws upgrade calls
 * `attach(newWs, ...)` to swap in the new socket. The buffer/flush
 * timer state is preserved across the swap so any in-flight
 * coalescing continues seamlessly.
 */
export declare class WebSocketTerminal {
    ws: WebSocket;
    private dataCallback;
    /**
     * REPL-W1: secondary input callback installed by interactive runtimes
     * (e.g. `python` no-args). When non-null, sendData() routes input to
     * this callback INSTEAD of the shell. Set via attachRepl(); cleared
     * by the disposer the attach call returns. Supports nesting (the
     * disposer restores the prior callback).
     *
     * §3 (Layer 2): the explicit handoff mirrors how `vim`/`less` swap
     * the parent shell's terminal handler. Auto-detect was rejected as
     * fragile. Additive only — when null, behavior is identical to pre-W1.
     */
    private replCallback;
    /**
     * editor/monaco (2026-05-13): Editor-pane file-system bridge.
     *
     * When non-null, fs-* messages (fs-read / fs-write / fs-list) are
     * routed to this callback INSTEAD of the shell. The callback is
     * supplied by init.ts which holds the SqliteVFS handle; it uses
     * the same `reply` lambda we provide to send back fs-*-result
     * frames over the live WS.
     *
     * Additive — when null, fs-* messages are silently dropped (same
     * pre-editor behavior, since handleMessage's switch had no case
     * for them).
     */
    private fsCallback;
    private _cols;
    private _rows;
    private buffer;
    private flushTimer;
    /** [B'.3] Optional tee called from flush() with the final coalesced
     *  frame data. Used by initSession to mirror every WS output frame
     *  into nimbus_terminal_scrollback. Single-frame granularity (not
     *  per-write) keeps the row count bounded by the 5 ms flush cadence. */
    private onFlush;
    constructor(ws: WebSocket, onFlush?: (data: string) => void);
    /**
     * [B'.5] Swap the underlying WebSocket on a warm rejoin. The Shell
     * keeps `terminal` as a stable instance reference (it stored
     * `this.terminal = e` in its ctor); we just point our ws ref at
     * the new socket. The optional onFlush replaces the prior tee
     * (initSession passes a fresh closure capturing the same
     * self.ctx, but TypeScript-wise it's a fresh function value).
     */
    attach(ws: WebSocket, onFlush?: (data: string) => void): void;
    get cols(): number;
    get rows(): number;
    write(data: string): void;
    writeln(data: string): void;
    /**
     * REPL-A1 (master plan §1): drain the buffer synchronously, bypassing
     * the 5 ms coalescer. Used by ReplSession.submitLine to emit stdout,
     * stderr, and the next-prompt as three discrete frames in deterministic
     * order. Without this, all three coalesce into one `{type:'output'}`
     * frame and probes asserting frame-order (stderr-before-stdout or
     * prompt-after-output) see false-failing.
     *
     * Idempotent: cancels the pending timer + sends current buffer (if any).
     * Safe to call on an empty buffer (no-op).
     */
    flushNow(): void;
    private flush;
    onData(callback: (data: string) => void): void;
    handleMessage(msg: {
        type: string;
        data?: string;
        cols?: number;
        rows?: number;
        path?: string;
        content?: string;
        dir?: string;
        recursive?: boolean;
    }): void;
    /**
     * editor/monaco (2026-05-13): install the fs-* message handler.
     * The callback receives the raw message + a reply lambda that
     * accepts a JSON-serializable frame and pushes it over this WS.
     * Single-slot (last call wins) — init.ts is the only caller and
     * reinstalls on warm rejoin via `attach()`.
     */
    onFs(cb: (msg: any, reply: (frame: any) => void) => void): void;
    sendData(data: string): void;
    /**
     * REPL-W1: install a runtime-side input handler. Returns a disposer
     * that restores the prior handler (supports nesting). Calling this
     * does NOT change the shell's dataCallback — it just shadows it
     * until the disposer runs.
     */
    attachRepl(cb: (data: string) => void): () => void;
    focus(): void;
    clear(): void;
}
//# sourceMappingURL=ws-terminal.d.ts.map