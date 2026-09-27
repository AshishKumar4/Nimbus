import type { Command, CommandContext, CommandOutputStream } from '../types.js';
import type { ProcessRegistry } from '../../shell/ProcessRegistry.js';
interface KillJob {
    id: number;
    command: string;
    pid?: number;
}
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
export declare function runKill(ctx: Pick<CommandContext, 'args' | 'stdout' | 'stderr'>, processes: ProcessRegistry, jobs: readonly KillJob[], host?: HostProcessSignals): Promise<number>;
export declare function createKillCommand(processes: ProcessRegistry, host?: HostProcessSignals): Command;
export {};
//# sourceMappingURL=kill.d.ts.map