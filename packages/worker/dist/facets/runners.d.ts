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
 * Measured on a throwaway (2026-10-23), the platform ends a loop that never
 * yields about 3 s past its limit: 3.7 s after it began with 1,000 ms, 8.1 s
 * with this one.
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
/**
 * A runner worker's answer to one call (generateRunnerCode), read at the RPC
 * boundary: what the code did, with the code process.exit was called with;
 * or `unstarted`, from an isolate the platform started again, which has no
 * process and was not given a start, so it ran nothing.
 */
export declare const RunnerAnswerSchema: z.ZodUnion<readonly [z.ZodObject<{
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
}, z.core.$strip>, z.ZodObject<{
    unstarted: z.ZodLiteral<true>;
}, z.core.$strip>]>;
export type RunnerAnswer = z.infer<typeof RunnerAnswerSchema>;
/** Why a runner call's owner ended it: the reason its signal aborts with. */
export declare class RunnerCallEnded extends Error {
    readonly why: 'timeout' | 'killed' | 'closed';
    readonly timeoutMs?: number | undefined;
    constructor(why: 'timeout' | 'killed' | 'closed', timeoutMs?: number | undefined);
}
/** The error a call answers when its code called process.exit(`code`), which ends its runner. */
export declare function runnerExited(code: number): SessionRunnerError;
/**
 * The error a call answers when its runner was lost while it ran: by the
 * call's own CPU limit (`cpuMs`), its wall limit, a kill or a close
 * (RunnerCallEnded), the platform's memory limit, or any other failure of its
 * worker. A call whose wall limit came before its worker began it
 * (`entered` false) ran nothing, and its runner keeps its state.
 */
export declare function runnerFailure(error: Error, cpuMs: number, entered: boolean): SessionRunnerError;
//# sourceMappingURL=runners.d.ts.map