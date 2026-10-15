import { SinkWriter } from '../../../_shared/byte-stream.js';
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
        // The decoders end with the run: a character its last bytes left unfinished is in the result.
        await stdoutTee?.end();
        await stderrTee?.end();
    }
    return {
        exitCode: result.exitCode,
        stdout: onStdout ? stdout : result.stdout,
        stderr: onStderr ? stderr : result.stderr,
    };
}
/** `sink`'s bytes, and their text to `capture` through one decoder, which `end` ends. */
function tee(sink, capture) {
    const decoder = new SinkWriter({ write: capture });
    let decoded = Promise.resolve();
    return {
        write: (data) => {
            // Decoded as the bytes arrive (a SinkWriter decodes before it awaits), so a sink that reuses its buffer loses nothing.
            const written = decoder.write(data);
            decoded = decoded.then(() => written);
            sink(data);
        },
        end: () => decoded.then(() => decoder.end()),
    };
}
