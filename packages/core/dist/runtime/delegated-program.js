import { exitCodeForSignal, signalAbortReasonOf } from '../substrate/lifo/shell/signals.js';
import { isBrokenPipe } from '../substrate/lifo/utils/bytes-io.js';
import { STREAM_CHUNK_BYTES } from '../_shared/byte-stream.js';
import { LOCAL_PLACEMENT } from './program-start.js';
/**
 * A start that did not run: the delegate refused it (execve's failure, by
 * its errno name: `ENOENT`, `EHOSTDOWN`), or the caller's stop came while it
 * was pending (`ECANCELED`, whichever way the delegate settled it).
 */
export class ProgramRefusal extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'ProgramRefusal';
    }
}
/**
 * `argv` started by `delegate` from `cwd` (its mount's terms) with `env`,
 * and run to its end: its exit as waitpid reports it.
 * - A start the delegate refuses throws ProgramRefusal; nothing ran.
 * - `cancel` is the caller's stop: before the start, the delegate's own
 *   cancellation, and ProgramRefusal ECANCELED however the delegate settles
 *   it; after it, the signal its reason names (`SIGINT` for Ctrl-C), sent
 *   to the program, which ends as it decides.
 * - A write its reader refuses (a closed pipe) is SIGPIPE to the program,
 *   as a write to a pipe with no reader is, and its output is not read on.
 *   Any other failed write ends the program (SIGKILL) before it is thrown:
 *   nothing runs on that its caller has given up.
 * - `onStarted` hears of the start, for a caller with its own signals to send.
 */
export async function runDelegatedProgram(delegate, program, streams, cancel, onStarted) {
    // Its input is read only as it reads, and not at all once it has ended:
    // a terminal's next keys are the shell's.
    const done = new AbortController();
    let started;
    try {
        started = await delegate.start({ ...program, stdin: streams.stdin === null ? null : inputOf(streams.stdin, done.signal) }, cancel);
    }
    catch (error) {
        done.abort();
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'EIO';
        throw new ProgramRefusal(code, error instanceof Error ? error.message : String(error));
    }
    if (cancel.aborted) {
        // Stopped while pending, and started anyway: the contract's other settlement, the program sent SIGKILL.
        done.abort();
        started.kill('SIGKILL');
        await started.output.cancel();
        await started.exit;
        throw new ProgramRefusal('ECANCELED', 'operation canceled');
    }
    onStarted?.(started);
    const send = () => started.kill(`SIG${signalAbortReasonOf(cancel)?.signal ?? 'TERM'}`);
    cancel.addEventListener('abort', send, { once: true });
    const output = started.output.getReader();
    try {
        for (;;) {
            const next = await output.read();
            if (next.done)
                break;
            try {
                await (next.value.stream === 'stderr' ? streams.stderr : streams.stdout)(next.value.data);
            }
            catch (error) {
                const pipe = isBrokenPipe(error);
                started.kill(pipe ? 'SIGPIPE' : 'SIGKILL');
                await output.cancel();
                if (!pipe) {
                    await started.exit;
                    throw error;
                }
                break;
            }
        }
        return await started.exit;
    }
    finally {
        cancel.removeEventListener('abort', send);
        done.abort();
    }
}
/**
 * Where a program `name` started from `cwd` by a process of `cred` would be
 * found, when the cwd's mount runs programs on its own machine: its path
 * there, or null (none there, or the mount absent). Undefined: it would
 * start here (CommandContext.locateProgram, hash).
 */
export async function locatePlacedProgram(filesystem, cred, name, cwd, env) {
    const placement = await (filesystem.placeProgram?.(cred, cwd) ?? LOCAL_PLACEMENT);
    if (placement.kind === 'local')
        return undefined;
    if (placement.kind === 'absent')
        return null;
    return await placement.delegate.locate(name, placement.cwd, env);
}
/** `stdin` as a byte stream the program pulls: nothing is read ahead of it, and nothing once `stop` aborts. */
function inputOf(stdin, stop) {
    const encoder = new TextEncoder();
    return new ReadableStream({
        async pull(controller) {
            if (stop.aborted)
                return controller.close();
            const chunk = stdin.readBytes ? await stdin.readBytes(STREAM_CHUNK_BYTES, stop) : await stdin.read();
            if (chunk === null)
                return controller.close();
            controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
        },
    }, { highWaterMark: 0 });
}
/** A program's end as the shell reports it: its exit code, or 128+n for the signal that ended it. */
export function shellStatusOf(exit) {
    return exit.signal === null ? exit.code : exitCodeForSignal(exit.signal.replace(/^SIG/, ''));
}
