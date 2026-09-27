import type { Command, CommandContext, CommandOutputStream } from '../types.js';
import type { ProcessRegistry } from '../../shell/ProcessRegistry.js';
import { resolveJobSpec } from '../../shell/jobs.js';
import { formatSignalList, parseSignalName, signalOperand } from '../../shell/signals.js';

interface KillJob { id: number; command: string; pid?: number }
const USAGE = 'kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]\n';

/** What a host did with a signal `kill` handed it. */
export type HostSignalResult = 'delivered' | 'no-such-process' | 'unsupported';

/**
 * Processes a host runs outside the shell's own registry, in the host's own
 * pid space: a hosted session's resident servers. `kill` consults it only for
 * a numeric operand the shell's registry does not hold; a jobspec always
 * names one of the shell's own jobs.
 */
export interface HostProcessSignals {
  /** Whether `pid` is a live process of this host. `kill -0` asks only this. */
  isLive(pid: number): boolean;
  /**
   * Deliver `signal` (a parsed name, never `0`) to a live pid of this host.
   * A teardown step that failed without keeping the process alive is
   * reported on `stderr`.
   */
  signal(pid: number, signal: string, stderr: CommandOutputStream): Promise<HostSignalResult>;
}

export async function runKill(
  ctx: Pick<CommandContext, 'args' | 'stdout' | 'stderr'>,
  processes: ProcessRegistry,
  jobs: readonly KillJob[],
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
    let pid: number | undefined;
    const byJob = target.startsWith('%');
    if (byJob) {
      const job = resolveJobSpec(target, jobs);
      if (!job || job === 'ambiguous') {
        await ctx.stderr.write(`kill: ${target}: ${job === 'ambiguous' ? 'ambiguous job spec' : 'no such job'}\n`);
        status = 1;
        continue;
      }
      pid = job.pid;
    } else if (/^\d+$/.test(target)) pid = Number(target);
    else { await ctx.stderr.write(`kill: \`${target}': not a pid or valid job spec\n`); status = 1; continue; }
    const proc = pid === undefined ? undefined : processes.get(pid);
    if (!proc || !byJob && proc.status === 'zombie') {
      if (!byJob && pid !== undefined && host?.isLive(pid) === true) {
        if (signal === '0') continue;
        const result = await host.signal(pid, signal, ctx.stderr);
        if (result === 'delivered') continue;
        await ctx.stderr.write(result === 'unsupported'
          ? `kill: (${pid}) - Operation not supported (SIG${signal} cannot be delivered to a hosted process)\n`
          : `kill: (${pid}) - No such process\n`);
        status = 1;
        continue;
      }
      await ctx.stderr.write(`kill: (${pid ?? target}) - No such process\n`);
      status = 1;
      continue;
    }
    if (signal === '0') continue;
    if (!processes.kill(proc.pid, signal)) {
      await ctx.stderr.write(`kill: (${proc.pid}) - Operation not permitted (cannot kill shell)\n`);
      status = 1;
    }
  }
  return status;
}

export function createKillCommand(processes: ProcessRegistry, host?: HostProcessSignals): Command {
  return async (ctx) => {
    const jobs = new Map<number, KillJob>();
    for (const proc of processes.getBackgroundJobs()) {
      if (proc.jobId !== undefined) jobs.set(proc.jobId, { id: proc.jobId, command: proc.args.join(' '), pid: proc.pid });
    }
    return await runKill(ctx, processes, [...jobs.values()], host);
  };
}
