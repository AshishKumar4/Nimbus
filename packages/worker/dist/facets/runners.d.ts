/**
 * runners.ts — what a runner call answers its caller (FacetManager.runnerRun):
 * the worker's answer as the session reads it, the error a call that lost its
 * runner gets, and the CPU limit a call runs under unless it names one.
 */
import { z } from 'zod/v4';
import { type SessionRunnerError, type SessionRunnerOptions } from '@nimbus-sh/core/runtime/session-protocol.js';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
/**
 * The CPU time a runner call may use when it names none, in ms. A call runs
 * on its session's thread, so a call that does not yield holds the session
 * for as long as it computes: this bounds how long a runaway one does,
 * against the 300 s a process facet may use (FACET_LIMITS.process).
 */
export declare const RUNNER_CPU_MS = 5000;
/** A runner's process as it is made: its working directory, environment, identity and exec id. */
export interface RunnerSpec {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly cred: VfsCred;
    readonly execId?: string;
}
/**
 * The options a caller asked a runner for, as one string: two calls asked
 * for the same runner when theirs are equal, whatever order its environment
 * was given in.
 */
export declare function runnerOptionsKey(options: SessionRunnerOptions): string;
/** A runner worker's answer to one call (generateRunnerCode), read at the RPC boundary. */
export declare const RunnerAnswerSchema: z.ZodObject<{
    boot: z.ZodString;
    value: z.ZodOptional<z.ZodString>;
    stdout: z.ZodString;
    stderr: z.ZodString;
    error: z.ZodOptional<z.ZodObject<{
        message: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        stack: z.ZodOptional<z.ZodString>;
        code: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    exited: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type RunnerAnswer = z.infer<typeof RunnerAnswerSchema>;
/** Why a runner call's owner ended it: the reason its signal aborts with. */
export declare class RunnerCallEnded extends Error {
    readonly why: 'timeout' | 'killed';
    readonly timeoutMs?: number | undefined;
    constructor(why: 'timeout' | 'killed', timeoutMs?: number | undefined);
}
/** The error a call answers when its code called process.exit(`code`), which ends its runner. */
export declare function runnerExited(code: number): SessionRunnerError;
/**
 * The error a call answers when its runner was lost while it ran: by the
 * call's own CPU limit (`cpuMs`), its wall limit or a kill (RunnerCallEnded),
 * the platform's memory limit, or any other failure of its worker. A call
 * whose wall limit came while it waited for a Dynamic Worker (`sent` false)
 * ran nothing, and its runner keeps its state.
 */
export declare function runnerFailure(error: Error, cpuMs: number, sent: boolean): SessionRunnerError;
//# sourceMappingURL=runners.d.ts.map