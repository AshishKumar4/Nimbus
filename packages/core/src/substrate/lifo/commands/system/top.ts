import type { Command } from '../types.js';
import type { SessionProcessSupervisor } from '../../../../runtime/session-process-supervisor.js';
import { formatUptime, readHeapMemory, uptimeSeconds } from '../../utils/system-info.js';

/** `top` over the session's process table, as its observers are told it. Nothing in it stops a process. */
export function createTopCommand(processes: Pick<SessionProcessSupervisor, 'publishedAll'>): Command {
  return async (ctx) => {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const mins = String(now.getMinutes()).padStart(2, '0');
    const secs = String(now.getSeconds()).padStart(2, '0');

    // CPU info
    const cpuCores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 1 : 1;

    // Memory info, in whole MiB; a runtime that does not report its heap shows top's defaults.
    const memory = readHeapMemory();
    const totalMem = memory ? Math.round(memory.total / (1024 * 1024)) : 256;
    const usedMem = memory ? Math.round(memory.used / (1024 * 1024)) : 16;
    const freeMem = totalMem - usedMem;

    // Process list
    const listed = processes.publishedAll();
    const runningCount = listed.filter(p => p.state === 'running').length;
    const totalTasks = listed.length;

    await ctx.stdout.write(`top - ${hours}:${mins}:${secs} up ${formatUptime(uptimeSeconds())},  1 user\n`);
    await ctx.stdout.write(`Tasks: ${String(totalTasks).padStart(3, ' ')} total, ${String(runningCount).padStart(3, ' ')} running,   0 stopped\n`);
    await ctx.stdout.write(`%Cpu(s): ${cpuCores} cores\n`);
    await ctx.stdout.write(`MiB Mem: ${String(totalMem).padStart(7, ' ')} total ${String(usedMem).padStart(7, ' ')} used ${String(freeMem).padStart(7, ' ')} free\n`);
    await ctx.stdout.write('\n');
    await ctx.stdout.write('  PID CMD            STATUS\n');

    // All processes
    for (const proc of listed) {
      const pid = String(proc.pid).padStart(5, ' ');
      const cmdName = proc.command.padEnd(15, ' ').slice(0, 15);
      await ctx.stdout.write(`${pid} ${cmdName}${proc.state}\n`);
    }

    return 0;
  };
}
