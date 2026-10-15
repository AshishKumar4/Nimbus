import type { NodeFilesystem } from '../../node-compat/filesystem.js';
import type { Command } from '../types.js';
import { type PackageType } from '../../../../runtime/module-format.js';
import { type ProcessIdentity } from '../../node-compat/process.js';
import { type StandardInput } from '../../node-compat/standard-streams.js';
import type { ProgramTerminal } from '../../node-compat/tty-streams.js';
import type { VirtualRequestHandler, Kernel, LoopbackRouter } from '../../kernel/index.js';
import type { DNSResolver } from '../../kernel/dns-resolver.js';
import type { CommandOutputStream } from '../types.js';
/** A program the inline node runs, and where it runs from. */
export interface NodeProgram {
    readonly source: string;
    /** Its absolute path, or `[eval]` for `-e`. */
    readonly filename: string;
    readonly scriptArgs: readonly string[];
    readonly cwd: string;
    readonly env: Record<string, string>;
    /** The main script's package type, from its package.json (a `.js` entry), decided before it runs. */
    readonly mainType: PackageType;
    /** Its process's pid and credential, as the invocation has them. */
    readonly identity: Omit<ProcessIdentity, 'setUmask'>;
}
/** What a run reaches outside its realm: the filesystem, its stdio, the session's ports. */
export interface NodeProgramHost {
    readonly filesystem: () => NodeFilesystem;
    readonly stdout: CommandOutputStream;
    readonly stderr: CommandOutputStream;
    /** fd 0, read to its end: blocks until stdin ends, as a synchronous read of it does in Node. */
    readonly stdin: () => Uint8Array;
    /** fd 0 a piece at a time (process.stdin). */
    readonly input: StandardInput;
    /** Which standard descriptor is the terminal, and its modes. */
    readonly terminal: ProgramTerminal;
    readonly portRegistry?: Map<number, VirtualRequestHandler>;
    readonly routeLoopback?: LoopbackRouter;
    readonly dns?: DNSResolver;
    /** umask(2): the mask the program creates with from now on. */
    readonly setUmask: (mask: number) => void;
}
/**
 * How a program's main script ended: its exit code, and whether its process
 * ended with it (process.exit(), or an error nothing caught), so that nothing
 * it left behind may run.
 */
export interface NodeProgramEnd {
    readonly code: number;
    readonly ended: boolean;
}
/**
 * Run `program` in the current realm, which is the program's own: its globals
 * (process, Buffer, console) are installed on
 * globalThis for good. Resolves once the main script has run (an ES module's
 * top-level await included). What it left (timers, servers, requests) runs on
 * in the realm's own event loop, which owns how long the process lives.
 */
export declare function runNodeProgram(program: NodeProgram, host: NodeProgramHost): Promise<NodeProgramEnd>;
export declare function createNodeCommand(kernel: Kernel): Command;
declare const command: Command;
export default command;
//# sourceMappingURL=node.d.ts.map