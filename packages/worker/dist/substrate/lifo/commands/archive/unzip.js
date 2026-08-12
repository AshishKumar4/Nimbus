import { resolve, dirname } from '../../utils/path.js';
import { parseZip } from '../../utils/archive.js';
import { parseArgs } from '../../utils/args.js';
import { VFSError } from '../../kernel/vfs/index.js';
const spec = {
    list: { type: 'boolean', short: 'l' },
    overwrite: { type: 'boolean', short: 'o' },
    'never-overwrite': { type: 'boolean', short: 'n' },
    quiet: { type: 'boolean', short: 'q' },
    junk: { type: 'boolean', short: 'j' },
    pipe: { type: 'boolean', short: 'p' },
    dir: { type: 'string', short: 'd' },
    help: { type: 'boolean' },
};
const command = async (ctx) => {
    const { flags, positional, unknown } = parseArgs(ctx.args, spec);
    if (flags.help) {
        ctx.stdout.write('Usage: unzip [-lonqjp] [-d dir] archive.zip\n');
        ctx.stdout.write('  -l       list contents\n');
        ctx.stdout.write('  -o       overwrite existing files without prompting\n');
        ctx.stdout.write('  -n       never overwrite existing files\n');
        ctx.stdout.write('  -q       quiet\n');
        ctx.stdout.write('  -j       junk paths, extract every entry into one directory\n');
        ctx.stdout.write('  -p       extract to stdout\n');
        ctx.stdout.write('  -d dir   extract to directory\n');
        return 0;
    }
    if (unknown.length > 0) {
        ctx.stderr.write(`unzip: invalid option: ${unknown[0]}\n`);
        return 1;
    }
    const archiveFile = positional[0];
    if (!archiveFile) {
        ctx.stderr.write('unzip: missing archive operand\n');
        return 1;
    }
    const listOnly = flags.list === true;
    const toStdout = flags.pipe === true;
    const quiet = flags.quiet === true || toStdout;
    const junkPaths = flags.junk === true;
    const neverOverwrite = flags['never-overwrite'] === true;
    const destDir = typeof flags.dir === 'string' ? flags.dir : '';
    const archivePath = resolve(ctx.cwd, archiveFile);
    const targetDir = destDir ? resolve(ctx.cwd, destDir) : ctx.cwd;
    try {
        const data = ctx.vfs.readFile(archivePath);
        const entries = parseZip(data);
        if (listOnly) {
            ctx.stdout.write('  Length      Name\n');
            ctx.stdout.write('---------  ----\n');
            let totalSize = 0;
            for (const entry of entries) {
                const size = entry.data.length;
                totalSize += size;
                const path = entry.isDirectory ? entry.path + '/' : entry.path;
                ctx.stdout.write(`${String(size).padStart(9)}  ${path}\n`);
            }
            ctx.stdout.write('---------  ----\n');
            ctx.stdout.write(`${String(totalSize).padStart(9)}  ${entries.length} file(s)\n`);
            return 0;
        }
        if (destDir) {
            try {
                ctx.vfs.mkdir(targetDir, { recursive: true });
            }
            catch { /* exists */ }
        }
        for (const entry of entries) {
            const name = junkPaths ? entry.path.slice(entry.path.lastIndexOf('/') + 1) : entry.path;
            if (entry.isDirectory) {
                if (junkPaths)
                    continue;
                const entryPath = resolve(targetDir, name);
                try {
                    ctx.vfs.mkdir(entryPath, { recursive: true });
                }
                catch { /* exists */ }
                if (!quiet)
                    ctx.stdout.write(`  extracting: ${entry.path}/\n`);
                continue;
            }
            if (toStdout) {
                writeBytes(ctx.stdout, entry.data);
                continue;
            }
            const entryPath = resolve(targetDir, name);
            if (neverOverwrite && ctx.vfs.exists(entryPath))
                continue;
            const parent = dirname(entryPath);
            try {
                ctx.vfs.mkdir(parent, { recursive: true });
            }
            catch { /* exists */ }
            ctx.vfs.writeFile(entryPath, entry.data);
            if (!quiet)
                ctx.stdout.write(`  extracting: ${entry.path}\n`);
        }
    }
    catch (e) {
        if (e instanceof VFSError) {
            ctx.stderr.write(`unzip: ${e.message}\n`);
            return 1;
        }
        throw e;
    }
    return 0;
};
function writeBytes(stdout, bytes) {
    if (stdout.writeBytes)
        stdout.writeBytes(bytes);
    else
        stdout.write(new TextDecoder().decode(bytes));
}
export default command;
