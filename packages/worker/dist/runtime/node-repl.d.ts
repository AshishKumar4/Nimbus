/**
 * node-repl.ts — `node` with no arguments: the shared JavaScript REPL
 * (js-repl.ts) over workerd's `nodejs_compat`, with nothing preloaded.
 */
import { type JsReplDeps } from './js-repl.js';
/** Run the Node REPL to completion; returns its exit code (hosted `node` with no args). */
export declare function runNodeRepl(deps: JsReplDeps): Promise<number>;
//# sourceMappingURL=node-repl.d.ts.map