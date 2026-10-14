import type { Command, CommandContext, CommandOutputStream } from '../types.js';
import type { VfsCred } from '../../../../runtime/os-contracts.js';
import { resolveJobSpec, type JobTable } from '../../shell/jobs.js';
import { formatSignalList, parseSignalName, signalOperand } from '../../shell/signals.js';

const USAGE = 'kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]\n';

/** What a host did with a signal `kill` handed it: `not-permitted` for a process no shell may signal (the session's own shell). */
export type HostSignalResult = 'delivered' | 'no-such-process' | 'unsupported' | 'not-permitted';

/**
 * The processes of the session's table a shell's `kill` reaches by pid, past
 * its own jobs, and how a signal is delivered to each: a hosted session's
 * resident servers, another shell's jobs. `kill` consults it only for a
 * numeric operand that names none of the shell's jobs; a jobspec always
 * names one of the shell's own.
 */
export interface HostProcessSignals {
  /** Whether `pid` is a live process of this host. `kill -0` asks only this. */
  isLive(pid: number): boolean;
  /**
   * Deliver `signal` (a parsed name, never `0`) to a live pid of this host,
   * from `caller`, whom kill(2)'s rule may refuse (`not-permitted`). A
   * teardown step that failed without keeping the process alive is reported
   * on `stderr`.
   */
  signal(pid: number, signal: string, stderr: CommandOutputStream, caller: Readonly<VfsCred>): Promise<HostSignalResult>;
}

/**
 * `kill` from `caller`, by the shell's builtin with its `jobs`, or as a
 * program, which has no jobs and finds a jobspec names none (procps kill).
 */
export async function runKill(
  ctx: Pick<CommandContext, 'args' | 'stdout' | 'stderr'>,
  caller: Readonly<VfsCred>,
  jobs: Pick<JobTable, 'list' | 'byPid' | 'signal'> | null,
  host?: HostProcessSignals,
): Promise<number> {
  const args = ctx.args;
  if (args[0] === '-l' || args[0] === '-L' || args[0] === '--list') {
    if (args.length === 1) { await ctx.stdout.write(formatSignalList()); return 0; }
    let status = 0;
    for (const operand of args.slice(1)) {
      const result = signalOperand(operand);
      if (result === null) { await ctx.stderr.write(`kill: ${operand}: invalid signal specification\n`); status = 1; }
      else await ctx.stdout.write(result + '\n');
    }
    return status;
  }
  let index = 0;
  let signal = 'TERM';
  if (args[0]?.startsWith('-') && args[0] !== '--') {
    const flag = args[index++];
    let raw: string | undefined;
    if (flag === '-s' || flag === '-n') raw = args[index++];
    else if (flag.startsWith('-s') || flag.startsWith('-n')) raw = flag.slice(2);
    else raw = flag.slice(1);
    if (raw === undefined) { await ctx.stderr.write(`kill: ${flag}: option requires an argument\n`); return 1; }
    const parsed = parseSignalName(raw);
    if (parsed === null) { await ctx.stderr.write(`kill: ${raw}: invalid signal specification\n`); return 1; }
    signal = parsed;
  }
  if (args[index] === '--') index++;
  if (index === args.length) { await ctx.stderr.write(USAGE); return 2; }
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
      if (signal !== '0' && jobs?.signal(job, signal, caller) === false) {
        await ctx.stderr.write(`kill: (${job.pid}) - Operation not permitted\n`);
        status = 1;
      }
      continue;
    }
    if (!/^\d+$/.test(target)) { await ctx.stderr.write(`kill: \`${target}': not a pid or valid job spec\n`); status = 1; continue; }
    const pid = Number(target);
    const job = jobs?.byPid(pid);
    if (job && job.status !== 'done') {
      if (signal !== '0' && jobs?.signal(job, signal, caller) === false) {
        await ctx.stderr.write(`kill: (${pid}) - Operation not permitted\n`);
        status = 1;
      }
      continue;
    }
    if (host?.isLive(pid) === true) {
      if (signal === '0') continue;
      const result = await host.signal(pid, signal, ctx.stderr, caller);
      if (result === 'delivered') continue;
      await ctx.stderr.write(result === 'unsupported'
        ? `kill: (${pid}) - Operation not supported (SIG${signal} cannot be delivered to a hosted process)\n`
        : result === 'not-permitted' ? `kill: (${pid}) - Operation not permitted\n` : `kill: (${pid}) - No such process\n`);
      status = 1;
      continue;
    }
    await ctx.stderr.write(`kill: (${pid}) - No such process\n`);
    status = 1;
  }
  return status;
}

/** `kill` as a program (`xargs kill`, `sudo kill`): it reaches the processes `host` does. */
export function createKillCommand(host?: HostProcessSignals): Command {
  return async (ctx) => await runKill(ctx, ctx.cred, null, host);
}
