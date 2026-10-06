/**
 * js-repl.ts — the JavaScript REPL shared by `node` and `bun`.
 *
 * Both run on workerd's V8 (`nodejs_compat`); `bun` adds the Bun shim
 * (bun-runner.ts BUN_SHIM_PREAMBLE). A long-lived child facet evaluates each
 * line, so the two differ only in what a {@link JsReplFlavor} names: the
 * banner, the dotted-command texts and the facet's preamble.
 *
 * We do NOT use `node:repl` (it wants a terminal stream the facet does not
 * have) or `node:vm` (a non-functional stub in workerd). The core repl
 * behaviours are replicated instead:
 *   - `> ` primary prompt, `... ` continuation
 *   - util.inspect of expression values (displayhook), thenables awaited
 *   - SyntaxError recoverable-detection for multi-line input
 *   - process.exit(code) propagation
 *   - .exit / .help / .clear dotted commands
 *
 * NOT supported (deferred): REPL_MODE_STRICT, top-level await at the
 * prompt, Ctrl-C mid-execution, tab-completion, history pickling.
 */
import type { WebSocketTerminal } from '../facets/ws-terminal.js';
import type { FacetManager } from '../facets/manager.js';
import { type ReplFacetResult } from './repl-session.js';
export interface JsReplDeps {
    facetMgr: FacetManager;
    terminal: WebSocketTerminal;
}
/** What one JavaScript runtime's REPL says and loads; the protocol is shared. */
export interface JsReplFlavor {
    /**
     * The command: names the facet pool (`<name>-repl`), the diagnostics'
     * prefix, the facet's REPL state on its globalThis, and the `-e` advice.
     */
    name: 'node' | 'bun';
    banner: string;
    /** `.help`'s text. */
    help: string;
    /** What `.clear` prints. */
    cleared: string;
    /** Evaluated in the facet before the first line (the Bun shim; none for node). */
    preamble: string;
}
export interface JsReplStep {
    name: JsReplFlavor['name'];
    mode: 'init' | 'push';
    source?: string;
}
/**
 * Facet-side function. Self-contained — serialized via fn.toString()
 * across the LOADER boundary; no closure captures, no class refs, no bare
 * receiver keyword (the serializer rejects it).
 *
 * Modes:
 *   - 'init': install console capture and a process.exit sentinel.
 *   - 'push': try expression-mode eval; fall back to statement-mode;
 *     util.inspect non-undefined result; surface process.exit sentinel.
 */
export declare function jsReplStepFacetFn(args: JsReplStep): Promise<ReplFacetResult>;
/** Drive a `flavor` REPL on the terminal to completion; returns the exit code. */
export declare function runJsRepl(flavor: JsReplFlavor, deps: JsReplDeps): Promise<number>;
//# sourceMappingURL=js-repl.d.ts.map