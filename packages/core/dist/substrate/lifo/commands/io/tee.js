import { resolve } from '../../utils/path.js';
const command = async (ctx) => {
    let append = false;
    const files = [];
    for (const arg of ctx.args) {
        if (arg === '-a') {
            append = true;
        }
        else {
            files.push(arg);
        }
    }
    let text = '';
    if (ctx.stdin) {
        text = await ctx.stdin.readAll();
    }
    // Write to stdout
    await ctx.stdout.write(text);
    // Write to each file
    for (const file of files) {
        const path = resolve(ctx.cwd, file);
        if (append) {
            (await ctx.vfs.appendFile(path, text));
        }
        else {
            (await ctx.vfs.writeFile(path, text));
        }
    }
    return 0;
};
export default command;
