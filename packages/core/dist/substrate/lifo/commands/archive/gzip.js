import { resolve } from '../../utils/path.js';
import { compressGzip, decompressGzip } from '../../utils/archive.js';
import { parseArgs } from '../../utils/args.js';
import { isVfsError } from '../../../../vfs/vfs-error.js';
const spec = {
    keep: { type: 'boolean', short: 'k' },
    decompress: { type: 'boolean', short: 'd' },
    force: { type: 'boolean', short: 'f' },
    quiet: { type: 'boolean', short: 'q' },
    help: { type: 'boolean' },
};
/**
 * Compress each file to FILE.gz, or decompress each FILE.gz to FILE, as GNU
 * gzip 1.14 does: the input goes unless -k; an existing output is not
 * overwritten without -f (a warning, even under -q); a name without the
 * .gz suffix is skipped with a warning, which -q silences. Exit status: 1
 * for an error, else 2 for a warning, else 0.
 */
export async function gzipFiles(ctx, files, options) {
    let exitCode = 0;
    const warn = async (message, quietable) => {
        if (quietable && options.quiet)
            return;
        await ctx.stderr.write(`${options.name}: ${message}\n`);
        if (exitCode === 0)
            exitCode = 2;
    };
    for (const file of files) {
        const path = resolve(ctx.cwd, file);
        try {
            if (options.decompress && !path.endsWith('.gz')) {
                await warn(`${file}: unknown suffix -- ignored`, true);
                continue;
            }
            const outPath = options.decompress ? path.slice(0, -3) : `${path}.gz`;
            if (!options.force && (await ctx.vfs.exists(outPath))) {
                await warn(`${options.decompress ? file.slice(0, -3) : `${file}.gz`} already exists;\tnot overwritten`, false);
                continue;
            }
            const data = await ctx.vfs.readFile(path);
            await ctx.vfs.writeFile(outPath, options.decompress ? await decompressGzip(data) : await compressGzip(data));
            if (!options.keep)
                await ctx.vfs.unlink(path);
        }
        catch (e) {
            if (!isVfsError(e))
                throw e;
            await ctx.stderr.write(`${options.name}: ${file}: ${e.message}\n`);
            exitCode = 1;
        }
    }
    return exitCode;
}
const command = async (ctx) => {
    const { flags, positional, unknown } = parseArgs(ctx.args, spec);
    if (flags.help) {
        await ctx.stdout.write('Usage: gzip [-kdfq] file...\n');
        await ctx.stdout.write('  -k, --keep         keep original file\n');
        await ctx.stdout.write('  -d, --decompress   decompress\n');
        await ctx.stdout.write('  -f, --force        overwrite an existing output file\n');
        await ctx.stdout.write('  -q, --quiet        suppress warnings\n');
        return 0;
    }
    // Compression levels are accepted and ignored: the gzip stream this VFS
    // writes comes from CompressionStream, which exposes no level control.
    const rejected = unknown.filter((o) => !/^-[1-9]$/.test(o));
    if (rejected.length > 0) {
        await ctx.stderr.write(`gzip: invalid option -- '${rejected[0].replace(/^-+/, '')}'\n`);
        return 1;
    }
    if (positional.length === 0) {
        await ctx.stderr.write('gzip: missing file operand\n');
        return 1;
    }
    return await gzipFiles(ctx, positional, {
        name: 'gzip', decompress: flags.decompress === true, keep: flags.keep === true, force: flags.force === true, quiet: flags.quiet === true,
    });
};
export default command;
