import { parseArgs } from '../../utils/args.js';
import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
import { getMimeType, isBinaryMime } from '../../utils/mime.js';
const spec = {
    'body-numbering': { type: 'string', short: 'b' },
    'number-width': { type: 'string', short: 'w' },
};
const command = async (ctx) => {
    const parsed = parseArgs('nl', ctx.args, spec);
    if (!parsed.ok) {
        ctx.stderr.write(parsed.error);
        return 1;
    }
    const { flags, positional } = parsed;
    const style = flags['body-numbering'] || 't';
    const width = parseInt(flags['number-width'] || '6', 10);
    let content;
    if (positional.length === 0 || positional[0] === '-') {
        if (ctx.stdin) {
            content = await ctx.stdin.readAll();
        }
        else {
            ctx.stderr.write('nl: missing operand\n');
            return 1;
        }
    }
    else {
        const path = resolve(ctx.cwd, positional[0]);
        if (isBinaryMime(getMimeType(path))) {
            ctx.stderr.write(`nl: ${positional[0]}: binary file, skipping
`);
            return 1;
        }
        try {
            content = ctx.vfs.readFileString(path);
        }
        catch (e) {
            if (e instanceof VFSError) {
                ctx.stderr.write(`nl: ${positional[0]}: ${e.message}\n`);
                return 1;
            }
            throw e;
        }
    }
    const lines = content.split('\n');
    // If content ends with \n, the last element is empty and shouldn't be numbered
    const hasTrailingNewline = content.endsWith('\n');
    let lineNum = 1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip last empty element from trailing newline
        if (i === lines.length - 1 && hasTrailingNewline && line === '') {
            break;
        }
        const shouldNumber = style === 'a' ? true : // all lines
            style === 't' ? line.length > 0 : // non-empty (default)
                false; // 'n' = none
        if (shouldNumber) {
            ctx.stdout.write(`${String(lineNum).padStart(width, ' ')}\t${line}\n`);
            lineNum++;
        }
        else {
            ctx.stdout.write(`${' '.repeat(width)}\t${line}\n`);
        }
    }
    return 0;
};
export default command;
