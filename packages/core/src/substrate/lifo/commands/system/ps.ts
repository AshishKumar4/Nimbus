import type { Command } from '../types.js';
import type { SessionProcessSupervisor } from '../../../../runtime/session-process-supervisor.js';

/** `ps` over the session's process table, as its observers are told it; an ended process not yet reaped is `<defunct>`. */
export function createPsCommand(processes: Pick<SessionProcessSupervisor, 'publishedAll'>): Command {
  return async (ctx) => {
    await ctx.stdout.write('  PID TTY          TIME CMD\n');
    for (const proc of processes.publishedAll()) {
      const uptime = Math.floor((Date.now() - proc.startTime) / 1000);
      const time = [Math.floor(uptime / 3600), Math.floor((uptime % 3600) / 60), uptime % 60]
        .map((part) => part.toString().padStart(2, '0')).join(':');
      const defunct = proc.state === 'running' ? '' : ' <defunct>';
      await ctx.stdout.write(`${proc.pid.toString().padStart(5)} pts/0    ${time} ${proc.argv.join(' ')}${defunct}\n`);
    }
    return 0;
  };
}
