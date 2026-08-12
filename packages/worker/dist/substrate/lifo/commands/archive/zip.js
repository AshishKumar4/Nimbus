import { resolve } from '../../utils/path.js';
import { createZip, collectFiles } from '../../utils/archive.js';
import { parseArgs } from '../../utils/args.js';
import { VFSError } from '../../kernel/vfs/index.js';
const spec = {
    recursive: { type: 'boolean', short: 'r' },
    quiet: { type: 'boolean', short: 'q' },
    junk: { type: 'boolean', short: 'j' },
    help: { type: 'boolean' },
};
const command = async (ctx) => {
    const { flags, positional, unknown } = parseArgs(ctx.args, spec);
    if (flags.help || ctx.args.length === 0) {
        ctx.stdout.write('Usage: zip [-rqj] archive.zip file1 [file2 ...]\n');
        ctx.stdout.write('  -r   recurse into directories\n');
        ctx.stdout.write('  -q   quiet\n');
        ctx.stdout.write('  -j   junk paths, store each entry by basename\n');
        return ctx.args.length === 0 ? 1 : 0;
    }
    // Compression levels are accepted and ignored: entries are stored, not
    // deflated, so there is no level to honour.
    const rejected = unknown.filter((o) => !/^-[0-9]$/.test(o));
    if (rejected.length > 0) {
        ctx.stderr.write(`zip: invalid option -- '${rejected[0].replace(/^-+/, '')}'\n`);
        return 1;
    }
    const archiveFile = positional[0];
    const files = positional.slice(1);
    if (!archiveFile || files.length === 0) {
        ctx.stderr.write('zip: no files to archive\n');
        return 1;
    }
    const archivePath = resolve(ctx.cwd, archiveFile);
    try {
        const tarEntries = collectFiles(ctx.vfs, ctx.cwd, files);
        const zipEntries = tarEntries.map((e) => ({
            path: flags.junk ? e.path.slice(e.path.lastIndexOf('/') + 1) : e.path,
            data: e.data,
            isDirectory: e.type === 'directory',
        }));
        const data = createZip(zipEntries);
        ctx.vfs.writeFile(archivePath, data);
        if (!flags.quiet) {
            for (const entry of zipEntries) {
                ctx.stdout.write(`  adding: ${entry.path}${entry.isDirectory ? '/' : ''}\n`);
            }
        }
    }
    catch (e) {
        if (e instanceof VFSError) {
            ctx.stderr.write(`zip: ${e.message}\n`);
            return 1;
        }
        throw e;
    }
    return 0;
};
export default command;
