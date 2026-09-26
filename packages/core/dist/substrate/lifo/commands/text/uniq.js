import { resolve } from '../../utils/path.js';
import { isVfsError } from '../../../../vfs/vfs-error.js';
const command = async (ctx) => {
    let showCount = false;
    let onlyDuplicates = false;
    let onlyUnique = false;
    const files = [];
    for (const arg of ctx.args) {
        if (arg.startsWith('-') && arg.length > 1) {
            for (let j = 1; j < arg.length; j++) {
                switch (arg[j]) {
                    case 'c':
                        showCount = true;
                        break;
                    case 'd':
                        onlyDuplicates = true;
                        break;
                    case 'u':
                        onlyUnique = true;
                        break;
                }
            }
        }
        else {
            files.push(arg);
        }
    }
    let text = '';
    if (files.length === 0) {
        if (ctx.stdin) {
            text = await ctx.stdin.readAll();
        }
        else {
            await ctx.stderr.write('uniq: missing file operand\n');
            return 1;
        }
    }
    else {
        const path = resolve(ctx.cwd, files[0]);
        try {
            text = (await ctx.vfs.readFileString(path));
        }
        catch (e) {
            if (isVfsError(e)) {
                await ctx.stderr.write(`uniq: ${files[0]}: ${e.message}\n`);
                return 1;
            }
            throw e;
        }
    }
    const lines = text.replace(/\n$/, '').split('\n');
    // Group adjacent duplicates
    const groups = [];
    for (const line of lines) {
        if (groups.length > 0 && groups[groups.length - 1].line === line) {
            groups[groups.length - 1].count++;
        }
        else {
            groups.push({ line, count: 1 });
        }
    }
    for (const group of groups) {
        if (onlyDuplicates && group.count < 2)
            continue;
        if (onlyUnique && group.count > 1)
            continue;
        if (showCount) {
            await ctx.stdout.write(`${String(group.count).padStart(7)} ${group.line}\n`);
        }
        else {
            await ctx.stdout.write(group.line + '\n');
        }
    }
    return 0;
};
export default command;
