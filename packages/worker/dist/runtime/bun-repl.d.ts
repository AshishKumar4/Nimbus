/**
 * bun-repl.ts — `bun` with no arguments: the shared JavaScript REPL
 * (js-repl.ts) with the Bun shim (bun-runner.ts) preloaded in its facet, so
 * `Bun.*` is there as in real Bun.
 */
import { type JsReplDeps } from './js-repl.js';
/** Run the Bun REPL to completion; returns its exit code (hosted `bun` with no args). */
export declare function runBunRepl(deps: JsReplDeps): Promise<number>;
//# sourceMappingURL=bun-repl.d.ts.map