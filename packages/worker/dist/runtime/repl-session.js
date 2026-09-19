/**
 * repl-session.ts — substrate for interactive REPL sessions.
 *
 *   Layer 1: long-lived runtime via repeated execute() into a cached
 *            child-facet isolate (state persists on globalThis).
 *   Layer 2: stdin routing via WebSocketTerminal.attachRepl().
 *   Layer 3: prompt detection per-runtime — Pyodide uses sentinel-
 *            controlled sys.ps1; Bun/Node/Ruby use per-runtime regex.
 *
 * This file owns the runtime-agnostic plumbing. Per-runtime adapters
 * live in src/runtime/<name>-repl.ts and implement the ReplAdapter
 * interface declared below.
 */
import { errorText } from '@nimbus-sh/core/_shared/error-text.js';
import { normalizeTerminalNewlines } from '@nimbus-sh/core/_shared/terminal.js';
export class ReplSession {
    adapter;
    detachRepl = null;
    terminal;
    shellRef = null;
    /** Current line buffer (chars typed since the last enter). */
    lineBuf = '';
    /** Cursor position within lineBuf (0 = beginning). */
    cursorPos = 0;
    /** Accumulated lines for a multi-line block (e.g. inside def/class). */
    blockBuf = [];
    /** True while the adapter is processing a push (block subsequent submits). */
    busy = false;
    /** Per-session history ring (most recent first). Capped at 100. */
    history = [];
    historyIdx = -1;
    closedResolve = null;
    closedPromise;
    pendingInterrupt = null;
    activePush = null;
    ending = null;
    /** Exit code captured from adapter's last 'exit' return. */
    exitCode = 0;
    /**
     * REPL-A1b (master plan §1 + user-evidence 2026-05-11): handleInput
     * is invoked fire-and-forget per WS frame. Multiple WS frames arrive
     * in quick succession during real REPL use (and during probes that
     * send multiple lines without waiting for prompt). Without
     * serialization, two concurrent handleInput coroutines both hit `\r`
     * and call submitLine(); blockBuf accumulates wrong source; PyodideConsole
     * gets `print("hi")\\nexit()` as a single 'single'-mode compile →
     * "multiple statements found while compiling a single statement"
     * SyntaxError.
     *
     * Fix: chain handleInput invocations through inputQueue. Each WS
     * frame appends to queue; a single drain task processes the queue
     * sequentially. submitLine's await is properly ordered relative to
     * the next frame's chars.
     */
    inputQueue = '';
    draining = false;
    constructor(adapter, terminal, shell) {
        this.adapter = adapter;
        this.terminal = terminal;
        // REPL-R7-1: optional shell reference for pasteQueue drain.
        this.shellRef = shell ?? null;
        this.closedPromise = new Promise((resolve) => {
            this.closedResolve = resolve;
        });
    }
    /** Run the session: prints banner, installs the input hook, returns
     *  a promise that resolves with the exit code when the session ends. */
    async run() {
        // 1. Print banner from adapter.
        const banner = this.adapter.banner();
        if (banner)
            this.terminal.write(banner);
        if (banner && !banner.endsWith('\n'))
            this.terminal.write('\r\n');
        // 2. Print primary prompt.
        this.terminal.write(this.adapter.ps1);
        // 3. Install the input handler.
        // REPL-A1b: per-frame data appended to inputQueue; single drain
        // task ensures serial processing across multiple WS frames.
        this.detachRepl = this.terminal.attachRepl((data) => {
            // Ctrl-C is the one input byte that must not queue behind a busy
            // push: it is the user's abort, and it only works if it runs now.
            if (this.busy && data.includes('\x03')) {
                this.inputQueue = '';
                data = data.slice(data.lastIndexOf('\x03') + 1);
                this.interruptBusy();
                if (data.length === 0)
                    return;
            }
            if (this.ending)
                return;
            this.inputQueue += data;
            if (!this.draining) {
                this.draining = true;
                void this.drainInput();
            }
        }, () => this.endSession(this.exitCode));
        const queued = this.shellRef?.takeQueuedInput() ?? [];
        if (queued.length > 0) {
            this.inputQueue += queued.join('\r') + '\r';
            if (!this.draining) {
                this.draining = true;
                void this.drainInput();
            }
        }
        // 4. Wait until close() is called.
        await this.closedPromise;
        return this.exitCode;
    }
    async drainInput() {
        try {
            while (this.inputQueue.length > 0 && !this.ending) {
                const chunk = this.inputQueue;
                this.inputQueue = '';
                await this.handleInput(chunk);
            }
        }
        catch (error) {
            if (!this.ending) {
                this.terminal.write('[repl] ' + errorText(error) + '\r\n');
                try {
                    await this.endSession(1);
                }
                catch { /* run() reports the cleanup failure as exit 1. */ }
            }
        }
        finally {
            this.draining = false;
        }
    }
    /** Process an input chunk. May contain multiple characters (paste
     *  or rapid typing) — we iterate char-by-char to handle each
     *  control byte individually. */
    async handleInput(data) {
        for (let i = 0; i < data.length; i++) {
            if (this.ending)
                return;
            const ch = data[i];
            // CTRL-D (0x04): on empty line, close cleanly.
            if (ch === '\x04') {
                if (this.lineBuf.length === 0 && this.blockBuf.length === 0 && !this.busy) {
                    this.terminal.write('\r\n');
                    await this.endSession(0);
                    return;
                }
                // Non-empty line: ignore (matches CPython REPL behavior).
                continue;
            }
            // CTRL-C (0x03): cancel current line / block.
            if (ch === '\x03') {
                if (this.busy) {
                    this.interruptBusy();
                    continue;
                }
                // Idle: discard current buffer, reset, fresh prompt.
                this.lineBuf = '';
                this.cursorPos = 0;
                this.blockBuf = [];
                this.terminal.write('\r\nKeyboardInterrupt\r\n' + this.adapter.ps1);
                continue;
            }
            // Enter (\r or \n): submit the line.
            if (ch === '\r' || ch === '\n') {
                await this.submitLine();
                continue;
            }
            // Backspace (0x7f) or DEL (\b 0x08): delete char before cursor.
            if (ch === '\x7f' || ch === '\b') {
                if (this.cursorPos > 0) {
                    this.lineBuf =
                        this.lineBuf.slice(0, this.cursorPos - 1) +
                            this.lineBuf.slice(this.cursorPos);
                    this.cursorPos--;
                    // Repaint: move cursor back, write rest, clear trailing, restore.
                    this.terminal.write('\b' + this.lineBuf.slice(this.cursorPos) + ' \b');
                    // Cursor sits one past the rewritten chars; pull it back to position.
                    const tail = this.lineBuf.slice(this.cursorPos).length;
                    for (let k = 0; k < tail; k++)
                        this.terminal.write('\b');
                }
                continue;
            }
            // ANSI escape sequence (arrow keys, etc.). Buffer the full sequence
            // by reading ahead. v1: only handle up/down arrows for history;
            // left/right are deferred (minimal readline = no in-line editing).
            if (ch === '\x1b' && i + 2 < data.length && data[i + 1] === '[') {
                const code = data[i + 2];
                if (code === 'A') {
                    this.historyUp();
                    i += 2;
                    continue;
                }
                if (code === 'B') {
                    this.historyDown();
                    i += 2;
                    continue;
                }
                // C/D (left/right) and others: ignore.
                i += 2;
                continue;
            }
            // Printable char: append + echo.
            if (ch >= ' ' && ch !== '\x7f') {
                if (this.cursorPos === this.lineBuf.length) {
                    this.lineBuf += ch;
                    this.cursorPos++;
                    this.terminal.write(ch);
                }
                else {
                    // Mid-line insert (rare without left-arrow editing in v1).
                    this.lineBuf =
                        this.lineBuf.slice(0, this.cursorPos) + ch + this.lineBuf.slice(this.cursorPos);
                    this.cursorPos++;
                    this.terminal.write(ch);
                }
            }
        }
    }
    interruptBusy() {
        if (this.ending || this.pendingInterrupt)
            return;
        this.terminal.write('^C\r\n');
        this.terminal.flushNow();
        if (!this.adapter.interrupt)
            return;
        try {
            this.pendingInterrupt = Promise.resolve(this.adapter.interrupt()).then(() => ({ kind: 'interrupted' }), (error) => ({ kind: 'failed', message: errorText(error) }));
        }
        catch (error) {
            this.pendingInterrupt = Promise.resolve({ kind: 'failed', message: errorText(error) });
        }
    }
    async submitLine() {
        this.terminal.write('\r\n');
        const line = this.lineBuf;
        this.lineBuf = '';
        this.cursorPos = 0;
        // Record in history (skip blank and duplicate-of-most-recent).
        if (line.length > 0 && this.history[0] !== line) {
            this.history.unshift(line);
            if (this.history.length > 100)
                this.history.length = 100;
        }
        this.historyIdx = -1;
        // Accumulate block lines.
        this.blockBuf.push(line);
        const fullSource = this.blockBuf.join('\n');
        this.busy = true;
        let result;
        try {
            this.activePush = this.adapter.push(fullSource);
            result = await this.activePush;
        }
        catch (error) {
            result = { kind: 'error', stderr: '[repl] adapter threw: ' + errorText(error) + '\n' };
        }
        finally {
            this.activePush = null;
        }
        const pending = this.pendingInterrupt;
        if (pending) {
            const outcome = await pending;
            if (this.pendingInterrupt === pending)
                this.pendingInterrupt = null;
            if (outcome.kind === 'interrupted') {
                result = { kind: 'error', stderr: 'KeyboardInterrupt\n[repl] execution interrupted; interpreter state reset.\n' };
            }
            else {
                this.terminal.write('[repl] interrupt failed: ' + outcome.message + '\r\n');
                this.terminal.flushNow();
            }
        }
        this.busy = false;
        if (this.ending)
            return;
        // REPL-A1 (master plan §1): emit stdout, stderr, and the next-prompt
        // as three discrete WS frames in deterministic order. Without
        // flushNow() between them, the 5 ms coalescer in WebSocketTerminal
        // joins them into one `{type:'output'}` payload — probes asserting
        // frame ordering see false-failing, and xterm renders correctly only
        // because string-order is preserved. flushNow() guarantees both
        // are true: bytes-in-order AND frame-boundary-after-each-stream.
        if (result.kind === 'output') {
            if (result.stdout) {
                this.terminal.write(normalizeTerminalNewlines(result.stdout));
                this.terminal.flushNow();
            }
            if (result.stderr) {
                this.terminal.write(normalizeTerminalNewlines(result.stderr));
                this.terminal.flushNow();
            }
            this.blockBuf = [];
            this.terminal.write(this.adapter.ps1);
            this.terminal.flushNow();
            return;
        }
        if (result.kind === 'incomplete') {
            this.terminal.write(this.adapter.ps2);
            this.terminal.flushNow();
            return;
        }
        if (result.kind === 'error') {
            if (result.stderr) {
                this.terminal.write(normalizeTerminalNewlines(result.stderr));
                this.terminal.flushNow();
            }
            this.blockBuf = [];
            this.terminal.write(this.adapter.ps1);
            this.terminal.flushNow();
            return;
        }
        if (result.kind === 'exit') {
            if (result.stdout) {
                this.terminal.write(normalizeTerminalNewlines(result.stdout));
                this.terminal.flushNow();
            }
            if (result.stderr) {
                this.terminal.write(normalizeTerminalNewlines(result.stderr));
                this.terminal.flushNow();
            }
            await this.endSession(result.exitCode);
            return;
        }
    }
    /** Map up-arrow → previous history entry. */
    historyUp() {
        if (this.history.length === 0)
            return;
        if (this.historyIdx < this.history.length - 1)
            this.historyIdx++;
        this.replaceCurrentLine(this.history[this.historyIdx]);
    }
    /** Map down-arrow → next (newer) history entry. */
    historyDown() {
        if (this.historyIdx <= 0) {
            this.historyIdx = -1;
            this.replaceCurrentLine('');
            return;
        }
        this.historyIdx--;
        this.replaceCurrentLine(this.history[this.historyIdx]);
    }
    /** Erase the current displayed line and replace with `text`. */
    replaceCurrentLine(text) {
        // Erase current chars: backspace + space + backspace per char.
        const oldLen = this.lineBuf.length;
        for (let i = 0; i < this.cursorPos; i++)
            this.terminal.write('\b');
        for (let i = 0; i < oldLen; i++)
            this.terminal.write(' ');
        for (let i = 0; i < oldLen; i++)
            this.terminal.write('\b');
        this.lineBuf = text;
        this.cursorPos = text.length;
        this.terminal.write(text);
    }
    endSession(code) {
        if (this.ending)
            return this.ending;
        this.exitCode = code;
        this.inputQueue = '';
        this.ending = Promise.resolve().then(async () => {
            let failure = null;
            try {
                await this.adapter.close();
            }
            catch (error) {
                failure = error instanceof Error ? error : new Error(String(error));
                this.exitCode = 1;
                this.terminal.write('[repl] cleanup failed: ' + failure.message + '\r\n');
                this.terminal.flushNow();
            }
            if (this.activePush)
                await this.activePush.catch(() => { });
            if (this.pendingInterrupt)
                await this.pendingInterrupt;
            this.detachRepl?.();
            this.detachRepl = null;
            this.closedResolve?.();
            this.closedResolve = null;
            if (failure)
                throw failure;
        });
        return this.ending;
    }
}
