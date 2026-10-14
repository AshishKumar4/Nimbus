import { resolveJobSpec } from '../../shell/jobs.js';
import { formatSignalList, parseSignalName, signalOperand } from '../../shell/signals.js';
const USAGE = 'kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]\n';
/**
 * `kill` from `caller`, by the shell's builtin with its `jobs`, or as a
 * program, which has no jobs and finds a jobspec names none (procps kill).
 */
export async function runKill(ctx, caller, jobs, host) {
    const args = ctx.args;
    if (args[0] === '-l' || args[0] === '-L' || args[0] === '--list') {
        if (args.length === 1) {
            await ctx.stdout.write(formatSignalList());
            return 0;
        }
        let status = 0;
        for (const operand of args.slice(1)) {
            const result = signalOperand(operand);
            if (result === null) {
                await ctx.stderr.write(`kill: ${operand}: invalid signal specification\n`);
                status = 1;
            }
            else
                await ctx.stdout.write(result + '\n');
        }
        return status;
    }
    let index = 0;
    let signal = 'TERM';
    if (args[0]?.startsWith('-') && args[0] !== '--') {
        const flag = args[index++];
        let raw;
        if (flag === '-s' || flag === '-n')
            raw = args[index++];
        else if (flag.startsWith('-s') || flag.startsWith('-n'))
            raw = flag.slice(2);
        else
            raw = flag.slice(1);
        if (raw === undefined) {
            await ctx.stderr.write(`kill: ${flag}: option requires an argument\n`);
            return 1;
        }
        const parsed = parseSignalName(raw);
        if (parsed === null) {
            await ctx.stderr.write(`kill: ${raw}: invalid signal specification\n`);
            return 1;
        }
        signal = parsed;
    }
    if (args[index] === '--')
        index++;
    if (index === args.length) {
        await ctx.stderr.write(USAGE);
        return 2;
    }
    let status = 0;
    for (const target of args.slice(index)) {
        const byJob = target.startsWith('%');
        if (byJob) {
            const job = resolveJobSpec(target, jobs?.list() ?? []);
            if (!job || job === 'ambiguous') {
                await ctx.stderr.write(`kill: ${target}: ${job === 'ambiguous' ? 'ambiguous job spec' : 'no such job'}\n`);
                status = 1;
                continue;
            }
            if (jobs && !(await reported(ctx.stderr, job.pid, signal, jobs.signal(job, signal, caller))))
                status = 1;
            continue;
        }
        if (!/^\d+$/.test(target)) {
            await ctx.stderr.write(`kill: \`${target}': not a pid or valid job spec\n`);
            status = 1;
            continue;
        }
        const pid = Number(target);
        const job = jobs?.byPid(pid);
        if (jobs && job && job.status !== 'done') {
            if (!(await reported(ctx.stderr, pid, signal, jobs.signal(job, signal, caller))))
                status = 1;
            continue;
        }
        if (host?.isLive(pid) === true) {
            if (!(await reported(ctx.stderr, pid, signal, await host.signal(pid, signal, ctx.stderr, caller))))
                status = 1;
            continue;
        }
        await ctx.stderr.write(`kill: (${pid}) - No such process\n`);
        status = 1;
    }
    return status;
}
/** Whether `signal` reached `pid`; what kill says when it did not. */
async function reported(stderr, pid, signal, result) {
    if (result === 'delivered')
        return true;
    await stderr.write(result === 'unsupported'
        ? `kill: (${pid}) - Operation not supported (SIG${signal} cannot be delivered to a hosted process)\n`
        : result === 'not-permitted' ? `kill: (${pid}) - Operation not permitted\n` : `kill: (${pid}) - No such process\n`);
    return false;
}
/** `kill` as a program (`xargs kill`, `sudo kill`): it reaches the processes `host` does. */
export function createKillCommand(host) {
    return async (ctx) => await runKill(ctx, ctx.cred, null, host);
}
