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
 * `> ` and `... ` prompts (the terminal echoes what is typed), each line's
 * value through the runtime's util.inspect (`undefined` for a statement),
 * and a thrown value as `Uncaught <name>: <message>`. `.exit`, `.break` (`.clear`) and
 * `.help` are its commands; Ctrl-D ends it.
 */
/** The REPL program, opening with `banner`. */
export function jsReplProgram(banner) {
    return `"use strict";
const __replUtil = require("node:util");
const __replService = globalThis.__nimbusRuntimeCode;
// Node's REPL has the require of its working directory as a global.
globalThis.require = require;
const __replHelp = ".break    Sometimes you get stuck, this gets you out\\n"
  + ".clear    Alias for .break\\n"
  + ".exit     Exit the REPL\\n"
  + ".help     Print this help message\\n\\n"
  + "Press Ctrl+C to abort current expression, Ctrl+D to exit the REPL\\n";
let __replPending = "";
let __replInput = "";
let __replQueue = Promise.resolve();
const __replOut = (text) => process.stdout.write(text);
const __replPrompt = () => __replOut(__replPending === "" ? "> " : "... ");
const __replUncaught = (error) => "Uncaught " + (error instanceof Error
  ? (error.name || "Error") + ": " + error.message
  : __replUtil.inspect(error)) + "\\n";
// A line Node reads as a command: a dot, then not a dot and not a number.
const __replCommand = (line) => {
  const text = line.trim();
  return text.charAt(0) === "." && text.charAt(1) !== "." && Number.isNaN(Number.parseFloat(text)) ? text.slice(1).split(/\\s+/)[0] : null;
};
async function __replLine(line) {
  const command = __replPending === "" ? __replCommand(line) : null;
  if (command !== null) {
    if (command === "exit") process.exit(0);
    if (command === "help") __replOut(__replHelp);
    else if (command !== "break" && command !== "clear") __replOut("Invalid REPL keyword\\n");
    __replPending = "";
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
    __replOut(__replUncaught(error));
    __replPrompt();
    return;
  }
  if (run === null) {
    __replPending = code;
    __replPrompt();
    return;
  }
  __replPending = "";
  try {
    const result = await Reflect.apply(run, globalThis, []);
    __replOut(String(__replUtil.inspect(result === undefined ? undefined : result.value)) + "\\n");
  } catch (error) {
    __replOut(__replUncaught(error));
  }
  __replPrompt();
}
__replOut(${JSON.stringify(banner)});
__replPrompt();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  __replInput += chunk;
  for (let at = __replInput.indexOf("\\n"); at >= 0; at = __replInput.indexOf("\\n")) {
    const line = __replInput.slice(0, at).replace(/\\r$/, "");
    __replInput = __replInput.slice(at + 1);
    __replQueue = __replQueue.then(() => __replLine(line));
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
