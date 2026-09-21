import { resolve, dirname } from '../../utils/path.js';
import { createTar, parseTar, compressGzip, decompressGzip, collectFiles } from '../../utils/archive.js';
import { VFSError } from '../../kernel/vfs/index.js';
const command = async (ctx) => {
    let create = false;
    let extract = false;
    let list = false;
    let gzipFlag = false;
    let verbose = false;
    let archiveFile = '';
    let changeDir = '';
    const files = [];
    // Parse args manually (tar uses combined flags like -czf)
    let i = 0;
    while (i < ctx.args.length) {
        const arg = ctx.args[i];
        if (arg === '--help') {
            await ctx.stdout.write('Usage: tar [-c|-x|-t] [-z] [-v] [-f file] [-C dir] [files...]\n');
            await ctx.stdout.write('  -c   create archive\n');
            await ctx.stdout.write('  -x   extract archive\n');
            await ctx.stdout.write('  -t   list archive contents\n');
            await ctx.stdout.write('  -z   gzip compression\n');
            await ctx.stdout.write('  -v   verbose\n');
            await ctx.stdout.write('  -f   archive file\n');
            await ctx.stdout.write('  -C   change directory\n');
            return 0;
        }
        if (arg.startsWith('-') && arg !== '-') {
            const chars = arg.slice(1);
            for (let j = 0; j < chars.length; j++) {
                switch (chars[j]) {
                    case 'c':
                        create = true;
                        break;
                    case 'x':
                        extract = true;
                        break;
                    case 't':
                        list = true;
                        break;
                    case 'z':
                        gzipFlag = true;
                        break;
                    case 'v':
                        verbose = true;
                        break;
                    case 'f': {
                        const rest = chars.slice(j + 1);
                        archiveFile = rest || ctx.args[++i] || '';
                        j = chars.length; // break out of inner loop
                        break;
                    }
                    case 'C': {
                        const rest = chars.slice(j + 1);
                        changeDir = rest || ctx.args[++i] || '';
                        j = chars.length;
                        break;
                    }
                    default:
                        await ctx.stderr.write(`tar: unknown option: -${chars[j]}\n`);
                        return 1;
                }
            }
        }
        else {
            files.push(arg);
        }
        i++;
    }
    const modeCount = [create, extract, list].filter(Boolean).length;
    if (modeCount === 0) {
        await ctx.stderr.write('tar: must specify one of -c, -x, -t\n');
        return 1;
    }
    if (modeCount > 1) {
        await ctx.stderr.write('tar: conflicting options\n');
        return 1;
    }
    if (!archiveFile) {
        await ctx.stderr.write('tar: -f is required\n');
        return 1;
    }
    const archivePath = resolve(ctx.cwd, archiveFile);
    const targetDir = changeDir ? resolve(ctx.cwd, changeDir) : ctx.cwd;
    try {
        if (create) {
            if (files.length === 0) {
                await ctx.stderr.write('tar: no files to archive\n');
                return 1;
            }
            const entries = (await collectFiles(ctx.vfs, targetDir, files));
            let data = createTar(entries);
            if (gzipFlag) {
                data = await compressGzip(data);
            }
            (await ctx.vfs.writeFile(archivePath, data));
            if (verbose) {
                for (const entry of entries) {
                    await ctx.stdout.write(`${entry.path}\n`);
                }
            }
        }
        else if (extract) {
            let data = (await ctx.vfs.readFile(archivePath));
            if (gzipFlag) {
                data = await decompressGzip(data);
            }
            const entries = parseTar(data);
            // Ensure target dir exists
            if (changeDir) {
                try {
                    (await ctx.vfs.mkdir(targetDir, { recursive: true }));
                }
                catch { /* exists */ }
            }
            for (const entry of entries) {
                const entryPath = resolve(targetDir, entry.path);
                if (entry.type === 'directory') {
                    try {
                        (await ctx.vfs.mkdir(entryPath, { recursive: true }));
                    }
                    catch { /* exists */ }
                }
                else {
                    // Ensure parent dir exists
                    const parent = dirname(entryPath);
                    try {
                        (await ctx.vfs.mkdir(parent, { recursive: true }));
                    }
                    catch { /* exists */ }
                    (await ctx.vfs.writeFile(entryPath, entry.data));
                }
                if (verbose) {
                    await ctx.stdout.write(`${entry.path}\n`);
                }
            }
        }
        else if (list) {
            let data = (await ctx.vfs.readFile(archivePath));
            if (gzipFlag) {
                data = await decompressGzip(data);
            }
            const entries = parseTar(data);
            for (const entry of entries) {
                await ctx.stdout.write(`${entry.path}${entry.type === 'directory' ? '/' : ''}\n`);
            }
        }
    }
    catch (e) {
        if (e instanceof VFSError) {
            await ctx.stderr.write(`tar: ${e.message}\n`);
            return 2;
        }
        throw e;
    }
    return 0;
};
export default command;
