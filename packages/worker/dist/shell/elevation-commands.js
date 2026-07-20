import { CRED_KERNEL } from '../runtime/os-contracts.js';
import { credForUnixUser, findUnixUser } from './unix-accounts.js';
function symbolicUmask(mask) {
    const permissions = 0o777 & ~mask;
    const classText = (shift) => {
        const bits = (permissions >> shift) & 0o7;
        return `${bits & 0o4 ? 'r' : ''}${bits & 0o2 ? 'w' : ''}${bits & 0o1 ? 'x' : ''}`;
    };
    return `u=${classText(6)},g=${classText(3)},o=${classText(0)}`;
}
export function createUmaskCommand() {
    return async (ctx) => {
        if (!ctx.cred) {
            ctx.stderr.write('umask: process credential is unavailable\n');
            return 1;
        }
        if (ctx.args.length === 0 || (ctx.args.length === 1 && ctx.args[0] === '-S')) {
            ctx.stdout.write(ctx.args[0] === '-S'
                ? `${symbolicUmask(ctx.cred.umask)}\n`
                : `${ctx.cred.umask.toString(8).padStart(4, '0')}\n`);
            return 0;
        }
        if (ctx.args.length !== 1 || !/^[0-7]{1,4}$/.test(ctx.args[0])) {
            ctx.stderr.write(`umask: invalid mask: ${ctx.args.join(' ')}\n`);
            return 1;
        }
        const mask = Number.parseInt(ctx.args[0], 8);
        if (mask > 0o777 || !ctx.setUmask) {
            ctx.stderr.write(`umask: invalid mask: ${ctx.args[0]}\n`);
            return 1;
        }
        ctx.setUmask(mask);
        return 0;
    };
}
function targetCredential(ctx, name) {
    if (!ctx.cred)
        throw new Error('process credential is unavailable');
    const user = findUnixUser(ctx.vfs, name);
    if (!user)
        throw new Error(`unknown user: ${name}`);
    if (user.uid === 0)
        return CRED_KERNEL;
    return credForUnixUser(ctx.vfs, user, ctx.cred.umask);
}
async function runAs(commandName, ctx, userName, argv) {
    if (!ctx.runAs) {
        ctx.stderr.write(`${commandName}: process spawning is unavailable\n`);
        return 1;
    }
    try {
        return await ctx.runAs(targetCredential(ctx, userName), argv);
    }
    catch (error) {
        ctx.stderr.write(`${commandName}: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
}
export function createSudoCommand() {
    return async (ctx) => {
        let userName = 'root';
        let index = 0;
        if (ctx.args[index] === '-u') {
            userName = ctx.args[index + 1] ?? '';
            index += 2;
            if (!userName) {
                ctx.stderr.write('sudo: option -u requires a user\n');
                return 1;
            }
        }
        const argv = ctx.args.slice(index);
        if (argv.length === 0) {
            ctx.stderr.write('sudo: a command is required\n');
            return 1;
        }
        return runAs('sudo', ctx, userName, argv);
    };
}
export function createSuCommand() {
    return async (ctx) => {
        let index = 0;
        while (ctx.args[index] === '-' || ctx.args[index] === '-l' || ctx.args[index] === '--login')
            index++;
        let userName = 'root';
        const candidate = ctx.args[index];
        if (candidate && candidate !== '-c' && candidate !== '--command') {
            userName = candidate;
            index++;
        }
        let argv = ['sh'];
        if (ctx.args[index] === '-c' || ctx.args[index] === '--command') {
            const command = ctx.args[index + 1];
            if (command === undefined) {
                ctx.stderr.write('su: option -c requires a command\n');
                return 1;
            }
            if (index + 2 !== ctx.args.length) {
                ctx.stderr.write('su: unexpected operand\n');
                return 1;
            }
            argv = ['sh', '-c', command];
        }
        else if (index !== ctx.args.length) {
            ctx.stderr.write('su: unexpected operand\n');
            return 1;
        }
        return runAs('su', ctx, userName, argv);
    };
}
