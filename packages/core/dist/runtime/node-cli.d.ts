/**
 * node's command line, read as Node reads it (src/node_options.cc): the
 * options before the program, each taking its value from `--name=value` or
 * from the next argument when Node's own table says it takes one
 * (node-cli-options.generated.ts), `--` ending them; and NODE_OPTIONS,
 * split as Node splits it (double quotes group, a backslash escapes inside
 * them) and holding only the options Node allows there.
 *
 * What Nimbus's node takes from them: the program's own conditions
 * (`--conditions`, `-C`), for the exports and imports resolvers, and the
 * options as `process.execArgv` holds them (the command line's; Node keeps
 * NODE_OPTIONS' out of it). An option Node does not know is passed over on
 * the command line (V8's own flags are many, and the runtime has none of
 * them); in NODE_OPTIONS it is refused as Node refuses it.
 */
/** What node's command line says, for the program it runs. */
export interface NodeCommandLine {
    /** The options before the program, as `process.execArgv` holds them. */
    execArgv: string[];
    /** Where the program is in the arguments: its script (or `-`), or their end when there is none. */
    programIndex: number;
    /** The program's own conditions: NODE_OPTIONS' first, then the command line's. */
    conditions: string[];
}
/** A command line Node refuses: what it prints, and its exit code (9, Node's for a bad option). */
export interface NodeCommandLineError {
    error: string;
    exitCode: 9;
}
/** process.allowedNodeEnvironmentFlags.has, as Node answers it: `_` for `-`, a `--no-` prefix and an `=value` aside. */
export declare function allowedInNodeOptions(option: string): boolean;
/** NODE_OPTIONS split as Node splits it (ParseNodeOptionsEnvVar): spaces part, double quotes group, `\` escapes inside them. */
export declare function splitNodeOptions(text: string): string[] | NodeCommandLineError;
/** node's `args` (after `node` itself) and its NODE_OPTIONS, read as Node reads them. */
export declare function parseNodeCommandLine(args: readonly string[], nodeOptions?: string): NodeCommandLine | NodeCommandLineError;
//# sourceMappingURL=node-cli.d.ts.map