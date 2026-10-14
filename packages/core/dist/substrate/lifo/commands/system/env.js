import { isVfsError, VFS_STRERROR } from '../../../../vfs/vfs-error.js';
/**
 * env [-i] [-0] [-u NAME]... [--] [NAME=VALUE]... [COMMAND [ARG]...], as GNU
 * coreutils' env: COMMAND runs as a child with the environment the options
 * and assignments make; with none, that environment is printed, one entry a
 * line (NUL-ended with -0). A COMMAND that cannot be found is 127, one that
 * may not run 126, a bad option 125; otherwise env's status is COMMAND's.
 */
const command = async (ctx) => {
    const args = [...ctx.args];
    let env = { ...ctx.env };
    let nul = false;
    const usage = async (message) => {
        await ctx.stderr.write(`env: ${message}\nTry 'env --help' for more information.\n`);
        return 125;
    };
    while (args.length > 0 && args[0].startsWith('-')) {
        const option = args.shift() ?? '';
        if (option === '--')
            break;
        if (option === '-' || option === '-i' || option === '--ignore-environment')
            env = {};
        else if (option === '-0' || option === '--null')
            nul = true;
        else if (option === '-u' || option === '--unset') {
            const name = args.shift();
            if (name === undefined)
                return await usage(`option requires an argument -- 'u'`);
            delete env[name];
        }
        else if (option.startsWith('--unset='))
            delete env[option.slice('--unset='.length)];
        else if (option.startsWith('-u'))
            delete env[option.slice(2)];
        else
            return await usage(option.startsWith('--') ? `unrecognized option '${option}'` : `invalid option -- '${option[1]}'`);
    }
    while (args.length > 0 && args[0].indexOf('=') > 0) {
        const assignment = args.shift() ?? '';
        const at = assignment.indexOf('=');
        env[assignment.slice(0, at)] = assignment.slice(at + 1);
    }
    if (args.length === 0) {
        const end = nul ? '\0' : '\n';
        for (const [key, value] of Object.entries(env))
            await ctx.stdout.write(`${key}=${value}${end}`);
        return 0;
    }
    if (nul)
        return await usage('cannot specify --null (-0) with command');
    let ended;
    try {
        ended = await ctx.runAs(ctx.cred, args, { parent: { ...ctx, env } });
    }
    catch (error) {
        if (!isVfsError(error) || error.syscall !== 'execvp')
            throw error;
        await ctx.stderr.write(`env: '${args[0]}': ${VFS_STRERROR[error.code]}\n`);
        return error.code === 'EACCES' ? 126 : 127;
    }
    return ended.status;
};
export default command;
