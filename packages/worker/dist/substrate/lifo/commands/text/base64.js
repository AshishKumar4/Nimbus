import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
function toBase64(data) {
    let binary = '';
    for (let i = 0; i < data.length; i++) {
        binary += String.fromCharCode(data[i]);
    }
    return btoa(binary);
}
function fromBase64(str) {
    try {
        return atob(str.replace(/\s/g, ''));
    }
    catch {
        throw new Error('invalid input');
    }
}
const command = async (ctx) => {
    let decode = false;
    let wrap = 76;
    const files = [];
    for (let i = 0; i < ctx.args.length; i++) {
        const arg = ctx.args[i];
        if (arg === '-d' || arg === '--decode') {
            decode = true;
        }
        else if (arg === '-w' || arg === '--wrap') {
            const value = ctx.args[++i];
            if (value === undefined) {
                ctx.stderr.write(`base64: option '${arg}' requires an argument\n`);
                return 1;
            }
            wrap = parseInt(value, 10);
            if (isNaN(wrap) || wrap < 0) {
                ctx.stderr.write(`base64: invalid wrap size: '${value}'\n`);
                return 1;
            }
        }
        else if (arg.startsWith('--wrap=')) {
            wrap = parseInt(arg.slice('--wrap='.length), 10);
            if (isNaN(wrap) || wrap < 0) {
                ctx.stderr.write(`base64: invalid wrap size: '${arg.slice('--wrap='.length)}'\n`);
                return 1;
            }
        }
        else if (arg === '-i' || arg === '--ignore-garbage') {
            // Decoding already strips whitespace and rejects nothing else, so this
            // asks for the behaviour that is already in effect.
        }
        else if (arg !== '-' && arg.startsWith('-')) {
            // Anything else used to be dropped, so `base64 -D file` silently
            // ENCODED the file instead of decoding it.
            ctx.stderr.write(arg.startsWith('--')
                ? `base64: unrecognized option '${arg}'\n`
                : `base64: invalid option -- '${arg[1]}'\n`);
            ctx.stderr.write("Usage: base64 [-d] [-w COLS] [FILE]\n");
            return 1;
        }
        else {
            files.push(arg);
        }
    }
    let input;
    if (files.length === 1 && files[0] === '-') {
        // Explicit stdin via '-'
        if (ctx.stdin) {
            input = await ctx.stdin.readAll();
        }
        else {
            ctx.stderr.write('base64: missing input\n');
            return 1;
        }
    }
    else if (files.length === 0) {
        ctx.stderr.write(`Usage: base64 [-d] [-w COLS] [FILE]\n`);
        ctx.stderr.write(`Encode or decode base64. Use '-' to read from stdin.\n`);
        return 1;
    }
    else {
        const path = resolve(ctx.cwd, files[0]);
        try {
            if (decode) {
                input = ctx.vfs.readFileString(path);
            }
            else {
                input = ctx.vfs.readFile(path);
            }
        }
        catch (e) {
            if (e instanceof VFSError) {
                ctx.stderr.write(`base64: ${files[0]}: ${e.message}\n`);
                return 1;
            }
            throw e;
        }
    }
    if (decode) {
        try {
            const text = typeof input === 'string' ? input : new TextDecoder().decode(input);
            ctx.stdout.write(fromBase64(text));
        }
        catch {
            ctx.stderr.write('base64: invalid input\n');
            return 1;
        }
    }
    else {
        let data;
        if (typeof input === 'string') {
            data = new TextEncoder().encode(input);
        }
        else {
            data = input;
        }
        let encoded = toBase64(data);
        // Wrap lines
        if (wrap > 0) {
            const wrapped = [];
            for (let i = 0; i < encoded.length; i += wrap) {
                wrapped.push(encoded.slice(i, i + wrap));
            }
            encoded = wrapped.join('\n');
        }
        ctx.stdout.write(encoded + '\n');
    }
    return 0;
};
export default command;
