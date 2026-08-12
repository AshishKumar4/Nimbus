import { parseArgs } from '../../utils/args.js';
import { resolve } from '../../utils/path.js';
const spec = {
    directory: { type: 'boolean', short: 'd' },
    tmpdir: { type: 'string', short: 'p' },
};
function randomChars(n) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < n; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}
const command = async (ctx) => {
    const parsed = parseArgs('mktemp', ctx.args, spec);
    if (!parsed.ok) {
        ctx.stderr.write(parsed.error);
        return 1;
    }
    const { flags, positional } = parsed;
    const dir = flags.tmpdir || '/tmp';
    const template = positional[0] || 'tmp.XXXXXXXXXX';
    // Replace X's at end with random chars
    const xMatch = template.match(/X+$/);
    const xCount = xMatch ? xMatch[0].length : 0;
    const name = xCount > 0
        ? template.slice(0, -xCount) + randomChars(xCount)
        : template + '.' + randomChars(10);
    const fullPath = resolve(dir, name);
    try {
        // Ensure parent dir exists
        try {
            ctx.vfs.stat(dir);
        }
        catch {
            ctx.vfs.mkdir(dir, { recursive: true });
        }
        if (flags.directory) {
            ctx.vfs.mkdir(fullPath);
        }
        else {
            ctx.vfs.writeFile(fullPath, '');
        }
        ctx.stdout.write(fullPath + '\n');
        return 0;
    }
    catch (e) {
        ctx.stderr.write(`mktemp: failed to create ${flags.directory ? 'directory' : 'file'}: ${e.message}\n`);
        return 1;
    }
};
export default command;
