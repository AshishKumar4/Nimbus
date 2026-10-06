/**
 * bun-repl.ts — `bun` with no arguments: the shared JavaScript REPL
 * (js-repl.ts) with the Bun shim (bun-runner.ts) preloaded in its facet, so
 * `Bun.*` is there as in real Bun.
 */
import { BUN_SHIM_PREAMBLE, BUN_VERSION } from './bun-runner.js';
import { runJsRepl } from './js-repl.js';
const BUN_REPL = {
    name: 'bun',
    banner: `Bun ${BUN_VERSION} emulation (Nimbus, over Cloudflare workerd)\r\n` +
        'This is not Bun itself. It is a Bun-compatible API surface on top of\r\n' +
        "workerd's V8. workerd's CSP blocks runtime eval/new-Function, so the\r\n" +
        'REPL cannot persist `var`/`let`/`const` across lines. `console.log` and\r\n' +
        'side-effect calls work per line. For stateful work, run a script:\r\n' +
        '  `bun -e "<code>"`   or   `bun script.ts`\r\n' +
        'Type ".exit" or press Ctrl-D to exit.\r\n',
    help: '.exit  Exit the REPL\r\n.help  Print this help\r\n.clear Reset context\r\n',
    cleared: 'Context cleared.\r\n',
    preamble: BUN_SHIM_PREAMBLE,
};
/** Run the Bun REPL to completion; returns its exit code (hosted `bun` with no args). */
export async function runBunRepl(deps) {
    return await runJsRepl(BUN_REPL, deps);
}
