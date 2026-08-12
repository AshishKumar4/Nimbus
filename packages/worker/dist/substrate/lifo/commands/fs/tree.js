import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
const command = async (ctx) => {
    let maxDepth = Infinity;
    let dirsOnly = false;
    let showAll = false;
    let noReport = false;
    let targetPath = '.';
    for (let i = 0; i < ctx.args.length; i++) {
        const arg = ctx.args[i];
        if (arg === '-L' && i + 1 < ctx.args.length) {
            const level = parseInt(ctx.args[++i], 10);
            if (isNaN(level) || level < 1) {
                ctx.stderr.write('tree: Invalid level, must be greater than 0.\n');
                return 1;
            }
            maxDepth = level;
        }
        else if (arg === '-d') {
            dirsOnly = true;
        }
        else if (arg === '-a') {
            showAll = true;
        }
        else if (arg === '--noreport') {
            noReport = true;
        }
        else if (arg.startsWith('-')) {
            ctx.stderr.write(arg.startsWith('--')
                ? `tree: unrecognized option '${arg}'\n`
                : `tree: invalid option -- '${arg[1]}'\n`);
            ctx.stderr.write('Usage: tree [-adL level] [--noreport] [PATH]\n');
            return 1;
        }
        else {
            targetPath = arg;
        }
    }
    const absPath = resolve(ctx.cwd, targetPath);
    let dirCount = 0;
    let fileCount = 0;
    function printTree(dirPath, prefix, depth) {
        if (depth > maxDepth)
            return;
        try {
            const entries = ctx.vfs.readdir(dirPath)
                // Real `tree` hides dotfiles unless -a; listing them always left -a
                // with nothing to do.
                .filter((e) => showAll || !e.name.startsWith('.'));
            const filtered = dirsOnly
                ? entries.filter((e) => e.type === 'directory')
                : entries;
            const sorted = filtered.sort((a, b) => a.name.localeCompare(b.name));
            for (let i = 0; i < sorted.length; i++) {
                const entry = sorted[i];
                const isLast = i === sorted.length - 1;
                const connector = isLast ? '└── ' : '├── ';
                ctx.stdout.write(prefix + connector + entry.name + '\n');
                if (entry.type === 'directory') {
                    dirCount++;
                    const newPrefix = prefix + (isLast ? '    ' : '│   ');
                    const fullPath = dirPath === '/' ? '/' + entry.name : dirPath + '/' + entry.name;
                    printTree(fullPath, newPrefix, depth + 1);
                }
                else {
                    fileCount++;
                }
            }
        }
        catch {
            // skip inaccessible dirs
        }
    }
    try {
        ctx.vfs.stat(absPath);
    }
    catch (e) {
        if (e instanceof VFSError) {
            ctx.stderr.write(`tree: '${targetPath}': ${e.message}\n`);
            return 1;
        }
        throw e;
    }
    ctx.stdout.write(targetPath + '\n');
    printTree(absPath, '', 1);
    const summary = dirsOnly
        ? `\n${dirCount} directories\n`
        : `\n${dirCount} directories, ${fileCount} files\n`;
    ctx.stdout.write(summary);
    return 0;
};
export default command;
