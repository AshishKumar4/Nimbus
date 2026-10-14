import type { Command, CommandContext, CommandOutputStream } from '../types.js';
import type { VfsCred } from '../../../../runtime/os-contracts.js';
import { type JobTable } from '../../shell/jobs.js';
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
     * Deliver `signal` (a parsed name; `0` delivers nothing) to a live pid of
     * this host, from `caller`, whom kill(2)'s rule may refuse
     * (`not-permitted`), for `0` too. A teardown step that failed without
     * keeping the process alive is reported on `stderr`.
     */
    signal(pid: number, signal: string, stderr: CommandOutputStream, caller: Readonly<VfsCred>): Promise<HostSignalResult>;
}
/**
 * `kill` from `caller`, by the shell's builtin with its `jobs`, or as a
 * program, which has no jobs and finds a jobspec names none (procps kill).
 */
export declare function runKill(ctx: Pick<CommandContext, 'args' | 'stdout' | 'stderr'>, caller: Readonly<VfsCred>, jobs: Pick<JobTable, 'list' | 'byPid' | 'signal'> | null, host?: HostProcessSignals): Promise<number>;
/** `kill` as a program (`xargs kill`, `sudo kill`): it reaches the processes `host` does. */
export declare function createKillCommand(host?: HostProcessSignals): Command;
//# sourceMappingURL=kill.d.ts.map