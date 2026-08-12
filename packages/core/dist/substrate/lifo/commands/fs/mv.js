import { resolve, basename, dirname } from '../../utils/path.js';
import { parseArgs } from '../../utils/args.js';
import { VFSError, ErrorCode } from '../../kernel/vfs/index.js';
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
        ctx.stdout.write('Usage: mv [-fnv] SOURCE... DEST\n');
        ctx.stdout.write('  -f          overwrite the destination without prompting\n');
        ctx.stdout.write('  -n          never overwrite an existing destination\n');
        ctx.stdout.write('  -v          print each move\n');
        ctx.stdout.write('  -t DIR      move every SOURCE into DIR\n');
        return 0;
    }
    if (unknown.length > 0) {
        ctx.stderr.write(`mv: invalid option -- '${unknown[0].replace(/^-+/, '')}'\n`);
        return 1;
    }
    const targetDir = typeof flags['target-directory'] === 'string' && flags['target-directory']
        ? flags['target-directory']
        : null;
    const sources = targetDir ? positional : positional.slice(0, -1);
    const rawDest = targetDir ?? positional[positional.length - 1];
    if (sources.length === 0 || rawDest === undefined) {
        ctx.stderr.write('mv: missing operand\n');
        return 1;
    }
    const dest = resolve(ctx.cwd, rawDest);
    const destIsDir = isDirectory(ctx, dest);
    if (sources.length > 1 && !destIsDir) {
        ctx.stderr.write(`mv: target '${rawDest}' is not a directory\n`);
        return 1;
    }
    let exitCode = 0;
    for (const source of sources) {
        const src = resolve(ctx.cwd, source);
        const target = destIsDir ? resolve(dest, basename(src)) : dest;
        if (flags['no-clobber'] && ctx.vfs.exists(target))
            continue;
        try {
            moveOne(ctx, src, target);
            if (flags.verbose)
                ctx.stdout.write(`renamed '${source}' -> '${rawDest}'\n`);
        }
        catch (e) {
            if (e instanceof VFSError) {
                ctx.stderr.write(`mv: ${e.message}\n`);
                exitCode = 1;
                continue;
            }
            throw e;
        }
    }
    return exitCode;
};
/**
 * rename(2) reports EXDEV when the two paths live on different filesystems —
 * `/tmp` and `$HOME` are separate mounts here, which is the shape every
 * `mv "$tmp/download" "$HOME/bin/tool"` installer uses. Like `mv(1)`, fall
 * back to a copy followed by removing the source.
 */
function moveOne(ctx, src, target) {
    try {
        ctx.vfs.rename(src, target);
        return;
    }
    catch (e) {
        if (!(e instanceof VFSError) || e.code !== ErrorCode.EXDEV)
            throw e;
    }
    copyAcross(ctx, src, target);
    removeRecursive(ctx, src);
}
function copyAcross(ctx, src, target) {
    if (isDirectory(ctx, src)) {
        ctx.vfs.mkdir(target, { recursive: true });
        for (const entry of ctx.vfs.readdir(src)) {
            copyAcross(ctx, `${src}/${entry.name}`, `${target}/${entry.name}`);
        }
        return;
    }
    const parent = dirname(target);
    try {
        ctx.vfs.mkdir(parent, { recursive: true });
    }
    catch { /* exists */ }
    ctx.vfs.writeFile(target, ctx.vfs.readFile(src));
    ctx.vfs.chmod(target, ctx.vfs.stat(src).mode);
}
function removeRecursive(ctx, path) {
    if (!isDirectory(ctx, path)) {
        ctx.vfs.unlink(path);
        return;
    }
    for (const entry of ctx.vfs.readdir(path))
        removeRecursive(ctx, `${path}/${entry.name}`);
    ctx.vfs.rmdir(path);
}
function isDirectory(ctx, path) {
    try {
        return ctx.vfs.stat(path).type === 'directory';
    }
    catch {
        return false;
    }
}
export default command;
