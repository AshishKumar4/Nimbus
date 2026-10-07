import { resolve, basename } from '../../utils/path.js';
import { parseArgs } from '../../utils/args.js';
import { resolveCopyTargets } from './copy-targets.js';
import { move } from '../../../../vfs/move.js';
import { isVfsError, strerror } from '../../../../vfs/vfs-error.js';
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
    const targets = await resolveCopyTargets(ctx, positional, typeof flags['target-directory'] === 'string' && flags['target-directory'] ? flags['target-directory'] : null);
    if (typeof targets === 'string' || targets === null) {
        await ctx.stderr.write(`mv: ${targets ?? 'missing operand'}\n`);
        return 1;
    }
    const { sources, rawDest, destIsDir } = targets;
    let exitCode = 0;
    for (const source of sources) {
        const src = resolve(ctx.cwd, source);
        const target = targets.targetFor(src);
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
                const named = destIsDir ? `${rawDest.replace(/\/+$/, '')}/${basename(src)}` : rawDest;
                await ctx.stderr.write(missing
                    ? `mv: cannot stat '${source}': ${strerror(e)}\n`
                    : target.startsWith(`${src}/`)
                        ? `mv: cannot move '${source}' to a subdirectory of itself, '${named}'\n`
                        : `mv: cannot move '${source}' to '${named}': ${strerror(e)}\n`);
                exitCode = 1;
                continue;
            }
            throw e;
        }
    }
    return exitCode;
};
export default command;
