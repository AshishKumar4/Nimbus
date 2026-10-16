import type { ProcessView } from '../../../../runtime/process-files.js';
import type { Command } from '../types.js';
import { dirname, extname } from '../../utils/path.js';
import type { PackageType } from '../../../../runtime/module-format.js';
import { packageScopeType } from '../../../../runtime/require-resolution.js';
import { NODE_VERSION } from '../../../../constants.js';
import { parseNodeCommandLine, type NodeCommandLine } from '../../../../runtime/node-cli.js';
import { resolveRuntimeScriptPath } from '../../../../runtime/script-path.js';
import type { VirtualRequestHandler, Kernel } from '../../kernel/index.js';
import { runNodeInRealm } from './node-realm.js';

/** The same walk for the main script, through the shell's own view before any `require` runs. */
async function mainPackageType(filename: string, vfs: ProcessView): Promise<PackageType> {
	return packageScopeType({
		exists: (path) => vfs.exists('/' + path),
		isDirectory: async (path) => (await vfs.stat('/' + path))?.type === 'directory',
		readFileString: (path) => vfs.readFileString('/' + path),
		stat: (path) => vfs.stat('/' + path),
	}, dirname(filename));
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

/**
 * What this node does not run of a command line Node takes: its preloads,
 * `-p`, `-c`, `--input-type`, a program read from stdin, and the options that
 * change whether or how a program loads, refused before any of it runs
 * rather than ignored.
 */
function unsupported(line: NodeCommandLine, program: string | undefined): string | null {
	if (line.require.length > 0) return '--require';
	if (line.import.length > 0) return '--import';
	if (line.print) return '--print';
	if (line.check) return '--check';
	if (line.defaultType !== undefined) return '--experimental-default-type';
	if (line.inputType !== undefined) return '--input-type';
	if (line.experimentalEventSource === true) return '--experimental-eventsource';
	if (line.transformTypes === true) return '--experimental-transform-types';
	if (line.eval === undefined && program === '-') return 'a program read from stdin';
	return null;
}

function createNodeImpl(kernelOrPortRegistry?: Kernel | Map<number, VirtualRequestHandler>): Command {
	return async (ctx) => {
		// Node's own reading of its command line (runtime/node-cli.ts), as the
		// hosted node's: its options up to the program, NODE_OPTIONS' first.
		const line = parseNodeCommandLine(ctx.args, ctx.env.NODE_OPTIONS ?? '');
		if ('error' in line) {
			await ctx.stderr.write(line.error);
			return line.exitCode;
		}
		if (line.version) {
			await ctx.stdout.write(NODE_VERSION + '\n');
			return 0;
		}
		if (line.help) {
			await ctx.stdout.write('Usage: node [options] [-e code | script.js] [args...]\n');
			await ctx.stdout.write('       node -v\n\n');
			await ctx.stdout.write('Options:\n');
			await ctx.stdout.write('  -e, --eval <code>         evaluate code\n');
			await ctx.stdout.write('  -C, --conditions <name>   a resolution condition, for require and import\n');
			await ctx.stdout.write('  -v, --version             print version\n\n');
			await ctx.stdout.write('Limitations:\n');
			await ctx.stdout.write('  - Native ES modules (Node >= 22.15 or Bun with Bun.plugin)\n');
			await ctx.stdout.write('  - No native modules\n');
			await ctx.stdout.write('  - No --require, --import, --print, --input-type, or program from stdin\n');
			return 0;
		}
		const program = ctx.args[line.programIndex];
		const refused = unsupported(line, program);
		if (refused !== null) {
			await ctx.stderr.write(`node: ${refused} is not supported by this node (a portable workspace runs a script or -e code)\n`);
			return 9;
		}

		let source: string;
		let filename: string;
		let scriptArgs: string[];
		if (line.eval !== undefined) {
			source = line.eval;
			filename = '[eval]';
			scriptArgs = ctx.args.slice(line.programIndex);
		} else if (program !== undefined) {
			// The script as the hosted node finds it: `.` its package's main, else the path, then its extensions.
			const found = await resolveRuntimeScriptPath({
				isFile: async (path) => (await ctx.vfs.stat('/' + path))?.type === 'file',
				readFileString: (path) => ctx.vfs.readFileString('/' + path),
			}, ctx.cwd, program);
			if (found === null) {
				await ctx.stderr.write(`node: cannot find module '${program}'\n`);
				return 1;
			}
			try {
				source = await ctx.vfs.readFileString('/' + found);
				filename = await ctx.vfs.realpath('/' + found);
			} catch (e) {
				const reason = scriptReadDiagnostic(e);
				if (reason !== null) {
					await ctx.stderr.write(`node: ${program}: ${reason}\n`);
					return 1;
				}
				throw e;
			}
			scriptArgs = ctx.args.slice(line.programIndex + 1);
		} else {
			// No program -- print usage hint
			await ctx.stderr.write('Usage: node [options] [-e code | script.js] [args...]\n');
			return 1;
		}

		const mainType = extname(filename) === '.js' || extname(filename) === '' ? await mainPackageType(filename, ctx.vfs) : null;
		const kernel = kernelOrPortRegistry instanceof Map ? { portRegistry: kernelOrPortRegistry } : kernelOrPortRegistry;
		// The program runs in a realm of its own (a worker per run), never the
		// host's: its globals and intrinsics are its own (node-realm.ts).
		const identity = { pid: ctx.pid, uid: ctx.cred.uid, gid: ctx.cred.gid, groups: [...ctx.cred.groups], umask: ctx.cred.umask };
		return runNodeInRealm({ source, filename, scriptArgs, cwd: ctx.cwd, env: ctx.env, mainType, identity, conditions: line.conditions }, ctx, kernel);
	};
}

export function createNodeCommand(kernel: Kernel): Command {
	return createNodeImpl(kernel);
}

// Default command with a shared portRegistry so http.createServer works
const defaultPortRegistry = new Map<number, VirtualRequestHandler>();
const command: Command = createNodeImpl(defaultPortRegistry);

export default command;
