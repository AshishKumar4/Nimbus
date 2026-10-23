/**
 * runners.ts — what a runner call answers its caller (FacetManager.runnerRun):
 * the worker's answer as the session reads it, the error a call that lost its
 * runner gets, and the CPU limit a call runs under unless it names one.
 */
import { z } from 'zod/v4';
import { classifyError } from '@nimbus-sh/platform/oom-classify.js';
import { errorText } from '@nimbus-sh/core/_shared/error-text.js';
import { SessionRunnerErrorSchema } from '@nimbus-sh/core/runtime/session-protocol.js';
/**
 * The CPU time a runner call may use when it names none, in ms. A call runs
 * on its session's thread, so a call that does not yield holds the session
 * for as long as it computes: this bounds how long a runaway one does,
 * against the 300 s a process facet may use (FACET_LIMITS.process).
 */
export const RUNNER_CPU_MS = 5_000;
/**
 * The options a caller asked a runner for, as one string: two calls asked
 * for the same runner when theirs are equal, whatever order its environment
 * was given in.
 */
export function runnerOptionsKey(options) {
    const env = options.env === undefined ? null : Object.entries(options.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return JSON.stringify([options.cwd ?? null, env, options.cred ?? null, options.execId ?? null]);
}
/** A runner worker's answer to one call (generateRunnerCode), read at the RPC boundary. */
export const RunnerAnswerSchema = z.object({
    /** The isolate's boot id: another than the last call's means an isolate no earlier call ran in. */
    boot: z.string(),
    value: z.string().optional(),
    stdout: z.string(),
    stderr: z.string(),
    error: SessionRunnerErrorSchema.optional(),
    /** The code called process.exit with this code. */
    exited: z.number().optional(),
});
/** Why a runner call's owner ended it: the reason its signal aborts with. */
export class RunnerCallEnded extends Error {
    why;
    timeoutMs;
    constructor(why, timeoutMs) {
        super(why === 'timeout' ? `the call took longer than ${timeoutMs} ms` : "the runner's process was killed during the call");
        this.why = why;
        this.timeoutMs = timeoutMs;
    }
}
const RUNNER_ERROR = 'NimbusRunnerError';
const NEXT_IS_FRESH = 'the next call runs in a fresh runner';
/** The error a call answers when its code called process.exit(`code`), which ends its runner. */
export function runnerExited(code) {
    return { name: RUNNER_ERROR, code: 'ERR_NIMBUS_RUNNER_EXITED', message: `the code called process.exit(${code}), which ends its runner; ${NEXT_IS_FRESH}` };
}
/**
 * The error a call answers when its runner was lost while it ran: by the
 * call's own CPU limit (`cpuMs`), its wall limit or a kill (RunnerCallEnded),
 * the platform's memory limit, or any other failure of its worker. A call
 * whose wall limit came while it waited for a Dynamic Worker (`sent` false)
 * ran nothing, and its runner keeps its state.
 */
export function runnerFailure(error, cpuMs, sent) {
    if (error instanceof RunnerCallEnded && error.why === 'timeout' && !sent) {
        return { name: RUNNER_ERROR, code: 'ERR_NIMBUS_RUNNER_TIMEOUT', message: `${error.message} waiting for a Dynamic Worker, so its code did not run; its runner keeps its state` };
    }
    if (error instanceof RunnerCallEnded) {
        return { name: RUNNER_ERROR, code: error.why === 'timeout' ? 'ERR_NIMBUS_RUNNER_TIMEOUT' : 'ERR_NIMBUS_RUNNER_KILLED', message: `${error.message}, so its runner was ended; ${NEXT_IS_FRESH}` };
    }
    switch (classifyError(error)) {
        case 'cpu_exceeded':
            return { name: RUNNER_ERROR, code: 'ERR_NIMBUS_RUNNER_CPU_LIMIT', message: `the call used more than its ${cpuMs} ms of CPU, so the platform ended its runner; ${NEXT_IS_FRESH}` };
        case 'oom':
            return { name: RUNNER_ERROR, code: 'ERR_NIMBUS_RUNNER_MEMORY_LIMIT', message: `the call used more memory than a runner may hold, so the platform ended its runner; ${NEXT_IS_FRESH}` };
        default:
            return { name: RUNNER_ERROR, code: 'ERR_NIMBUS_RUNNER_LOST', message: `the runner's worker failed (${errorText(error)}); ${NEXT_IS_FRESH}` };
    }
}
