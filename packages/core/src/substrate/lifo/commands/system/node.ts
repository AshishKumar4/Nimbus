import type { NodeFilesystem } from '../../node-compat/filesystem.js';
import type { ProcessView } from '../../../../runtime/process-files.js';
import type { Command } from '../types.js';
import { resolve, dirname, join, extname } from '../../utils/path.js';
import { ProcessExitError } from '../../node-compat/index.js';
import { createCjsLoader, declaredPackageType, moduleWrapper, stripShebang, treatAsEsm, type PackageType } from '../../node-compat/cjs-loader.js';
import type { NodeContext } from '../../node-compat/index.js';
import { createProcess } from '../../node-compat/process.js';
import { createConsole } from '../../node-compat/console.js';
import { Buffer } from '../../node-compat/buffer.js';
import type { VirtualRequestHandler, Kernel, LoopbackRouter } from '../../kernel/index.js';
import type { DNSResolver } from '../../kernel/dns-resolver.js';
import type { CommandOutputStream } from '../types.js';
import { runNodeInRealm } from './node-realm.js';

const NODE_VERSION = 'v20.0.0';

// ── Rollup / esbuild CJS-ESM interop helpers ──
// Bundled npm packages (Vite, Rollup, etc.) reference these helpers at the module
// scope.  When our ESM→CJS transform converts imports, the helpers may lose their
// binding.  Making them available on globalThis acts as a fallback – if the module
// defines its own copy the local declaration naturally shadows the global.
//
// Complete set from @rollup/plugin-commonjs interop:
const _rollupHelpers: Record<string, (...args: unknown[]) => unknown> = {
	getDefaultExportFromCjs(x: unknown): unknown {
		const o = x as Record<string, unknown>;
		return o && o.__esModule && Object.prototype.hasOwnProperty.call(o, 'default') ? o.default : o;
	},
	getDefaultExportFromNamespaceIfPresent(n: unknown): unknown {
		const o = n as Record<string, unknown>;
		return o && Object.prototype.hasOwnProperty.call(o, 'default') && Object.keys(o).length === 1 ? o.default : o;
	},
	getAugmentedNamespace(n: unknown): unknown {
		const o = n as Record<string, unknown>;
		if (o.__esModule) return o;
		const a: Record<string, unknown> = Object.defineProperty({}, '__esModule', { value: true });
		Object.keys(o).forEach(function (k) {
			const d = Object.getOwnPropertyDescriptor(o, k);
			Object.defineProperty(a, k, d && d.get ? d : { enumerable: true, get() { return o[k]; } });
		});
		a.default = n;
		return Object.freeze(a);
	},
	_mergeNamespaces(n: unknown, ...ms: unknown[]): unknown {
		const o = n as Record<string, unknown>;
		const modules = ms.flat() as Array<Record<string, unknown>>;
		for (const m of modules) {
			for (const k of Object.keys(m)) {
				if (k !== 'default' && !(k in o)) {
					Object.defineProperty(o, k, { enumerable: true, get: () => m[k] });
				}
			}
		}
		return Object.freeze(o);
	},
};

/** The same walk for the main script, through the shell's own view before any `require` runs. */
async function mainPackageType(filename: string, vfs: ProcessView): Promise<PackageType> {
	for (let dir = dirname(filename); ; dir = dirname(dir)) {
		const pkgPath = join(dir, 'package.json');
		if (await vfs.exists(pkgPath)) return declaredPackageType(await vfs.readFileString(pkgPath));
		if (dirname(dir) === dir) return null;
	}
}

/** A failed script read carries an error code, not one error class. */
function scriptReadDiagnostic(error: unknown): string | null {
	if (!(error instanceof Error)) return null;
	const code = 'code' in error && typeof error.code === 'string' ? error.code : null;
	if (code === null) return null;
	if (code === 'ENOENT') return 'No such file or directory';
	if (code === 'EACCES' || code === 'EPERM') return 'Permission denied';
	if (code === 'EISDIR') return 'Is a directory';
	return error.message;
}

function createNodeImpl(kernelOrPortRegistry?: Kernel | Map<number, VirtualRequestHandler>): Command {
	return async (ctx) => {
		// Handle -v/--version
		if (ctx.args.length > 0 && (ctx.args[0] === '-v' || ctx.args[0] === '--version')) {
			await ctx.stdout.write(NODE_VERSION + '\n');
			return 0;
		}

		// Handle --help
		if (ctx.args.length > 0 && ctx.args[0] === '--help') {
			await ctx.stdout.write('Usage: node [-e code] [script.js] [args...]\n');
			await ctx.stdout.write('       node -v\n\n');
			await ctx.stdout.write('Options:\n');
			await ctx.stdout.write('  -e, --eval <code>   evaluate code\n');
			await ctx.stdout.write('  -v, --version       print version\n\n');
			await ctx.stdout.write('Limitations:\n');
			await ctx.stdout.write('  - ESM support via auto-transform (import/export → require/exports)\n');
			await ctx.stdout.write('  - No native modules\n');
			await ctx.stdout.write('  - require() resolves: built-in modules, relative VFS files, installed packages\n');
			return 0;
		}

		let source: string;
		let filename: string;
		let scriptArgs: string[];

		// Handle -e / --eval
		if (ctx.args.length > 0 && (ctx.args[0] === '-e' || ctx.args[0] === '--eval')) {
			if (ctx.args.length < 2) {
				await ctx.stderr.write('node: -e requires an argument\n');
				return 1;
			}
			source = ctx.args[1];
			filename = '[eval]';
			scriptArgs = ctx.args.slice(2);
		} else if (ctx.args.length > 0) {
			// Run script file
			const scriptPath = resolve(ctx.cwd, ctx.args[0]);
			try {
				source = await ctx.vfs.readFileString(scriptPath);
			} catch (e) {
				const reason = scriptReadDiagnostic(e);
				if (reason !== null) {
					await ctx.stderr.write(`node: ${ctx.args[0]}: ${reason}\n`);
					return 1;
				}
				throw e;
			}
			filename = scriptPath;
			scriptArgs = ctx.args.slice(1);
		} else {
			// No args -- print usage hint
			await ctx.stderr.write('Usage: node [-e code] [script.js] [args...]\n');
			return 1;
		}

		const mainType = extname(filename) === '.js' ? await mainPackageType(filename, ctx.vfs) : null;
		const kernel = kernelOrPortRegistry instanceof Map ? { portRegistry: kernelOrPortRegistry } : kernelOrPortRegistry;
		// The program runs in a realm of its own (a worker per run), never the
		// host's: its globals and intrinsics are its own (node-realm.ts).
		return runNodeInRealm({ source, filename, scriptArgs, cwd: ctx.cwd, env: ctx.env, mainType }, ctx, kernel);
	};
}

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
}

/** What a run reaches outside its realm: the filesystem, its stdio, the session's ports. */
export interface NodeProgramHost {
	readonly filesystem: () => NodeFilesystem;
	readonly stdout: CommandOutputStream;
	readonly stderr: CommandOutputStream;
	/** fd 0, read to its end: blocks until stdin ends, as a synchronous read of it does in Node. */
	readonly stdin: () => Uint8Array;
	readonly portRegistry?: Map<number, VirtualRequestHandler>;
	readonly routeLoopback?: LoopbackRouter;
	readonly dns?: DNSResolver;
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
 * (process, Buffer, console, the bundlers' interop helpers) are installed on
 * globalThis for good. Resolves once the main script has run (an ES module's
 * top-level await included). What it left (timers, servers, requests) runs on
 * in the realm's own event loop, which owns how long the process lives.
 */
export async function runNodeProgram(program: NodeProgram, host: NodeProgramHost): Promise<NodeProgramEnd> {
		const { source, filename, scriptArgs, mainType } = program;
		const filesystem = host.filesystem;
		const ctx = { stdout: host.stdout, stderr: host.stderr };
		const dir = filename === '[eval]' ? program.cwd : dirname(filename);
		const nodeCtx: NodeContext = {
			filesystem,
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
		};

		// Each module has its own process and console object, as the main script has.
		const scope = () => ({ process: createProcess({ argv: nodeCtx.argv, env: nodeCtx.env, cwd: nodeCtx.cwd, stdout: ctx.stdout, stderr: ctx.stderr }), console: createConsole(ctx.stdout, ctx.stderr) });
		const loader = createCjsLoader(nodeCtx, scope);

		// Execute main script
		const main = scope();
		const module = { exports: {} as Record<string, unknown> };
		const cleanMainSource = stripShebang(source);
		const isEsm = treatAsEsm(cleanMainSource, filename, () => mainType);
		// An ES module runs as an async function (its top-level await), strict.
		const wrapped = moduleWrapper(cleanMainSource, isEsm, isEsm);

		// The realm is the program's: npm bundles that reach globalThis.process
		// (not the wrapper param) find the program's, and the bundlers' interop
		// helpers are its globals too.
		const ga = globalThis as Record<string, unknown>;
		ga.process = main.process;
		ga.Buffer = Buffer;
		ga.console = main.console;
		ga.global = globalThis;
		for (const k of Object.keys(_rollupHelpers)) ga[k] = _rollupHelpers[k];

		try {
			const fn = new Function('return ' + wrapped)();
			const result = fn(...loader.wrapperArguments(filename, module, main));

			// Await if ESM (async IIFE returns a promise)
			if (isEsm && result && typeof result.then === 'function') {
				await result;
			}

			return { code: 0, ended: false };
		} catch (e) {
			if (e instanceof ProcessExitError) {
				return { code: e.exitCode, ended: true };
			}
			if (e instanceof Error) {
				await ctx.stderr.write(`${e.stack || e.message}\n`);
			} else {
				await ctx.stderr.write(`${String(e)}\n`);
			}
			return { code: 1, ended: true };
		}
}

export function createNodeCommand(kernel: Kernel): Command {
	return createNodeImpl(kernel);
}

// Default command with a shared portRegistry so http.createServer works
const defaultPortRegistry = new Map<number, VirtualRequestHandler>();
const command: Command = createNodeImpl(defaultPortRegistry);

export default command;
