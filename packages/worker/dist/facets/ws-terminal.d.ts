export declare class WebSocketTerminal {
    /** Null while the terminal is headless (composed before any attach). */
    ws: WebSocket | null;
    private dataCallback;
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
    constructor(ws?: WebSocket | null, onFlush?: (data: string) => void);
    /**
     * [B'.5] Swap the underlying WebSocket on a warm rejoin. The Shell
     * keeps `terminal` as a stable instance reference (it stored
     * `this.terminal = e` in its ctor); we just point our ws ref at
     * the new socket. The optional onFlush replaces the prior tee
     * (initSession passes a fresh closure capturing the same
     * self.ctx, but TypeScript-wise it's a fresh function value).
     */
    attach(ws: WebSocket, onFlush?: (data: string) => void): void;
    /** Release the socket without ending the terminal's lifetime. */
    detach(): void;
    private replBinding;
    private replTeardown;
    disposeRepl(): Promise<void>;
    close(): void;
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
    attachRepl(input: (data: string) => void, dispose?: () => Promise<void>): () => void;
    focus(): void;
    clear(): void;
}
//# sourceMappingURL=ws-terminal.d.ts.map