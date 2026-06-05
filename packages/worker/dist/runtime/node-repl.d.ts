/**
 * node-repl.ts — Node REPL adapter.
 *
 * Node is native (workerd nodejs_compat). Pattern mirrors bun-repl.ts:
 * a long-lived child-facet holds a vm.Context across submits.
 *
 * We do NOT use `node:repl` directly. Although workerd's nodejs_compat
 * exposes node:repl, it expects a terminal stream interface (stdin/
 * stdout) that the facet doesn't have — and trying to attach a
 * Duplex stream to a Worker isolate is a bigger surgery than worth.
 * Instead we replicate the core repl behaviours:
 *   - `> ` primary prompt, `... ` continuation
 *   - util.inspect of expression values (displayhook)
 *   - SyntaxError recoverable-detection for multi-line input
 *   - process.exit(code) propagation
 *   - .exit / .help / .clear dotted commands
 *
 * NOT supported in v1 (deferred):
 *   - REPL_MODE_STRICT switch
 *   - Top-level await at the prompt
 *   - Tab-completion
 *   - History pickling
 */
import type { FacetManager } from '../facets/manager.js';
import type { WebSocketTerminal } from '../facets/ws-terminal.js';
export interface NodeReplDeps {
    facetMgr: FacetManager;
    terminal: WebSocketTerminal;
}
/**
 * Top-level wrapper: builds a Node REPL adapter, drives a ReplSession
 * to completion, returns the exit code. Called from the node factory's
 * wrapper in init.ts when `node` is invoked with no args.
 */
export declare function runNodeRepl(deps: NodeReplDeps): Promise<number>;
//# sourceMappingURL=node-repl.d.ts.map