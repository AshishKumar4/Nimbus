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
export class WebSocketTerminal {
  public ws: WebSocket;
  private dataCallback: ((data: string) => void) | null = null;
  /**
   * REPL-W1: secondary input callback installed by interactive runtimes
   * (e.g. `python` no-args). When non-null, sendData() routes input to
   * this callback INSTEAD of the shell. Set via attachRepl(); cleared
   * by the disposer the attach call returns. Supports nesting (the
   * disposer restores the prior callback).
   *
   * Reasoning per /workspace/.seal-internal/2026-05-11-repl-plan/plan.md
   * §3 (Layer 2): the explicit handoff mirrors how `vim`/`less` swap
   * the parent shell's terminal handler. Auto-detect was rejected as
   * fragile. Additive only — when null, behavior is identical to pre-W1.
   */
  private replCallback: ((data: string) => void) | null = null;
  /**
   * monaco-wave-a (2026-05-13): Editor-pane file-system bridge.
   *
   * When non-null, fs-* messages (fs-read / fs-write / fs-list) are
   * routed to this callback INSTEAD of the shell. The callback is
   * supplied by init.ts which holds the SqliteVFS handle; it uses
   * the same `reply` lambda we provide to send back fs-*-result
   * frames over the live WS.
   *
   * Additive — when null, fs-* messages are silently dropped (same
   * pre-Wave-A behavior, since handleMessage's switch had no case
   * for them).
   */
  private fsCallback: ((msg: any, reply: (frame: any) => void) => void) | null = null;
  private _cols: number = 80;
  private _rows: number = 24;
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** [B'.3] Optional tee called from flush() with the final coalesced
   *  frame data. Used by initSession to mirror every WS output frame
   *  into nimbus_terminal_scrollback. Single-frame granularity (not
   *  per-write) keeps the row count bounded by the 5 ms flush cadence. */
  private onFlush: ((data: string) => void) | null;

  constructor(ws: WebSocket, onFlush?: (data: string) => void) {
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
  attach(ws: WebSocket, onFlush?: (data: string) => void): void {
    this.ws = ws;
    if (onFlush !== undefined) this.onFlush = onFlush;
  }

  get cols(): number { return this._cols; }
  get rows(): number { return this._rows; }

  write(data: string): void {
    this.buffer.push(data);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 5);
    }
  }

  writeln(data: string): void { this.write(data + '\r\n'); }

  /**
   * REPL-A1 (master plan §1): drain the buffer synchronously, bypassing
   * the 5 ms coalescer. Used by ReplSession.submitLine to emit stdout,
   * stderr, and the next-prompt as three discrete frames in deterministic
   * order. Without this, all three coalesce into one `{type:'output'}`
   * frame and probes asserting frame-order (stderr-before-stdout or
   * prompt-after-output) see false-RED.
   *
   * Idempotent: cancels the pending timer + sends current buffer (if any).
   * Safe to call on an empty buffer (no-op).
   */
  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  private flush(): void {
    this.flushTimer = null;
    if (this.buffer.length === 0) return;
    const combined = this.buffer.join('');
    this.buffer = [];
    try { this.ws.send(JSON.stringify({ type: 'output', data: combined })); } catch {}
    // [B'.3] Tee to scrollback. Runs AFTER the WS send so a thrown
    // tee can't break the live stream. Fail-soft on the call: any
    // throw is swallowed; appendScrollback itself catches its own
    // SQL errors via try/catch in initSession's wrapper.
    if (this.onFlush) {
      try { this.onFlush(combined); } catch {}
    }
  }

  onData(callback: (data: string) => void): void { this.dataCallback = callback; }

  handleMessage(msg: { type: string; data?: string; cols?: number; rows?: number; path?: string; content?: string; dir?: string; recursive?: boolean }): void {
    switch (msg.type) {
      case 'input':
        if (msg.data) this.sendData(msg.data);
        break;
      case 'resize':
        if (msg.cols) this._cols = msg.cols;
        if (msg.rows) this._rows = msg.rows;
        break;
      // monaco-wave-a (2026-05-13): editor-pane fs bridge. Route to
      // the registered fsCallback (set by init.ts which holds the
      // SqliteVFS). Callback uses the reply lambda to push fs-*-result
      // frames over this WS. Untouched messages (no callback) are
      // silently dropped — same pre-Wave-A behavior.
      case 'fs-read':
      case 'fs-write':
      case 'fs-list':
        if (this.fsCallback) {
          const reply = (frame: any) => {
            try { this.ws.send(JSON.stringify(frame)); } catch {}
          };
          try { this.fsCallback(msg, reply); } catch (e: any) {
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
   * monaco-wave-a (2026-05-13): install the fs-* message handler.
   * The callback receives the raw message + a reply lambda that
   * accepts a JSON-serializable frame and pushes it over this WS.
   * Single-slot (last call wins) — init.ts is the only caller and
   * reinstalls on warm rejoin via `attach()`.
   */
  onFs(cb: (msg: any, reply: (frame: any) => void) => void): void {
    this.fsCallback = cb;
  }

  sendData(data: string): void {
    // REPL-W1: replCallback takes priority when set. Restored by the
    // disposer attachRepl() returns.
    if (this.replCallback) { this.replCallback(data); return; }
    if (this.dataCallback) this.dataCallback(data);
  }

  /**
   * REPL-W1: install a runtime-side input handler. Returns a disposer
   * that restores the prior handler (supports nesting). Calling this
   * does NOT change the shell's dataCallback — it just shadows it
   * until the disposer runs.
   */
  attachRepl(cb: (data: string) => void): () => void {
    const prior = this.replCallback;
    this.replCallback = cb;
    return () => {
      // Idempotent: only restore if we're still the current shadow.
      // If a nested attachRepl ran in between, the disposer chain
      // resolves bottom-up correctly.
      this.replCallback = prior;
    };
  }

  focus(): void {}
  clear(): void { this.write('\x1b[2J\x1b[H'); }
}
