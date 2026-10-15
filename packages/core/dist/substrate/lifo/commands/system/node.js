import { resolve, dirname, extname } from '../../utils/path.js';
import { packageScopeType } from '../../../../runtime/require-resolution.js';
import { NODE_VERSION } from '../../../../constants.js';
import { runNodeInRealm } from './node-realm.js';
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
        const identity = { pid: ctx.pid, uid: ctx.cred.uid, gid: ctx.cred.gid, groups: [...ctx.cred.groups], umask: ctx.cred.umask };
        return runNodeInRealm({ source, filename, scriptArgs, cwd: ctx.cwd, env: ctx.env, mainType, identity }, ctx, kernel);
    };
}
export function createNodeCommand(kernel) {
    return createNodeImpl(kernel);
}
// Default command with a shared portRegistry so http.createServer works
const defaultPortRegistry = new Map();
const command = createNodeImpl(defaultPortRegistry);
export default command;
