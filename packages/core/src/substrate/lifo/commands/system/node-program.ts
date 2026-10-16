/**
 * A program the inline `node` runs, run in the realm that is its own: the
 * guest (node-guest.ts) runs it, the host's command (node.ts) starts the realm.
 */
import { Buffer } from 'node:buffer';
import realm from 'node:process';
import type { NodeFilesystem } from '../../node-compat/filesystem.js';
import { dirname } from '../../utils/path.js';
import { ProcessExitError } from '../../node-compat/index.js';
import { createCjsLoader, moduleWrapper, stripShebang } from '../../node-compat/cjs-loader.js';
import { isEsModuleFile, isEsModuleInput, type PackageType } from '../../../../runtime/module-format.js';
import type { NodeContext } from '../../node-compat/index.js';
import { createProcess, exitCodeOf, type LifoProcess, type ProcessIdentity } from '../../node-compat/process.js';
import { createConsole } from '../../node-compat/console.js';
import { createNativeEsmLoader } from '../../node-compat/native-esm-loader.js';
import { pathToFileURL } from '../../node-compat/file-url.js';
import { leaveStandardStreamsOpen, type FailableOutput, type StandardInput } from '../../node-compat/standard-streams.js';
import type { ProgramTerminal } from '../../node-compat/tty-streams.js';
import type { VirtualRequestHandler, LoopbackRouter } from '../../kernel/index.js';
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
	/** Its resolution conditions beside Node's own (`--conditions`, NODE_OPTIONS' first), for require and import alike. */
	readonly conditions: readonly string[];
	/** Its process's pid and credential, as the invocation has them. */
	readonly identity: Omit<ProcessIdentity, 'setUmask'>;
}

/** What a run reaches outside its realm: the filesystem, its stdio, the session's ports. */
export interface NodeProgramHost {
	readonly filesystem: () => NodeFilesystem;
	/** What its console, and the realm's own reports, write: a failure there is heard only by a listener on the stream. */
	readonly stdout: CommandOutputStream;
	readonly stderr: CommandOutputStream;
	/** What its process.stdout and process.stderr write: a failure there is the stream's error. */
	readonly stdoutStream: FailableOutput;
	readonly stderrStream: FailableOutput;
	/** fd 0, read to its end: blocks until stdin ends, as a synchronous read of it does in Node. */
	readonly stdin: () => Uint8Array;
	/** fd 0 a piece at a time (process.stdin). */
	readonly input: StandardInput;
	/** What its standard descriptors are, and the terminal's modes. */
	readonly terminal: ProgramTerminal;
	readonly portRegistry?: Map<number, VirtualRequestHandler>;
	readonly routeLoopback?: LoopbackRouter;
	readonly dns?: DNSResolver;
	/** umask(2): the mask the program creates with from now on. */
	readonly setUmask: (mask: number) => void;
	/** The program's process, once it is made: what an error nothing caught, or a failed write, reaches. */
	readonly started: (process: LifoProcess) => void;
}

/**
 * How a program's main script ended: its exit code, and whether its process
 * ended with it (process.exit(), or an error nothing caught), so that nothing
 * it left behind may run.
 */
export interface NodeProgramEnd {
	readonly code: number;
	readonly ended: boolean;
	/** The status its process ends with when its loop runs empty: its process.exitCode then. */
	readonly finalCode: () => number;
}

/**
 * Run `program` in the current realm, which is the program's own: its globals
 * (process, Buffer, console) are installed on
 * globalThis for good. Resolves once the main script has run (an ES module's
 * top-level await included). What it left (timers, servers, requests) runs on
 * in the realm's own event loop, which owns how long the process lives.
 */
export async function runNodeProgram(program: NodeProgram, host: NodeProgramHost): Promise<NodeProgramEnd> {
		const { source, filename, scriptArgs, mainType } = program;
		const filesystem = host.filesystem;
		const ctx = { stdout: host.stdout, stderr: host.stderr };
		const dir = filename === '[eval]' ? program.cwd : dirname(filename);
		const identity: ProcessIdentity = { ...program.identity, setUmask: host.setUmask };
		const nodeCtx: NodeContext = {
			filesystem,
			identity,
			cwd: program.cwd,
			env: program.env,
			stdout: host.stdout,
			stderr: host.stderr,
			argv: [filename, ...scriptArgs],
			filename,
			dirname: dir,
			signal: new AbortController().signal,
			portRegistry: host.portRegistry,
			routeLoopback: host.routeLoopback,
			dns: host.dns,
			stdin: host.stdin,
			stdio: { stdout: host.stdoutStream, stderr: host.stderrStream, env: program.env, input: host.input, terminal: host.terminal },
			reachStreams: leaveStandardStreamsOpen,
		};

		// One process and console, every module's, as in Node.
		const main = { process: createProcess({ argv: nodeCtx.argv, env: nodeCtx.env, cwd: nodeCtx.cwd, stdio: nodeCtx.stdio, identity }), console: createConsole(ctx.stdout, ctx.stderr), global: globalThis };
		host.started(main.process);
		const loader = createCjsLoader(nodeCtx, main, { conditions: program.conditions });

		// Execute main script
		const module = { exports: {} as Record<string, unknown> };
		const cleanMainSource = stripShebang(source);
		const isEsm = filename === '[eval]' ? isEsModuleInput(cleanMainSource, undefined) : isEsModuleFile(filename, cleanMainSource, () => mainType);
		// Capture the host's module API before replacing the program's globals.
		// Hooks supply VFS sources, but all ESM bindings and evaluation are native.
		let native: Awaited<ReturnType<typeof createNativeEsmLoader>>;
		try {
			native = await createNativeEsmLoader(nodeCtx, loader, isEsm ? { filename, source: cleanMainSource } : undefined, program.conditions);
		} catch (error) {
			await ctx.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			return { code: 1, ended: true, finalCode: () => 1 };
		}
		// The realm is the program's: a module that reaches globalThis.process
		// (not a CommonJS wrapper parameter) finds the program's.
		const ga = globalThis as Record<string, unknown>;
		ga.process = main.process;
		// So are the realm's own warnings, a native builtin's (util.deprecate,
		// Buffer(), events): Node delivers a warning to the process that raised
		// it, through whatever its emitWarning is when the warning is raised.
		realm.emitWarning = (...warning) => { main.process.emitWarning(...warning); };
		realm.removeAllListeners('warning');
		realm.on('warning', (warning) => { main.process.emit('warning', warning); });
		ga.Buffer = Buffer;
		ga.console = main.console;
		ga.global = globalThis;

		try {
			if (isEsm) await native.importMain();
			else if (filename === '[eval]') {
				const fn = new Function(`return ${moduleWrapper(cleanMainSource, pathToFileURL(`${program.cwd}/[eval]`).href)}`)();
				fn(...loader.wrapperArguments(filename, module));
			} else loader.load(filename, { source: cleanMainSource, esm: false });

			const finalCode = () => exitCodeOf(main.process);
			return { code: finalCode(), ended: false, finalCode };
		} catch (e) {
			if (e instanceof ProcessExitError) {
				return { code: e.exitCode, ended: true, finalCode: () => e.exitCode };
			}
			if (e instanceof Error) {
				await ctx.stderr.write(`${e.stack || e.message}\n`);
			} else {
				await ctx.stderr.write(`${String(e)}\n`);
			}
			return { code: 1, ended: true, finalCode: () => 1 };
		}
}
