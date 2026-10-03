import { resolve, basename } from '../../utils/path.js';
import { parseArgs } from '../../utils/args.js';
import { move } from '../../../../vfs/move.js';
import { isVfsError, strerror } from '../../../../vfs/vfs-error.js';
import { statOrThrow } from '../../../../vfs/vfs.js';
const spec = {
    force: { type: 'boolean', short: 'f' },
    'no-clobber': { type: 'boolean', short: 'n' },
    verbose: { type: 'boolean', short: 'v' },
    'target-directory': { type: 'string', short: 't' },
    help: { type: 'boolean' },
};
const command = async (ctx) => {
    const { flags, positional, unknown } = parseArgs(ctx.args, spec);
    if (flags.help) {
        await ctx.stdout.write('Usage: mv [-fnv] SOURCE... DEST\n');
        await ctx.stdout.write('  -f          overwrite the destination without prompting\n');
        await ctx.stdout.write('  -n          never overwrite an existing destination\n');
        await ctx.stdout.write('  -v          print each move\n');
        await ctx.stdout.write('  -t DIR      move every SOURCE into DIR\n');
        return 0;
    }
    if (unknown.length > 0) {
        await ctx.stderr.write(`mv: invalid option -- '${unknown[0].replace(/^-+/, '')}'\n`);
        return 1;
    }
    const targetDir = typeof flags['target-directory'] === 'string' && flags['target-directory']
        ? flags['target-directory']
        : null;
    const sources = targetDir ? positional : positional.slice(0, -1);
    const rawDest = targetDir ?? positional[positional.length - 1];
    if (sources.length === 0 || rawDest === undefined) {
        await ctx.stderr.write('mv: missing operand\n');
        return 1;
    }
    const dest = resolve(ctx.cwd, rawDest);
    const destIsDir = (await isDirectory(ctx, dest));
    if (sources.length > 1 && !destIsDir) {
        await ctx.stderr.write(`mv: target '${rawDest}' is not a directory\n`);
        return 1;
    }
    let exitCode = 0;
    for (const source of sources) {
        const src = resolve(ctx.cwd, source);
        const target = destIsDir ? resolve(dest, basename(src)) : dest;
        if (flags['no-clobber'] && (await ctx.vfs.exists(target)))
            continue;
        try {
            // Across mounts, a copy that lands whole or not at all (vfs/move.ts).
            await move(ctx.vfs, src, target, {
                onPreserveFailure: async ({ what, path, error }) => {
                    await ctx.stderr.write(`mv: preserving ${what} for '${path}': ${error.message}\n`);
                },
            });
            if (flags.verbose)
                await ctx.stdout.write(`renamed '${source}' -> '${rawDest}'\n`);
        }
        catch (e) {
            if (isVfsError(e)) {
                // GNU's words: a source that is not there cannot be stat'ed; any
                // other refusal is a move that failed.
                const missing = isVfsError(e, 'ENOENT') && (await ctx.vfs.stat(src, { follow: false })) === null;
                await ctx.stderr.write(missing
                    ? `mv: cannot stat '${source}': ${strerror(e)}\n`
                    : `mv: cannot move '${source}' to '${rawDest}': ${strerror(e)}\n`);
                exitCode = 1;
                continue;
            }
            throw e;
        }
    }
    return exitCode;
};
async function isDirectory(ctx, path) {
    try {
        return (await statOrThrow(ctx.vfs, path)).type === 'directory';
    }
    catch (error) {
        if (isVfsError(error) && error.code === 'ENOENT')
            return false;
        throw error;
    }
}
export default command;
