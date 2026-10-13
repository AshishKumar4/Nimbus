import { resolve, dirname, extname } from '../../utils/path.js';
import { ProcessExitError } from '../../node-compat/index.js';
import { createCjsLoader, moduleWrapper, stripShebang } from '../../node-compat/cjs-loader.js';
import { isEsModuleFile, isEsModuleInput } from '../../../../runtime/module-format.js';
import { packageScopeType } from '../../../../runtime/require-resolution.js';
import { createProcess } from '../../node-compat/process.js';
import { createConsole } from '../../node-compat/console.js';
import { Buffer } from '../../node-compat/buffer.js';
import { pathToFileURL } from '../../node-compat/url.js';
import { createNativeEsmLoader } from '../../node-compat/native-esm-loader.js';
import { runNodeInRealm } from './node-realm.js';
const NODE_VERSION = 'v20.0.0';
/** The same walk for the main script, through the shell's own view before any `require` runs. */
async function mainPackageType(filename, vfs) {
    return packageScopeType({
        exists: (path) => vfs.exists('/' + path),
        isDirectory: async (path) => (await vfs.stat('/' + path))?.type === 'directory',
        readFileString: (path) => vfs.readFileString('/' + path),
        stat: (path) => vfs.stat('/' + path),
    }, dirname(filename));
}
/** A failed script read carries an error code, not one error class. */
function scriptReadDiagnostic(error) {
    if (!(error instanceof Error))
        return null;
    const code = 'code' in error && typeof error.code === 'string' ? error.code : null;
    if (code === null)
        return null;
    if (code === 'ENOENT')
        return 'No such file or directory';
    if (code === 'EACCES' || code === 'EPERM')
        return 'Permission denied';
    if (code === 'EISDIR')
        return 'Is a directory';
    return error.message;
}
function createNodeImpl(kernelOrPortRegistry) {
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
            await ctx.stdout.write('  - Native ES modules (Node >= 22.15 or Bun with Bun.plugin)\n');
            await ctx.stdout.write('  - No native modules\n');
            await ctx.stdout.write('  - require() resolves: built-in modules, relative VFS files, installed packages\n');
            return 0;
        }
        let source;
        let filename;
        let scriptArgs;
        // Handle -e / --eval
        if (ctx.args.length > 0 && (ctx.args[0] === '-e' || ctx.args[0] === '--eval')) {
            if (ctx.args.length < 2) {
                await ctx.stderr.write('node: -e requires an argument\n');
                return 1;
            }
            source = ctx.args[1];
            filename = '[eval]';
            scriptArgs = ctx.args.slice(2);
        }
        else if (ctx.args.length > 0) {
            // Run script file
            const scriptPath = resolve(ctx.cwd, ctx.args[0]);
            try {
                source = await ctx.vfs.readFileString(scriptPath);
                filename = await ctx.vfs.realpath(scriptPath);
            }
            catch (e) {
                const reason = scriptReadDiagnostic(e);
                if (reason !== null) {
                    await ctx.stderr.write(`node: ${ctx.args[0]}: ${reason}\n`);
                    return 1;
                }
                throw e;
            }
            scriptArgs = ctx.args.slice(1);
        }
        else {
            // No args -- print usage hint
            await ctx.stderr.write('Usage: node [-e code] [script.js] [args...]\n');
            return 1;
        }
        const mainType = extname(filename) === '.js' || extname(filename) === '' ? await mainPackageType(filename, ctx.vfs) : null;
        const kernel = kernelOrPortRegistry instanceof Map ? { portRegistry: kernelOrPortRegistry } : kernelOrPortRegistry;
        // The program runs in a realm of its own (a worker per run), never the
        // host's: its globals and intrinsics are its own (node-realm.ts).
        return runNodeInRealm({ source, filename, scriptArgs, cwd: ctx.cwd, env: ctx.env, mainType }, ctx, kernel);
    };
}
/**
 * Run `program` in the current realm, which is the program's own: its globals
 * (process, Buffer, console) are installed on
 * globalThis for good. Resolves once the main script has run (an ES module's
 * top-level await included). What it left (timers, servers, requests) runs on
 * in the realm's own event loop, which owns how long the process lives.
 */
export async function runNodeProgram(program, host) {
    const { source, filename, scriptArgs, mainType } = program;
    const filesystem = host.filesystem;
    const ctx = { stdout: host.stdout, stderr: host.stderr };
    const dir = filename === '[eval]' ? program.cwd : dirname(filename);
    const nodeCtx = {
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
    const module = { exports: {} };
    const cleanMainSource = stripShebang(source);
    const isEsm = filename === '[eval]' ? isEsModuleInput(cleanMainSource, undefined) : isEsModuleFile(filename, cleanMainSource, () => mainType);
    // Capture the host's module API before replacing the program's globals.
    // Hooks supply VFS sources, but all ESM bindings and evaluation are native.
    let native;
    try {
        native = await createNativeEsmLoader(nodeCtx, loader, isEsm ? { filename, source: cleanMainSource } : undefined);
    }
    catch (error) {
        await ctx.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return { code: 1, ended: true };
    }
    // The realm is the program's: a module that reaches globalThis.process
    // (not a CommonJS wrapper parameter) finds the program's.
    const ga = globalThis;
    ga.process = main.process;
    ga.Buffer = Buffer;
    ga.console = main.console;
    ga.global = globalThis;
    try {
        if (isEsm)
            await native.importMain();
        else if (filename === '[eval]') {
            const fn = new Function(`return ${moduleWrapper(cleanMainSource, pathToFileURL(`${program.cwd}/[eval]`).href)}`)();
            fn(...loader.wrapperArguments(filename, module, main));
        }
        else
            loader.load(filename, { source: cleanMainSource, esm: false });
        return { code: 0, ended: false };
    }
    catch (e) {
        if (e instanceof ProcessExitError) {
            return { code: e.exitCode, ended: true };
        }
        if (e instanceof Error) {
            await ctx.stderr.write(`${e.stack || e.message}\n`);
        }
        else {
            await ctx.stderr.write(`${String(e)}\n`);
        }
        return { code: 1, ended: true };
    }
}
export function createNodeCommand(kernel) {
    return createNodeImpl(kernel);
}
// Default command with a shared portRegistry so http.createServer works
const defaultPortRegistry = new Map();
const command = createNodeImpl(defaultPortRegistry);
export default command;
