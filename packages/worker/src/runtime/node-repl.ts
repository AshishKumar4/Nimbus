/**
 * node-repl.ts — `node` with no arguments: the shared JavaScript REPL
 * (js-repl.ts) over workerd's `nodejs_compat`, with nothing preloaded.
 */

import { NODE_VERSION } from '@nimbus-sh/core/constants.js';
import { runJsRepl, type JsReplDeps, type JsReplFlavor } from './js-repl.js';

const NODE_REPL: JsReplFlavor = {
  name: 'node',
  banner:
    `Node.js ${NODE_VERSION} compatibility layer (Nimbus, over Cloudflare workerd)\r\n` +
    'This is not Node.js itself. It is the workerd `nodejs_compat` API\r\n' +
    "surface on top of V8. workerd's CSP blocks runtime eval/new-Function,\r\n" +
    'so the REPL cannot persist `var`/`let`/`const` across lines.\r\n' +
    '`console.log` and side-effect calls work per line. For stateful work,\r\n' +
    'run a script:  `node -e "<code>"`   or   `node script.js`\r\n' +
    'Type ".help" for more information.\r\n',
  help:
    '.exit    Exit the REPL\r\n' +
    '.help    Print this help\r\n' +
    '.clear   Reset context\r\n',
  cleared: 'Clearing context...\r\n',
  preamble: '',
};

/** Run the Node REPL to completion; returns its exit code (hosted `node` with no args). */
export async function runNodeRepl(deps: JsReplDeps): Promise<number> {
  return await runJsRepl(NODE_REPL, deps);
}
