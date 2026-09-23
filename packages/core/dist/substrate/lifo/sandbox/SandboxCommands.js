import { textSink } from '../../../_shared/bytes.js';
/**
 * Wraps Shell.execute() and serializes concurrent calls.
 * Concurrent commands.run() calls are queued (matches real shell behavior).
 */
export class SandboxCommandsImpl {
    shell;
    registry;
    queue = Promise.resolve();
    constructor(shell, registry) {
        this.shell = shell;
        this.registry = registry;
    }
    run(cmd, options) {
        // Serialize execution: queue each call so they run one at a time
        const result = new Promise((resolve, reject) => {
            this.queue = this.queue.then(async () => {
                try {
                    const res = await this.executeWithOptions(cmd, options);
                    resolve(res);
                }
                catch (e) {
                    reject(e);
                }
            });
        });
        return result;
    }
    register(name, handler) {
        this.registry.register(name, handler);
    }
    async executeWithOptions(cmd, options) {
        const signal = options?.signal;
        if (signal?.aborted)
            return { stdout: '', stderr: '', exitCode: 130 };
        const controller = options?.timeout ? new AbortController() : undefined;
        const forwardAbort = () => controller?.abort(signal?.reason);
        if (controller && signal)
            signal.addEventListener('abort', forwardAbort, { once: true });
        const timeoutId = controller ? setTimeout(() => controller.abort(), options?.timeout) : undefined;
        // The result carries the output even when the caller also streams it;
        // the shell captures only a stream nobody sinks, so a sunk one is teed.
        let stdout = '';
        let stderr = '';
        const onStdout = options?.onStdout;
        const onStderr = options?.onStderr;
        try {
            const result = await this.shell.execute(cmd, {
                cwd: options?.cwd,
                env: options?.env,
                onStdout: onStdout && tee(onStdout, (text) => { stdout += text; }),
                onStderr: onStderr && tee(onStderr, (text) => { stderr += text; }),
                stdin: options?.stdin,
                signal: controller?.signal ?? signal,
            });
            return {
                exitCode: result.exitCode,
                stdout: onStdout ? stdout : result.stdout,
                stderr: onStderr ? stderr : result.stderr,
            };
        }
        finally {
            if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
            }
            signal?.removeEventListener('abort', forwardAbort);
        }
    }
}
function tee(sink, capture) {
    const decode = textSink(capture);
    return (data) => {
        decode(data);
        sink(data);
    };
}
