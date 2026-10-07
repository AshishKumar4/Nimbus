/**
 * js-repl.ts — the program `node` and `bun` run with no script at a terminal:
 * their REPL, as Node's own is a program its runtime runs (lib/repl.js).
 *
 * It runs as any program of the runtime does, its stdin the terminal's lines
 * (runtime-registry.ts), so what a line reaches is what a script's code
 * reaches: `require` from the working directory, the session's filesystem,
 * `process.exit`, the console. A line is compiled the way code a program
 * produces after its launch is (core/_shared/commonjs-cell.ts, RUNTIME CODE):
 * the runtime-code service's compileReplLine makes it an async function
 * (interpreter/repl-line.ts), from this launch's module map when an earlier
 * launch staged it, else interpreted. So top-level `await` works, and a
 * line's declarations are there for the next.
 *
 * What it prints follows Node's REPL with a stream that is not a terminal:
 *   - `> ` and `... ` prompts (the terminal echoes what is typed);
 *   - each line's value through the runtime's util.inspect (`undefined` for
 *     a statement), kept as `_`; a thrown value as `Uncaught <error>`, kept
 *     as `_error`, and so are a rejection no one handles and an exception
 *     a timer throws, after which the prompt comes back;
 *   - `.break`, `.clear`, `.exit` and `.help`, which act even while a block
 *     is pending; `.editor`, `.load` and `.save` are not supported;
 *   - `import()` resolves as from a module named `repl` in the working
 *     directory;
 *   - Ctrl-C, which the terminal delivers as input here (its signal keys
 *     are off while the REPL runs): it abandons a line still running or a
 *     pending block, and a second in a row on an empty prompt exits, as
 *     Ctrl-D does.
 */
import { REPL_IMPORT } from './js-repl-names.js';
/** The REPL program, opening with `banner`. */
export function jsReplProgram(banner) {
    return `"use strict";
const __replUtil = require("node:util");
const __replService = globalThis.__nimbusRuntimeCode;
// Node's REPL has the require of its working directory as a global.
globalThis.require = require;
const __replParent = require("node:url").pathToFileURL(require("node:path").join(process.cwd(), "repl")).href;
Object.defineProperty(globalThis, ${JSON.stringify(REPL_IMPORT)}, {
  value: (specifier, options) => globalThis.__nimbusDynamicImport(__replParent, specifier, options),
});
const __replHelp = ".break    Sometimes you get stuck, this gets you out\\n"
  + ".clear    Alias for .break\\n"
  + ".exit     Exit the REPL\\n"
  + ".help     Print this help message\\n\\n"
  + "Press Ctrl+C to abort current expression, Ctrl+D to exit the REPL\\n";
let __replPending = "";
let __replInput = "";
let __replQueue = Promise.resolve();
// The line now running: its interrupt, or null.
let __replRunning = null;
let __replSawInterrupt = false;
const __replOut = (text) => process.stdout.write(text);
const __replPrompt = () => __replOut(__replPending === "" ? "> " : "... ");
// _ and _error, as Node's REPL keeps them: assigning one stops the REPL's own updates.
let __replLast;
let __replLastError;
let __replOwnLast = true;
let __replOwnLastError = true;
Object.defineProperty(globalThis, "_", {
  configurable: true,
  get: () => __replLast,
  set: (value) => {
    __replLast = value;
    if (__replOwnLast) { __replOwnLast = false; __replOut("Expression assignment to _ now disabled.\\n"); }
  },
});
Object.defineProperty(globalThis, "_error", {
  configurable: true,
  get: () => __replLastError,
  set: (value) => {
    __replLastError = value;
    if (__replOwnLastError) { __replOwnLastError = false; __replOut("Expression assignment to _error now disabled.\\n"); }
  },
});
const __replDescribe = (error) => {
  if (!(error instanceof Error)) return String(__replUtil.inspect(error));
  const head = typeof error.stack === "string" ? error.stack.split("\\n")[0] : "";
  return head !== "" ? head : (error.name || "Error") + ": " + error.message;
};
const __replUncaught = (error) => {
  if (__replOwnLastError) __replLastError = error;
  __replOut("Uncaught " + __replDescribe(error) + "\\n");
};
// What no line awaits: reported, and the REPL goes on.
process.on("unhandledRejection", (reason) => { __replUncaught(reason); __replPrompt(); });
process.on("uncaughtException", (error) => { __replUncaught(error); __replPrompt(); });
// A line Node reads as a command: a dot, then not a dot and not a number.
const __replCommand = (line) => {
  const text = line.trim();
  return text.charAt(0) === "." && text.charAt(1) !== "." && Number.isNaN(Number.parseFloat(text)) ? text.slice(1).split(/\\s+/)[0] : null;
};
async function __replLine(line) {
  __replSawInterrupt = false;
  const command = __replCommand(line);
  if (command === "exit") process.exit(0);
  if (command === "break" || command === "clear" || command === "help") {
    if (command === "help") __replOut(__replHelp);
    else __replPending = "";
    __replPrompt();
    return;
  }
  // An unknown command is an error only where it cannot be code: on a fresh line.
  if (command !== null && __replPending === "") {
    __replOut("Invalid REPL keyword\\n");
    __replPrompt();
    return;
  }
  if (__replPending === "" && line.trim() === "") {
    __replPrompt();
    return;
  }
  const code = __replPending + line + "\\n";
  let run;
  try {
    run = __replService.compileReplLine(code);
  } catch (error) {
    __replPending = "";
    __replUncaught(error);
    __replPrompt();
    return;
  }
  if (run === null) {
    __replPending = code;
    __replPrompt();
    return;
  }
  __replPending = "";
  const running = Reflect.apply(run, globalThis, []);
  const interrupted = new Promise((_resolve, reject) => {
    __replRunning = () => {
      // The line goes on unawaited: what it ends with is no one's now.
      running.catch(() => {});
      const error = new Error("Script execution was interrupted by \`SIGINT\`");
      error.code = "ERR_SCRIPT_EXECUTION_INTERRUPTED";
      error.stack = "Error [ERR_SCRIPT_EXECUTION_INTERRUPTED]: " + error.message;
      reject(error);
    };
  });
  try {
    const result = await Promise.race([running, interrupted]);
    const value = result === undefined ? undefined : result.value;
    if (__replOwnLast) __replLast = value;
    __replOut(String(__replUtil.inspect(value)) + "\\n");
  } catch (error) {
    __replUncaught(error);
  } finally {
    __replRunning = null;
  }
  __replPrompt();
}
// Ctrl-C: the line running, else the pending block, else a first warning.
function __replInterrupt() {
  __replInput = "";
  if (__replRunning !== null) {
    __replRunning();
    return;
  }
  if (__replPending !== "") {
    __replPending = "";
    __replPrompt();
    return;
  }
  if (__replSawInterrupt) process.exit(0);
  __replSawInterrupt = true;
  __replOut("(To exit, press Ctrl+C again or Ctrl+D or type .exit)\\n");
  __replPrompt();
}
function __replTake(text) {
  __replInput += text;
  for (let at = __replInput.indexOf("\\n"); at >= 0; at = __replInput.indexOf("\\n")) {
    const line = __replInput.slice(0, at).replace(/\\r$/, "");
    __replInput = __replInput.slice(at + 1);
    __replQueue = __replQueue.then(() => __replLine(line));
  }
}
__replOut(${JSON.stringify(banner)});
__replPrompt();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const parts = String(chunk).split("\\x03");
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) __replInterrupt();
    __replTake(parts[i]);
  }
});
process.stdin.on("end", () => {
  __replQueue = __replQueue.then(() => {
    __replOut("\\n");
    process.exit(0);
  });
});
`;
}
