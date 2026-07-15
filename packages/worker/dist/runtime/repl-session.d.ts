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
import type { WebSocketTerminal } from '../facets/ws-terminal.js';
/**
 * Per-runtime adapter contract. The shell-side ReplSession orchestrates
 * input handling; the adapter wraps the actual runtime invocation.
 */
export interface ReplAdapter {
    /** Called once when the session starts. Returns the banner to print
     *  before the first prompt. */
    banner(): string;
    /** Send a complete line of user input. Returns:
     *    - kind === 'output': normal eval result; resume reading at prompt.
     *    - kind === 'incomplete': need more input (multi-line block).
     *    - kind === 'exit': REPL should close with the given exit code.
     *    - kind === 'error': error message to display; resume at prompt.
     */
    push(line: string): Promise<ReplPushResult>;
    /** Called once on session close (exit() / Ctrl-D / shell teardown).
     *  Should free any cached pool / isolate. Idempotent. */
    close(): Promise<void>;
    /** Primary prompt (typically '>>> '). */
    ps1: string;
    /** Continuation prompt (typically '... '). */
    ps2: string;
}
export type ReplPushResult = {
    kind: 'output';
    stdout: string;
    stderr: string;
} | {
    kind: 'incomplete';
} | {
    kind: 'exit';
    exitCode: number;
    stdout?: string;
    stderr?: string;
} | {
    kind: 'error';
    stderr: string;
};
/**
 * Manages an interactive REPL session: stdin buffering with minimal
 * readline UX (line-mode), output routing to the WS terminal, prompt
 * rendering, and adapter dispatch.
 *
 * The shell creates a ReplSession when a runtime's `startRepl` hook
 * fires; the session installs a `replCallback` on the WebSocketTerminal
 * (via attachRepl()) and runs until the adapter signals 'exit' or the
 * user presses Ctrl-D on an empty line.
 *
 * No setTimeout in the read loop — the session is driven entirely by
 * keystroke arrival on the WS, with awaits gating the adapter's push().
 */
export declare class ReplSession {
    private adapter;
    private terminal;
    private detachReplCb;
    /**
     * REPL-R7-1 (2026-05-12): optional reference to the Nimbus shell.
     *
     * Required when the REPL is launched from a multi-line WS frame
     * (e.g. user pastes `python\nexit(7)`). The shell input handler
     * splits the frame on \r\n and pushes lines AFTER
     * the first into `shell.pasteQueue`, which is drained ONLY when
     * the shell becomes idle (after executeLine returns). While our
     * REPL is running, those pasteQueue lines sit there waiting and
     * the REPL itself receives no input → user sees a hung `>>> `
     * prompt that never responds.
     *
     * If `shell` is provided, ReplSession will, immediately after
     * attaching its replCallback, drain shell.pasteQueue and feed the
     * lines into the callback (suffixed with \r each — matches what
     * the WS frame originally would have looked like). This makes the
     * paste path work transparently for REPL launches.
     *
     * The shell reference is optional so existing adapters (bun, node,
     * ruby) that haven't been updated keep working with their
     * pre-fix behavior.
     */
    private shellRef;
    /** Current line buffer (chars typed since the last enter). */
    private lineBuf;
    /** Cursor position within lineBuf (0 = beginning). */
    private cursorPos;
    /** Accumulated lines for a multi-line block (e.g. inside def/class). */
    private blockBuf;
    /** True while the adapter is processing a push (block subsequent submits). */
    private busy;
    /** Per-session history ring (most recent first). Capped at 100. */
    private history;
    private historyIdx;
    /** Resolves when close() has been called and the session ended. */
    private closedResolve;
    private closedPromise;
    /** Exit code captured from adapter's last 'exit' return. */
    private exitCode;
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
    private inputQueue;
    private draining;
    constructor(adapter: ReplAdapter, terminal: WebSocketTerminal, shell?: any);
    /** Run the session: prints banner, installs the input hook, returns
     *  a promise that resolves with the exit code when the session ends. */
    run(): Promise<number>;
    /**
     * REPL-A1b: drain the input queue serially. Pulls data off
     * inputQueue, runs handleInput, and reads any data that arrived
     * during the await. Exits when queue is empty. Only ONE drainInput
     * runs at a time (guarded by draining flag set in attachRepl
     * callback).
     */
    private drainInput;
    /** Process an input chunk. May contain multiple characters (paste
     *  or rapid typing) — we iterate char-by-char to handle each
     *  control byte individually. */
    private handleInput;
    /** Submit the current line buffer to the adapter. */
    private submitLine;
    /** Map up-arrow → previous history entry. */
    private historyUp;
    /** Map down-arrow → next (newer) history entry. */
    private historyDown;
    /** Erase the current displayed line and replace with `text`. */
    private replaceCurrentLine;
    /** Close the session: detach input hook, free adapter, resolve. */
    private endSession;
}
//# sourceMappingURL=repl-session.d.ts.map