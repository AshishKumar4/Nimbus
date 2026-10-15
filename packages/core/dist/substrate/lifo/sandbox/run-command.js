import { textCapture } from '../utils/bytes-io.js';
/**
 * Run one command line on `shell` and collect its result. Whatever shell it is
 * given is the one the command acts on; it queues nothing, so two calls on two
 * shells run at once.
 */
export async function runCommand(shell, cmd, options) {
    if (options?.signal?.aborted)
        return { stdout: '', stderr: '', exitCode: 130 };
    // The caller's signal, and the timeout's when there is one: the shell's own controller follows it.
    const timeout = options?.timeout ? AbortSignal.timeout(options.timeout) : undefined;
    const signal = timeout && options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout ?? options?.signal;
    // The result carries the output even when the caller also streams it;
    // the shell captures only a stream nobody sinks, so a sunk one is teed.
    let stdout = '';
    let stderr = '';
    const onStdout = options?.onStdout;
    const onStderr = options?.onStderr;
    const stdoutTee = onStdout && tee(onStdout, (text) => { stdout += text; });
    const stderrTee = onStderr && tee(onStderr, (text) => { stderr += text; });
    let result;
    try {
        result = await shell.execute(cmd, {
            cwd: options?.cwd,
            env: options?.env,
            onStdout: stdoutTee?.write,
            onStderr: stderrTee?.write,
            stdin: options?.stdin,
            signal,
        });
    }
    finally {
        // The captures end with the run: bytes a character left unfinished are in the result.
        stdoutTee?.end();
        stderrTee?.end();
    }
    return {
        exitCode: result.exitCode,
        stdout: onStdout ? stdout : result.stdout,
        stderr: onStderr ? stderr : result.stderr,
    };
}
/** `sink`'s bytes, and their text to `capture` as the shell captures text (textCapture), which `end` ends. */
function tee(sink, capture) {
    const text = textCapture(capture);
    return {
        write: (data) => {
            text.stream.writeBytes(data);
            sink(data);
        },
        end: () => text.end(),
    };
}
