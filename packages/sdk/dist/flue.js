/**
 * @nimbus-sh/sdk/flue - Flue sandbox connector for Nimbus sandboxes.
 *
 * Flue owns the agent harness. Nimbus owns the sandbox. This adapter maps a
 * `NimbusSandbox` handle to Flue's `SandboxFactory`/`SandboxApi` contract
 * without making `@flue/runtime` a hard dependency of the core SDK.
 */
export function nimbusFlue(sandbox, options = {}) {
    return {
        async createSessionEnv({ cwd }) {
            const runtime = options.runtime ?? await loadFlueRuntime();
            return runtime.createSandboxSessionEnv(new NimbusFlueApi(sandbox), cwd ?? options.cwd ?? '/home/user');
        },
    };
}
export class NimbusFlueApi {
    sandbox;
    constructor(sandbox) {
        this.sandbox = sandbox;
    }
    async readFile(path) {
        const content = await this.sandbox.files.read(path);
        if (content == null)
            throw enoent(path);
        return content;
    }
    async readFileBuffer(path) {
        const content = await this.sandbox.files.readBytes(path);
        if (content == null)
            throw enoent(path);
        return content;
    }
    async writeFile(path, content) {
        await this.sandbox.files.write(path, content);
    }
    async stat(path) {
        const stat = await this.sandbox.files.stat(path);
        if (!stat)
            throw enoent(path);
        return toFlueStat(stat);
    }
    async readdir(path) {
        const entries = await this.sandbox.files.list(path);
        return entries.map((entry) => entry.name);
    }
    async exists(path) {
        return this.sandbox.files.exists(path);
    }
    async mkdir(path, _options = {}) {
        await this.sandbox.files.mkdir(path);
    }
    async rm(path, options = {}) {
        if (options.force && !(await this.sandbox.files.exists(path)))
            return;
        await this.sandbox.files.delete(path, { recursive: options.recursive });
    }
    async exec(command, options = {}) {
        const result = await this.sandbox.exec(command, {
            cwd: options.cwd,
            env: options.env,
            timeoutMs: secondsToMilliseconds(options.timeout),
        });
        if (options.signal?.aborted)
            throw abortError(options.signal);
        return toShellResult(result);
    }
}
async function loadFlueRuntime() {
    try {
        const specifier = '@flue/runtime';
        const runtime = await import(specifier);
        if (typeof runtime.createSandboxSessionEnv === 'function') {
            return runtime;
        }
    }
    catch {
        // Error below gives callers the exact integration action.
    }
    throw new Error('nimbusFlue requires @flue/runtime. Install Flue or pass { runtime: { createSandboxSessionEnv } }.');
}
function toFlueStat(stat) {
    const type = String(stat.type);
    return {
        isFile: type === 'file',
        isDirectory: type === 'directory',
        isSymbolicLink: false,
        size: Number(stat.size) || 0,
        mtime: new Date(Number(stat.mtime) || Date.now()),
    };
}
function toShellResult(result) {
    return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
    };
}
function secondsToMilliseconds(timeout) {
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)
        return undefined;
    return Math.max(1, Math.round(timeout * 1000));
}
function enoent(path) {
    const error = new Error(`ENOENT: no such file or directory, '${path}'`);
    error.code = 'ENOENT';
    return error;
}
function abortError(signal) {
    return signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The operation was aborted', 'AbortError');
}
