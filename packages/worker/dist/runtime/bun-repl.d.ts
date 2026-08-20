/**
 * bun-repl.ts — Bun REPL adapter.
 *
 * Bun is native (workerd nodejs_compat) — no facet-bootstrap like
 * Pyodide. We dispatch eval through a long-lived child-facet that
 * holds a vm.Context across submits, so user-defined variables /
 * functions / imports persist.
 *
 * Design:
 *   - One child-facet per REPL session (IsolatePool with
 *     concurrency=1, omitSupervisor=true).
 *   - Facet-side: globalThis.__nimbus_bun_ctx caches a vm.createContext()
 *     dict; each push() runs vm.runInContext(line, ctx) and returns
 *     {stdout, stderr, isIncomplete, isExit}.
 *   - Continuation detection: probe parse via `new Function(...code)`
 *     wrapped in try/catch — recoverable SyntaxError patterns
 *     (per Node's repl.Recoverable shape) → incomplete.
 *   - Expression displayhook: vm.runInContext returns the last
 *     expression value; if !== undefined, util.inspect(value) → stdout.
 *   - Exit: override process.exit inside the context to throw a
 *     sentinel; catch sentinel → kind:'exit'.
 *
 * NOT supported in v1 (deferred):
 *   - Top-level await at the REPL prompt (Bun supports this natively
 *     but vm.runInContext doesn't unwrap top-level await — would need
 *     vm.SourceTextModule or evaluation pre-wrap).
 *   - Ctrl-C mid-execution (no SIGINT plumbing across facet boundary).
 *   - Tab-completion.
 *
 * No setTimeout / sleep / retry / defensive-catch on hot paths. Errors
 * thrown by vm bubble up; we surface them as stderr via the runtime
 * stderr capture.
 */
import type { FacetManager } from '../facets/manager.js';
import type { WebSocketTerminal } from '../facets/ws-terminal.js';
export interface BunReplDeps {
    facetMgr: FacetManager;
    terminal: WebSocketTerminal;
}
/**
 * Top-level wrapper: builds a Bun REPL adapter, drives a ReplSession
 * to completion, returns the exit code. Called from the bun factory's
 * wrapper in init.ts when `bun` is invoked with no args.
 */
export declare function runBunRepl(deps: BunReplDeps): Promise<number>;
//# sourceMappingURL=bun-repl.d.ts.map