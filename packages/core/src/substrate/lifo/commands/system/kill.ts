import type { Command } from '../types.js';
import type { ProcessRegistry } from '../../shell/ProcessRegistry.js';
import { formatSignalList, parseSignalName } from '../../shell/signals.js';

export function createKillCommand(processRegistry: ProcessRegistry): Command {
  return async (ctx) => {
    const args = ctx.args;

    if (args.length === 0) {
      ctx.stderr.write('kill: usage: kill [-signal] pid|%job ...\n');
      return 1;
    }

    // Handle -l (list signals)
    if (args[0] === '-l' || args[0] === '--list') {
      ctx.stdout.write(formatSignalList());
      return 0;
    }

    // Parse optional signal
    let startIdx = 0;
    let signalName: string | undefined;

    if (args[0].startsWith('-') && !args[0].startsWith('-%')) {
      const sigArg = args[0].slice(1);
      startIdx = 1;
      const parsed = parseSignalName(sigArg);
      if (!parsed) {
        ctx.stderr.write(`kill: invalid signal: ${sigArg}\n`);
        return 1;
      }
      signalName = parsed;
    }

    if (startIdx >= args.length) {
      ctx.stderr.write('kill: usage: kill [-signal] pid|%job ...\n');
      return 1;
    }

    let exitCode = 0;

    for (let i = startIdx; i < args.length; i++) {
      const target = args[i];

      let pid: number;

      if (target.startsWith('%')) {
        // Job spec: %N
        const jobId = parseInt(target.slice(1), 10);
        if (isNaN(jobId)) {
          ctx.stderr.write(`kill: ${target}: no such job\n`);
          exitCode = 1;
          continue;
        }

        // Look up process by job ID
        const proc = processRegistry.getByJobId(jobId);
        if (!proc) {
          ctx.stderr.write(`kill: ${target}: no such job\n`);
          exitCode = 1;
          continue;
        }
        pid = proc.pid;
      } else {
        // Direct PID
        pid = parseInt(target, 10);
        if (isNaN(pid)) {
          ctx.stderr.write(`kill: ${target}: invalid argument\n`);
          exitCode = 1;
          continue;
        }
      }

      // Kill the process
      const killed = processRegistry.kill(pid, signalName);
      if (!killed) {
        const proc = processRegistry.get(pid);
        if (proc && proc.command === 'shell') {
          ctx.stderr.write(`kill: (${pid}) - Operation not permitted (cannot kill shell)\n`);
        } else {
          ctx.stderr.write(`kill: (${pid}) - No such process\n`);
        }
        exitCode = 1;
      }
    }

    return exitCode;
  };
}
