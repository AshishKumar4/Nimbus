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
export declare function jsReplProgram(banner: string): string;
//# sourceMappingURL=js-repl.d.ts.map