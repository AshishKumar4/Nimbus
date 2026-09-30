/**
 * Whether running a program starts a server, judged from its code before it
 * runs.
 *
 * A port is reachable only from a resident process (node-runner.ts runFresh),
 * and that has to be chosen before the program runs; a program that finishes
 * in a resident process is never reported ended. So the question is not
 * whether a server appears somewhere in the text, but whether the code this
 * invocation runs reaches one. The program is parsed and walked the way it
 * runs:
 *
 * - Top-level statements run in order. A branch runs unless its condition is
 *   known to be false for this invocation: `process.argv` and values derived
 *   from it are known, as is `require.main === module` (true for the entry,
 *   false for a module it loads); anything else may go either way. Code after
 *   `return`, `throw` or `process.exit()` does not run.
 * - An argument decides only where the program branches on it: its own
 *   `process.argv` tests, and a CLI parser's (commander, yargs, sade, cac).
 *   A parser's handlers (`.action(fn)`, `.command('serve').action(fn)`,
 *   yargs' `.command({ command: 'serve', handler })`) are recorded where they
 *   are registered and run only when it parses (`.parse()`, `.argv`): not at
 *   all when argv holds `--help`/`--version`, which it answers and exits on,
 *   and for a command only when argv names it. A parser is known through
 *   ESM interop (`__toESM(require('commander'))`) as through `require`.
 * - A function runs when it is called, constructed, invoked immediately, or
 *   handed to a call as a callback (a listener, `.then`, a CLI's action or a
 *   command's `handler`); not when it is only defined or exported. Logging a
 *   value does not call it.
 * - A server starts at a call of `createServer`, `createSecureServer` or
 *   `serve` (http, https, http2, net, Bun.serve, ...), however it was named (a
 *   destructured or aliased creator, `const make = http.createServer`,
 *   counts), and at a `.listen(...)` of anything but the program's own code,
 *   unless its first argument is provably not a port: a callback, `this`, or
 *   a socket path (a string that is not a number, constants resolved).
 * - Loading one of the program's own modules runs its top level. Using what
 *   it exports (calling, constructing, calling a method of, or handing it to a
 *   call) runs that export: the function exported under that name, a method
 *   of the exported class, or what it re-exports from a further module
 *   (`module.exports = require('./server')`, `export { x } from './server'`).
 *
 * The program's own modules are those inside the entry's package. They are
 * read lazily, only when the walk reaches them, within a bound on how many
 * and how large; a source past it, or one the parser cannot read, starts
 * nothing.
 */
/** How large a module may be to be walked: parsing costs about 50 ms a MiB. */
export declare const SERVER_LAUNCH_MODULE_BYTES: number;
/** How the analysis reads the program's modules: the command's own view. */
export interface ServerLaunchHost {
    /** A relative specifier from `dir`, resolved to a VFS key, or null. */
    resolve(dir: string, specifier: string): Promise<string | null>;
    /** A module's source, or null when it cannot be read. */
    read(path: string): Promise<string | null>;
}
export interface ServerLaunchProgram {
    /** The entry's code, as it will run (after any TypeScript/ESM transform). */
    source: string;
    /** The entry's VFS key; null for `-e` and stdin programs. */
    path: string | null;
    /** The directory its relative modules resolve from. */
    dir: string;
    /** Modules outside this directory are not the program's own. */
    packageRoot: string;
    /** `process.argv` as the program sees it: [execPath, script?, ...args]. */
    argv: readonly string[];
}
/** Whether running `program` starts a server. */
export declare function programLaunchesServer(program: ServerLaunchProgram, host: ServerLaunchHost): Promise<boolean>;
/**
 * The modules a parsed module (`path`, relative ones resolving from `dir`)
 * loads by a static specifier (require, import, export ... from, import()):
 * each relative specifier to its VFS key when it is the program's own code
 * (inside `packageRoot`, not a data file), else to null.
 */
export declare function resolveOwnModules(ast: {
    type: string;
}, path: string | null, dir: string, packageRoot: string, host: ServerLaunchHost): Promise<Map<string, string | null>>;
//# sourceMappingURL=server-launch.d.ts.map