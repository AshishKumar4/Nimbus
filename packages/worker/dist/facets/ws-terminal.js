export class WebSocketTerminal {
    /** Null while the terminal is headless (composed before any attach). */
    ws;
    dataCallback = null;
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
    fsCallback = null;
    _cols = 80;
    _rows = 24;
    buffer = [];
    flushTimer = null;
    /** [B'.3] Optional tee called from flush() with the final coalesced
     *  frame data. Used by initSession to mirror every WS output frame
     *  into nimbus_terminal_scrollback. Single-frame granularity (not
     *  per-write) keeps the row count bounded by the 5 ms flush cadence. */
    onFlush;
    constructor(ws = null, onFlush) {
        this.ws = ws;
        this.onFlush = onFlush ?? null;
    }
    /**
     * [B'.5] Swap the underlying WebSocket on a warm rejoin. The Shell
     * keeps `terminal` as a stable instance reference (it stored
     * `this.terminal = e` in its ctor); we just point our ws ref at
     * the new socket. The optional onFlush replaces the prior tee
     * (initSession passes a fresh closure capturing the same
     * self.ctx, but TypeScript-wise it's a fresh function value).
     */
    attach(ws, onFlush) {
        this.ws = ws;
        if (onFlush !== undefined)
            this.onFlush = onFlush;
    }
    /** Release the socket without ending the terminal's lifetime. */
    detach() {
        this.ws = null;
    }
    replBinding = null;
    replTeardown = null;
    disposeRepl() {
        if (this.replTeardown)
            return this.replTeardown;
        const first = this.replBinding;
        if (!first)
            return Promise.resolve();
        this.replBinding = null;
        this.replTeardown = Promise.resolve().then(async () => {
            const errors = [];
            let binding = first;
            while (binding) {
                const next = binding.previous;
                try {
                    await binding.dispose?.();
                }
                catch (error) {
                    errors.push(error instanceof Error ? error : new Error(String(error)));
                }
                binding = next;
            }
            if (errors.length > 0)
                throw new AggregateError(errors, 'REPL cleanup failed');
        }).finally(() => { this.replTeardown = null; });
        return this.replTeardown;
    }
    close() {
        void this.disposeRepl().catch((error) => console.warn('[terminal] REPL cleanup failed', error));
        if (this.flushTimer)
            clearTimeout(this.flushTimer);
        this.flushTimer = null;
        this.buffer = [];
        this.onFlush = null;
        this.dataCallback = null;
        this.fsCallback = null;
        try {
            this.ws?.close(1000, 'terminal closed');
        }
        catch { }
        this.ws = null;
    }
    get cols() { return this._cols; }
    get rows() { return this._rows; }
    write(data) {
        this.buffer.push(data);
        if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => this.flush(), 5);
        }
    }
    writeln(data) { this.write(data + '\r\n'); }
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
    flushNow() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.flush();
    }
    flush() {
        this.flushTimer = null;
        if (this.buffer.length === 0)
            return;
        const combined = this.buffer.join('');
        this.buffer = [];
        try {
            this.ws?.send(JSON.stringify({ type: 'output', data: combined }));
        }
        catch { }
        // [B'.3] Tee to scrollback. Runs AFTER the WS send so a thrown
        // tee can't break the live stream. Fail-soft on the call: any
        // throw is swallowed; appendScrollback itself catches its own
        // SQL errors via try/catch in initSession's wrapper.
        if (this.onFlush) {
            try {
                this.onFlush(combined);
            }
            catch { }
        }
    }
    onData(callback) { this.dataCallback = callback; }
    handleMessage(msg) {
        switch (msg.type) {
            case 'input':
                if (msg.data)
                    this.sendData(msg.data);
                break;
            case 'resize':
                if (msg.cols)
                    this._cols = msg.cols;
                if (msg.rows)
                    this._rows = msg.rows;
                break;
            // editor/monaco (2026-05-13): editor-pane fs bridge. Route to
            // the registered fsCallback (set by init.ts which holds the
            // SqliteVFS). Callback uses the reply lambda to push fs-*-result
            // frames over this WS. Untouched messages (no callback) are
            // silently dropped — same pre-editor behavior.
            case 'fs-read':
            case 'fs-write':
            case 'fs-list':
                if (this.fsCallback) {
                    // editor/monaco hotfix (2026-05-13): auto-echo reqId from
                    // the inbound msg into every reply frame. The client side
                    // (public/s/index.html Editor.fsRequest) keys its pending-
                    // request Map on reqId; without echo, every request hangs
                    // until the 15s timeout. Doing the merge HERE (vs at every
                    // reply site in init.ts's handler) means the handler stays
                    // ignorant of multiplexing — single source of truth.
                    const reqId = msg.reqId;
                    const reply = (frame) => {
                        try {
                            const merged = (reqId !== undefined && frame && typeof frame === 'object')
                                ? { ...frame, reqId }
                                : frame;
                            this.ws?.send(JSON.stringify(merged));
                        }
                        catch { }
                    };
                    try {
                        this.fsCallback(msg, reply);
                    }
                    catch (e) {
                        reply({
                            type: msg.type + '-result',
                            path: msg.path, dir: msg.dir,
                            ok: false,
                            error: 'fs handler threw: ' + (e?.message || String(e)),
                        });
                    }
                }
                break;
        }
    }
    /**
     * editor/monaco (2026-05-13): install the fs-* message handler.
     * The callback receives the raw message + a reply lambda that
     * accepts a JSON-serializable frame and pushes it over this WS.
     * Single-slot (last call wins) — init.ts is the only caller and
     * reinstalls on warm rejoin via `attach()`.
     */
    onFs(cb) {
        this.fsCallback = cb;
    }
    sendData(data) {
        if (this.replBinding)
            this.replBinding.input(data);
        else
            this.dataCallback?.(data);
    }
    attachRepl(input, dispose) {
        if (this.replTeardown)
            throw new Error('Cannot attach a REPL while cleanup is running');
        const binding = { input, dispose, previous: this.replBinding };
        this.replBinding = binding;
        return () => {
            if (this.replBinding === binding) {
                this.replBinding = binding.previous;
                return;
            }
            let current = this.replBinding;
            while (current && current.previous !== binding)
                current = current.previous;
            if (current)
                current.previous = binding.previous;
        };
    }
    focus() { }
    clear() { this.write('\x1b[2J\x1b[H'); }
}
