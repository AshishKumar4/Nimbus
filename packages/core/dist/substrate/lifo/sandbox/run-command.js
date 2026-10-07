import { textSink } from '../../../_shared/bytes.js';
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
    const result = await shell.execute(cmd, {
        cwd: options?.cwd,
        env: options?.env,
        onStdout: onStdout && tee(onStdout, (text) => { stdout += text; }),
        onStderr: onStderr && tee(onStderr, (text) => { stderr += text; }),
        stdin: options?.stdin,
        signal,
    });
    return {
        exitCode: result.exitCode,
        stdout: onStdout ? stdout : result.stdout,
        stderr: onStderr ? stderr : result.stderr,
    };
}
function tee(sink, capture) {
    const decode = textSink(capture);
    return (data) => {
        decode(data);
        sink(data);
    };
}
