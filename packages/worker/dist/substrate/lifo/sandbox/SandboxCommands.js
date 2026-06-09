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
        // Handle timeout + abort signal
        let abortController;
        let timeoutId;
        if (options?.timeout || options?.signal) {
            abortController = new AbortController();
            if (options.signal) {
                // Forward external signal
                if (options.signal.aborted) {
                    return { stdout: '', stderr: '', exitCode: 130 };
                }
                options.signal.addEventListener('abort', () => abortController.abort(), { once: true });
            }
            if (options.timeout) {
                timeoutId = setTimeout(() => abortController.abort(), options.timeout);
            }
        }
        try {
            const result = await this.shell.execute(cmd, {
                cwd: options?.cwd,
                env: options?.env,
                onStdout: options?.onStdout,
                onStderr: options?.onStderr,
                stdin: options?.stdin,
            });
            return result;
        }
        finally {
            if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
            }
        }
    }
}
