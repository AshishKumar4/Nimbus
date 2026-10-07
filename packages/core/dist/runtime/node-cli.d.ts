/**
 * node's command line, read as Node reads it (src/node_options.cc
 * OptionsParser::Parse), the one reading of it the runtime registry, the
 * runner and the shims take: the options before the program, each named as
 * Node's own table names it (node-cli-options.generated.ts, from host
 * Node's internal/options and `node --v8-options`), and NODE_OPTIONS beside
 * them, split as Node splits it.
 *
 * As Node takes them, in its order:
 *   - `--name=value` only for long options (`-C=x` is an option named
 *     `-C=x`), `_` read as `-` in a long option's name;
 *   - `--no-<name>` read as `<name>`, negated, before aliases expand, and
 *     refused unless the option is a boolean (or V8's);
 *   - aliases expanded (`-C` is `--conditions`, `-pe` is `--print --eval`,
 *     `-p <code>` is `--print --eval <code>`, `--experimental-permission` is
 *     `--permission`);
 *   - a value taken from `=`, else from the next argument, which may not
 *     start with `-` (a leading `\-` escapes one, and is dropped); an empty
 *     `--name=` is refused;
 *   - an option Node does not know goes to V8, which refuses one it does not
 *     know either ("bad option"), once Node's own options are read;
 *   - `--` ends the options, and is kept out of execArgv;
 *   - in NODE_OPTIONS, `--` and every option Node does not allow there are
 *     refused, and a bare word ends the options it is read for.
 * A refusal is Node's: its message (naming the option as it was typed) and
 * exit code 9.
 */
/** What a node program's run takes of its command line: its runner, its launch's walk and its process read it. */
export interface NodeLaunch {
    /** The options before the program, as `process.execArgv` holds them (the command line's; not NODE_OPTIONS'). */
    execArgv: string[];
    /** The program's own conditions: NODE_OPTIONS' first, then the command line's. */
    conditions: string[];
    /** `-r`/`--require`'s modules, NODE_OPTIONS' first: required from the working directory, in order, before the program. */
    require: string[];
    /** `--import`'s modules, NODE_OPTIONS' first: imported from the working directory, in order, after those and before the program. */
    import: string[];
    /** `-e`/`--eval`'s code (`process._eval`), when the program is one. */
    eval?: string;
    /** `-p`/`--print`: the eval's completion value is printed when the process exits. */
    print: boolean;
}
/** What node's command line says, for the program it runs. */
export interface NodeCommandLine extends NodeLaunch {
    /** Where the program's own arguments start: its script (or `-`), or, for `-e`, its arguments; their end when there are none. */
    programIndex: number;
    version: boolean;
    help: boolean;
}
/** A command line Node refuses: what it prints, and its exit code (9, Node's for a bad option). */
export interface NodeCommandLineError {
    error: string;
    exitCode: 9;
}
/** NODE_OPTIONS split as Node splits it (ParseNodeOptionsEnvVar): spaces part, double quotes group, `\` escapes inside them. */
export declare function splitNodeOptions(text: string): string[] | NodeCommandLineError;
/** node's `args` (after `node` itself) and its NODE_OPTIONS, read as Node reads them. */
export declare function parseNodeCommandLine(args: readonly string[], nodeOptions?: string): NodeCommandLine | NodeCommandLineError;
//# sourceMappingURL=node-cli.d.ts.map