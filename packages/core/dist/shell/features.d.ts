interface ShellLike {
    executeLine(line: string): Promise<void>;
    printPrompt(): void;
    handleInput(data: string): void;
    drainPasteQueue(): void;
    redrawLine(): void;
    running: boolean;
    history: string[];
    lineBuffer: string;
    cursorPos: number;
    screenCursorRow: number;
    historyIndex: number;
    pasteQueue: string[];
}
interface TerminalLike {
    write(data: string): void;
}
export interface HeredocInfo {
    command: string;
    delimiters: Array<{
        delimiter: string;
        stripTabs: boolean;
    }>;
}
export declare function parseHeredoc(input: string): HeredocInfo | null;
export declare class HeredocHandler {
    private shell;
    private terminal;
    private originalExecuteLine;
    private originalPrintPrompt;
    private originalHandleInput;
    private active;
    private heredocInfo;
    private currentHeredocIndex;
    private bodies;
    private historyLengthAtStart;
    /** Safety limit to prevent unbounded memory growth */
    private static readonly MAX_HEREDOC_LINES;
    constructor(shell: ShellLike, terminal: TerminalLike);
    /**
     * Install the heredoc handler on a Shell instance.
     * Call once after the Shell is created.
     */
    static install(shell: ShellLike, terminal: TerminalLike): HeredocHandler;
    /** Cancel heredoc accumulation and return to normal shell prompt. */
    private _cancel;
    private _patch;
    private _printPrompt;
    private _handleOriginalInput;
    private _executeOriginalLine;
    private _startAccumulation;
    /**
     * Process a single heredoc content line (non-recursive).
     * Returns true if this was the delimiter (heredoc is complete).
     */
    private _processLine;
    /**
     * Called when executeLine fires during accumulation (user typed a line + Enter).
     * Also called during paste processing.
     */
    private _accumulateLine;
    /**
     * Drain the Shell's pasteQueue during heredoc accumulation.
     * When a multi-line heredoc is pasted, all lines land in the paste queue.
     * Uses an iterative loop (not recursive) to avoid stack overflow.
     */
    private _drainPasteQueue;
    private _finishHeredoc;
    private _currentDelimiter;
}
/**
 * LineEditorExtender — adds bash-readline-parity keybindings to the
 * Nimbus shell line editor.
 *
 * The vanilla Shell handles only a minimal set: ←/→/↑/↓, Home, End,
 * Ctrl+A, Ctrl+E, Ctrl+C, Ctrl+D (EOF), Ctrl+U (whole-line wipe), Tab,
 * Enter, Backspace, Delete. Every other readline binding (Ctrl+W,
 * Ctrl+K, Ctrl+Y, Alt+B, Alt+F, Alt+D, Ctrl+←, Alt+. , Ctrl+R, etc.)
 * gets dropped on the floor.
 *
 * This handler wraps `shell.handleInput` to recognise the missing
 * sequences and apply their readline-spec semantics directly to
 * `shell.lineBuffer` / `shell.cursorPos` / `shell.history`, then
 * triggers `shell.redrawLine()` to re-render.
 *
 * Install AFTER HeredocHandler so the heredoc wrapper sees input
 * first (its mode is exclusive); when heredoc isn't active our
 * handler runs.
 *
 * Word boundary conventions (matches bash 5.x readline):
 *   - Ctrl+W (unix-word-rubout): whitespace boundary — bash override
 *   - Alt+Backspace (backward-kill-word): readline word `[A-Za-z0-9_]+`
 *   - Alt+B / Alt+F (backward/forward-word): readline word
 *   - Ctrl+← / Ctrl+→ (alias for word nav): readline word
 *   - Alt+D (kill-word): readline word
 *
 * Kill-ring: simple single-slot (the most-recent cut). Ctrl+Y yanks it.
 *
 * Ctrl+R sub-mode: enters reverse-i-search; capturing chars narrows
 * the match against history; Enter runs the matched line; Esc/Ctrl+G
 * aborts; another Ctrl+R steps to the next-older match.
 */
export declare class LineEditorExtender {
    private shell;
    private terminal;
    private originalHandleInput;
    /** Single-slot kill-ring. Set by Ctrl+W / Ctrl+K / Ctrl+U / Alt+Backspace / Alt+D. */
    private killRing;
    /** Yank-last-arg state — index into `history` (from the end), most
     *  recent = 0. Reset when the user types anything other than Alt+. */
    private yankLastArgIndex;
    /** Length of the inserted last-arg blob from the previous Alt+. press
     *  so a follow-up Alt+. can remove it and insert the older one. */
    private yankLastArgInsertedLen;
    /** Reverse-i-search sub-mode state. */
    private rsearchActive;
    private rsearchQuery;
    /** History index (from end) of the currently-displayed match;
     *  -1 = no match, otherwise points at `history[history.length-1-idx]`. */
    private rsearchMatchIndex;
    /** Match readline's word definition: ASCII alphanumerics + underscore. */
    private static isWordChar;
    constructor(shell: ShellLike, terminal: TerminalLike);
    static install(shell: ShellLike, terminal: TerminalLike): LineEditorExtender;
    private _patch;
    /**
     * Returns true if the input was a recognised readline binding and we
     * handled it; false to fall through to the original handler.
     */
    private _handleBinding;
    /** Move from `pos` to the start of the previous readline word. */
    private _prevWordStart;
    /** Move from `pos` to the end of the next readline word. */
    private _nextWordEnd;
    private _caseTransformWord;
    private _yankLastArg;
    private _rsearchEnter;
    private _rsearchHandle;
    /** Step the match index forward (older) and re-search from there. */
    private _rsearchAdvance;
    /** Find the most-recent history line containing the query. */
    private _rsearchSearch;
    private _rsearchCurrentMatch;
    /** Render the search-prompt line. */
    private _rsearchRender;
    /**
     * Exit the search sub-mode. If `restoreLine` is true, the line
     * buffer is left as it was when search began (no insertion). The
     * caller is expected to call `redrawLine()` afterward if needed.
     */
    private _rsearchExit;
}
export {};
//# sourceMappingURL=features.d.ts.map