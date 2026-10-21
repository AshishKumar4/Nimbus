import { getopt } from '../../utils/args.js';
import { isVfsError, VFS_STRERROR } from '../../../../vfs/vfs-error.js';
/**
 * GNU coreutils env's options, all of them, so a long prefix is ambiguous
 * where GNU's is (`--ign`). Its optstring begins with `+`: the first operand
 * ends them, as the command takes what follows.
 */
const ENV_OPTIONS = {
    short: 'C:iS:u:v0',
    long: {
        'block-signal': ['block-signal', 'optional'],
        chdir: ['C', 'required'],
        debug: ['v', 'none'],
        'default-signal': ['default-signal', 'optional'],
        help: ['help', 'none'],
        'ignore-environment': ['i', 'none'],
        'ignore-signal': ['ignore-signal', 'optional'],
        'list-signal-handling': ['list-signal-handling', 'none'],
        null: ['0', 'none'],
        'split-string': ['S', 'required'],
        unset: ['u', 'required'],
        version: ['version', 'none'],
    },
};
/** What GNU names each option env has but does not take, in its refusal. */
const UNSUPPORTED = {
    C: '--chdir', S: '--split-string', v: '--debug', help: '--help', version: '--version',
    'block-signal': '--block-signal', 'default-signal': '--default-signal',
    'ignore-signal': '--ignore-signal', 'list-signal-handling': '--list-signal-handling',
};
/**
 * env [-i] [-0] [-u NAME]... [--] [NAME=VALUE]... [COMMAND [ARG]...], as GNU
 * coreutils' env: COMMAND runs as a child with the environment the options
 * and assignments make; with none, that environment is printed, one entry a
 * line (NUL-ended with -0). A COMMAND that cannot be found is 127, one that
 * may not run 126, a bad option or name 125; otherwise env's status is
 * COMMAND's.
 */
const command = async (ctx) => {
    const fail = async (message, usage) => {
        await ctx.stderr.write(`env: ${message}\n${usage ? "Try 'env --help' for more information.\n" : ''}`);
        return 125;
    };
    let ignore = false;
    let nul = false;
    const unset = [];
    const operands = [];
    for (const event of getopt(ctx.args, ENV_OPTIONS, { stopAtOperand: true })) {
        if (event.kind === 'error')
            return await fail(event.message, true);
        if (event.kind === 'operand')
            operands.push(event.value);
        else if (event.key === 'i')
            ignore = true;
        else if (event.key === '0')
            nul = true;
        else if (event.key === 'u')
            unset.push(event.value ?? '');
        else
            return await fail(`${UNSUPPORTED[event.key] ?? event.key} is not supported`, false);
    }
    // A lone `-` first is GNU's older spelling of -i.
    if (operands[0] === '-') {
        ignore = true;
        operands.shift();
    }
    // As GNU applies them: -i, else each -u (unsetenv's rule for a name), then
    // each operand with an `=` in it, as putenv takes one (`=x` too). A Map, as
    // any name is a name (`__proto__`), in the order environ keeps.
    const env = new Map(ignore ? [] : Object.entries(ctx.env));
    if (!ignore) {
        for (const name of unset) {
            if (name === '' || name.includes('='))
                return await fail(`cannot unset '${name}': Invalid argument`, false);
            env.delete(name);
        }
    }
    while (operands.length > 0 && operands[0].includes('=')) {
        const assignment = operands.shift() ?? '';
        const at = assignment.indexOf('=');
        env.set(assignment.slice(0, at), assignment.slice(at + 1));
    }
    if (operands.length === 0) {
        const end = nul ? '\0' : '\n';
        for (const [key, value] of env)
            await ctx.stdout.write(`${key}=${value}${end}`);
        return 0;
    }
    if (nul)
        return await fail('cannot specify --null (-0) with command', true);
    let ended;
    try {
        ended = await ctx.runAs(ctx.cred, operands, { parent: { ...ctx, env: Object.fromEntries(env) } });
    }
    catch (error) {
        if (!isVfsError(error) || error.syscall !== 'execvp')
            throw error;
        await ctx.stderr.write(`env: '${operands[0]}': ${error.detail ?? VFS_STRERROR[error.code]}\n`);
        // GNU's: 127 for a program not found, 126 for one found that could not be run.
        return error.code === 'ENOENT' ? 127 : 126;
    }
    return ended.status;
};
export default command;
