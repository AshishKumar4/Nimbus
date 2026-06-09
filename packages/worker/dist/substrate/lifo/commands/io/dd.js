import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
const command = async (ctx) => {
    const parsed = parseOptions(ctx.args);
    if (!parsed.ok) {
        ctx.stderr.write(`dd: ${parsed.error}\n`);
        return 1;
    }
    let data;
    try {
        data = await readInput(ctx.stdin, parsed.options, ctx);
    }
    catch (error) {
        ctx.stderr.write(`dd: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
    try {
        writeOutput(data, parsed.options, ctx);
    }
    catch (error) {
        ctx.stderr.write(`dd: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
    if (parsed.options.status !== 'none') {
        ctx.stderr.write(`${data.length} bytes copied\n`);
    }
    return 0;
};
function parseOptions(args) {
    const options = { blockSize: 512, status: 'default' };
    for (const arg of args) {
        const operand = parseOperand(arg);
        if (!operand)
            return { ok: false, error: `unrecognized operand '${arg}'` };
        switch (operand.name) {
            case 'bs':
                options.blockSize = parsePositiveInteger(operand.value);
                if (options.blockSize <= 0)
                    return { ok: false, error: `invalid block size '${operand.value}'` };
                break;
            case 'count': {
                const count = parseNonNegativeInteger(operand.value);
                if (count < 0)
                    return { ok: false, error: `invalid count '${operand.value}'` };
                options.count = count;
                break;
            }
            case 'if':
                options.input = operand.value;
                break;
            case 'of':
                options.output = operand.value;
                break;
            case 'status':
                if (operand.value !== 'none')
                    return { ok: false, error: `unsupported status '${operand.value}'` };
                options.status = 'none';
                break;
            default:
                return { ok: false, error: `unrecognized operand '${operand.name}'` };
        }
    }
    return { ok: true, options };
}
function parseOperand(arg) {
    const separator = arg.indexOf('=');
    if (separator <= 0)
        return null;
    return { name: arg.slice(0, separator), value: arg.slice(separator + 1) };
}
function parsePositiveInteger(value) {
    const n = parseNonNegativeInteger(value);
    return n > 0 ? n : -1;
}
function parseNonNegativeInteger(value) {
    if (value.length === 0)
        return -1;
    let n = 0;
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 48 || code > 57)
            return -1;
        n = n * 10 + code - 48;
    }
    return n;
}
async function readInput(stdin, options, ctx) {
    if (options.input && options.input !== '/dev/stdin' && options.input !== '-') {
        if (options.input === '/dev/null')
            return '';
        if (options.input === '/dev/tty') {
            if (!ctx.terminalStdin)
                throw new Error('/dev/tty: no controlling terminal');
            return readFromStream(ctx.terminalStdin, options);
        }
        try {
            const content = ctx.vfs.readFileString(resolve(ctx.cwd, options.input));
            return limitContent(content, options);
        }
        catch (error) {
            if (error instanceof VFSError)
                throw new Error(`${options.input}: ${error.message}`);
            throw error;
        }
    }
    if (!stdin)
        throw new Error('standard input: Bad file descriptor');
    return readFromStream(stdin, options);
}
async function readFromStream(stdin, options) {
    const limit = byteLimit(options);
    if (limit === undefined)
        return stdin.readAll();
    if (limit === 0)
        return '';
    let output = '';
    while (output.length < limit) {
        const chunk = stdin.readBytes
            ? await stdin.readBytes(limit - output.length)
            : await stdin.read();
        if (chunk === null)
            break;
        output += chunk.slice(0, limit - output.length);
    }
    return output;
}
function limitContent(content, options) {
    const limit = byteLimit(options);
    return limit === undefined ? content : content.slice(0, limit);
}
function byteLimit(options) {
    return options.count === undefined ? undefined : options.count * options.blockSize;
}
function writeOutput(data, options, ctx) {
    if (!options.output || options.output === '-' || options.output === '/dev/stdout') {
        ctx.stdout.write(data);
        return;
    }
    if (options.output === '/dev/stderr') {
        ctx.stderr.write(data);
        return;
    }
    if (options.output === '/dev/null')
        return;
    ctx.vfs.writeFile(resolve(ctx.cwd, options.output), data);
}
export default command;
