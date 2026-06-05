/**
 * shell-features.ts — Shell preprocessor for pipes, redirects, operators,
 * env var expansion, glob expansion, and quoted strings.
 *
 * Wraps the LIFO shell's command execution with Unix-like features.
 * Called from nimbus-session.ts before dispatching to the registry.
 */
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
/**
 * Parse a command line into tokens, respecting quotes.
 * "hello world" → one token. 'don\'t' → one token.
 */
export declare function tokenize(input: string): string[];
/**
 * Expand $VAR and ${VAR} in a string using the env map.
 */
export declare function expandVars(input: string, env: Record<string, string>): string;
/**
 * Expand glob patterns (* and ?) against VFS directory entries.
 */
export declare function expandGlobs(tokens: string[], cwd: string, vfs: SqliteVFS): string[];
interface ParsedSegment {
    command: string;
    redirectOut?: string;
    redirectAppend?: string;
    redirectErr?: string;
}
/**
 * Split a command line by operators (|, &&, ||, ;) respecting quotes.
 * Returns segments with their operator type.
 */
export declare function splitOperators(input: string): {
    segments: string[];
    operators: string[];
};
/**
 * Parse redirects from a command string.
 * Returns the clean command and any redirect targets.
 */
export declare function parseRedirects(cmd: string): ParsedSegment;
/**
 * Parsed heredoc information extracted from a command line.
 */
export interface HeredocInfo {
    /** The command line with the heredoc operator and delimiter removed */
    command: string;
    /** The delimiter word (without quotes) */
    delimiter: string;
    /** Whether the delimiter was quoted (no variable expansion) */
    quoted: boolean;
    /** Whether to strip leading tabs (<<- form) */
    stripTabs: boolean;
    /** Redirect target file, if `cat > file << DELIM` pattern */
    redirectFile?: string;
    /** Whether it's an append redirect >> */
    redirectAppend?: boolean;
}
/**
 * Detect and parse a heredoc operator in a command line.
 * Supports: << DELIM, << 'DELIM', << "DELIM", <<- DELIM, <<- 'DELIM'
 *
 * Returns null if no heredoc is found.
 */
export declare function parseHeredoc(input: string): HeredocInfo | null;
/**
 * HeredocHandler — monkey-patches a Shell instance to support heredoc syntax.
 *
 * Usage: call `HeredocHandler.install(shell, terminal, vfs)` after creating the shell.
 * All heredoc logic lives here in shell-features.ts; nimbus-session.ts only calls install().
 *
 * When the user types a command containing `<<`, the handler:
 *   1. Intercepts executeLine, parses the heredoc
 *   2. Enters accumulation mode — shows `> ` continuation prompt
 *   3. Collects input lines until the delimiter is found
 *   4. Executes the command with the accumulated content as stdin
 *   5. For `cat > file << DELIM`, writes the content directly to the file
 *
 * Design notes:
 *   - The Shell from @lifo-sh/core calls `executeLine(line)` when the user
 *     presses Enter with non-empty input. For empty input, it calls
 *     `printPrompt()` directly. We patch both methods so that empty lines
 *     inside a heredoc body are properly captured.
 *   - During accumulation mode, the shell's normal line-editing (arrow keys,
 *     backspace, history, tab completion) still works for each content line.
 *   - The `> ` continuation prompt visually signals heredoc mode.
 */
export declare class HeredocHandler {
    private shell;
    private terminal;
    private vfs;
    private originalExecuteLine;
    private originalPrintPrompt;
    private originalHandleInput;
    private active;
    private heredocInfo;
    private lines;
    private historyLengthAtStart;
    /** Safety limit to prevent unbounded memory growth */
    private static readonly MAX_HEREDOC_LINES;
    constructor(shell: any, terminal: any, vfs: any);
    /**
     * Install the heredoc handler on a Shell instance.
     * Call once after the Shell is created.
     */
    static install(shell: any, terminal: any, vfs: any): HeredocHandler;
    /** Cancel heredoc accumulation and return to normal shell prompt. */
    private _cancel;
    private _patch;
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
}
/**
 * BUG-SWEEP-2 (2026-05-11): @lifo-sh/core ≥0.5.5's shell parser does
 * not support fd-to-fd redirects (`2>&1`, `>&2`, `<&0`). Encountering
 * one raises `Expected Word but got Amp ('&')` from the parser and
 * the whole pipeline fails.
 *
 * Real-world impact:
 *   - `pip install foo 2>&1 | tail -5`  → parse error
 *   - `cmd 2>&1` (standard "merge stderr into stdout") → parse error
 *   - `echo error >&2` ("write to stderr")             → parse error
 *
 * In Nimbus's execution model, stdout AND stderr both stream to the
 * same terminal frame buffer (see WebSocketTerminal). `2>&1` is
 * therefore a no-op (stderr is already on the same sink as stdout)
 * and `>&2` is functionally the same as no-redirect. We rewrite both
 * to empty so the parser sees a clean command line.
 *
 * What this DOES NOT solve:
 *   - `cmd 2>/path/to/file`  — file-redirect of stderr. NOT supported
 *     downstream either (lifo-sh's parser accepts `2>file` but the
 *     interpreter at executeSimpleCommand only honours stdout
 *     redirection via vfs.writeFile). Out of scope; flag as docs gap.
 *   - `cmd > /dev/null`      — /dev/null missing on prod. Separate fix.
 *
 * Install AFTER HeredocHandler so heredoc accumulation isn't disturbed
 * (we only run when executeLine fires on a complete line).
 */
export declare class FdRedirectNormalizer {
    private shell;
    constructor(shell: any);
    /** Install on a Shell instance. Idempotent. */
    static install(shell: any): FdRedirectNormalizer;
    private _patch;
    /**
     * Strip fd-to-fd redirects from a shell line. Preserves single-
     * quoted substrings verbatim (user-intended literals are safe).
     *
     * Returns the rewritten line.
     */
    static normalize(line: string): string;
}
/**
 * shell compatibility (2026-05-11): @lifo-sh/core's parser doesn't support
 * subshell grouping `(cmd1; cmd2)`. Pre-fix `(echo a; echo b)` raised
 * `unexpected token '('`. Common shell idioms (`(cd /x && cmd)` for
 * cd-scoped execution, pipeline grouping `(a; b) | c`) all failed.
 *
 * In bash, `(cmd1; cmd2)` runs in a subshell — its `cd`/var/env
 * changes do NOT affect the parent. We approximate by:
 *   1. Strip the outer `(...)` parens.
 *   2. Save cwd + env before running.
 *   3. Run the inner sequence.
 *   4. Restore cwd + env.
 *
 * Approximation gap: pipe-to-group `(a; b) | c` we currently
 * concatenate the group into a `{ a; b ; }` brace-group inline and
 * let lifo-sh handle the pipe — but lifo-sh also doesn't support
 * brace-groups. So we rewrite `(a; b) | c` to `a; b | c` which is
 * NOT the same semantically (only b's output pipes). Pipe-after-
 * group is documented as a remaining gap.
 *
 * Bare subshells `(a; b)` are fully supported via the cwd/env
 * save-restore pattern.
 */
export declare class SubshellNormalizer {
    private shell;
    constructor(shell: any);
    static install(shell: any): SubshellNormalizer;
    private _patch;
    /**
     * Find top-level `(...)` groups. Quote-aware: skip parens inside
     * 'single' or "double" or `backtick` strings. Returns array of
     * `{start, end}` indices (start = opening paren, end = closing).
     */
    static findTopLevelGroups(line: string): {
        start: number;
        end: number;
    }[];
}
/**
 * shell compatibility (2026-05-11): @lifo-sh/core doesn't expand
 * `{a,b,c}` brace expressions. Pre-fix `ls /x/*.{js,ts}` returned
 * nothing because the literal `*.{js,ts}` doesn't match a glob shape.
 *
 * Bash semantics: brace expansion runs BEFORE filename expansion.
 *   echo a{1,2,3}b     → a1b a2b a3b
 *   ls *.{js,ts}       → expanded to two glob patterns, both fed to ls
 *
 * We implement the comma-list form (bash {1..5} sequence form is a
 * separate feature; we skip it here as lower-impact).
 */
export declare class BraceExpander {
    private shell;
    constructor(shell: any);
    static install(shell: any): BraceExpander;
    private _patch;
    /**
     * Expand bash-style brace lists in a shell line. Quote-aware:
     * literals inside single quotes are preserved verbatim. `${var}`
     * parameter expansions are skipped (they don't contain commas
     * at the top level of the braces).
     *
     * Strategy: tokenize on whitespace (preserving quoted tokens),
     * expand each token, re-join with spaces.
     */
    static expandBraces(line: string): string;
}
/**
 * shell compatibility (2026-05-11): @lifo-sh/core doesn't expand `$$`
 * (PID) or `$0` (shell name). Pre-fix `echo $$` printed literal `$$`
 * and `echo $0` printed empty. Common in shell scripts (PID for
 * lockfiles, $0 for script-name-aware behaviour).
 *
 * Fix: rewrite `$$` → a stable per-session PID (we use the supervisor
 * DO's spawn-counter so it's deterministic per session) and `$0` →
 * the shell name (always `nimbus-sh`).
 *
 * NOT addressed: `$1`..`$9` positional params (only meaningful inside
 * scripts/functions which lifo-sh handles already), `$#`, `$?` (real
 * `$?` works through lifo-sh's lastExitCode env), `$@`, `$*`.
 */
export declare class DollarVarShim {
    private shell;
    private pid;
    constructor(shell: any);
    static install(shell: any): DollarVarShim;
    private _patch;
    /**
     * Expand `$$` and `$0` in a shell line. Quote-aware: literals
     * inside single quotes preserved. Double-quoted strings: variables
     * DO expand (bash semantics).
     */
    static expandDollarVars(line: string, pid: number): string;
}
/**
 * shell compatibility (2026-05-11): lifo-sh's HeredocHandler accumulates
 * lines verbatim — `$X` references inside an unquoted-delimiter
 * heredoc don't expand. Bash semantics:
 *   cat <<EOF       → variables expand
 *   cat <<'EOF'     → no expansion (single-quoted delim)
 *
 * Our HeredocHandler installation already lives in features.ts but
 * doesn't expand vars. We patch the accumulated content at submit
 * time: substitute `$NAME` / `${NAME}` with env values when the
 * delimiter is NOT single-quoted.
 *
 * The patch wraps shell.execute()'s string-content stage. We can't
 * easily intercept the heredoc submit from outside the handler, so
 * we attach a post-build hook that consults shell.env.
 *
 * Decision: rather than patching HeredocHandler (a class we own —
 * src/shell/features.ts:HeredocHandler), expose a public
 * `expandHeredocVars(content, env)` and call it from inside
 * HeredocHandler._accumulateLine / submit logic.
 */
export declare function expandHeredocVars(content: string, env: Record<string, string>): string;
/**
 * shell compatibility (2026-05-11): backtick `` `cmd` `` command
 * substitution. Pre-fix `echo \`date +%Y\`` printed literal
 * '`date +%Y`'. `$(cmd)` form worked; backtick form didn't.
 *
 * bash supports both. Many real-world scripts use backticks.
 *
 * Approach: rewrite top-level backtick spans into `$(...)` form
 * before lifo-sh's parser sees the line. Quote-aware:
 *   - inside single quotes, backticks are literal (preserve)
 *   - inside double quotes, backticks DO expand (rewrite)
 *   - inside backticks, escapes \\\` and \\\$ should be honored (we
 *     handle the simple case; nested backticks aren't supported)
 */
export declare class BacktickNormalizer {
    private shell;
    constructor(shell: any);
    static install(shell: any): BacktickNormalizer;
    private _patch;
    /**
     * Rewrite `cmd` → $(cmd). Quote-aware: single-quotes preserve
     * literal backticks; double-quotes pass through and rewrite inside.
     */
    static rewrite(line: string): string;
}
/**
 * LineEditorExtender — adds bash-readline-parity keybindings to the
 * @lifo-sh/core Shell line editor.
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
    constructor(shell: any, terminal: any);
    static install(shell: any, terminal: any): LineEditorExtender;
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
export interface ShellExecContext {
    env: Record<string, string>;
    cwd: string;
    vfs: SqliteVFS;
    /** Execute a single command — returns exit code */
    runCommand: (cmd: string, args: string[], stdin?: string) => Promise<{
        exitCode: number;
        stdout: string;
    }>;
    /** Write to terminal */
    writeStdout: (data: string) => void;
    writeStderr: (data: string) => void;
}
/**
 * Execute a full command line with pipes, redirects, operators, var expansion, and globs.
 * Returns the exit code of the last command.
 */
export declare function executeCommandLine(input: string, ctx: ShellExecContext): Promise<number>;
export {};
//# sourceMappingURL=features.d.ts.map