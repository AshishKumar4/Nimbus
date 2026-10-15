import { EventEmitter } from 'node:events';
import { createProcessWarnings } from '../../../_shared/node-warning.js';
import { standardStream } from './standard-streams.js';
export class ProcessExitError extends Error {
    exitCode;
    constructor(code) {
        super(`process.exit(${code})`);
        this.name = 'ProcessExitError';
        this.exitCode = code;
    }
}
/**
 * A program's process: an emitter, as Node's is. Its stdout and stderr are
 * made when the program first reaches them: a Writable costs the engine's
 * stream module, which a program that only logs never loads.
 */
export class LifoProcess extends EventEmitter {
    #output;
    #errorOutput;
    #stdout;
    #stderr;
    constructor(output, errorOutput) {
        super();
        this.#output = output;
        this.#errorOutput = errorOutput;
    }
    get stdout() {
        return this.#stdout ??= standardStream(this.#output, 1);
    }
    get stderr() {
        return this.#stderr ??= standardStream(this.#errorOutput, 2);
    }
}
export function createProcess(opts) {
    const startTime = Date.now();
    // Unset until the program sets them, as in a Node run without their options.
    const unflagged = {};
    // Node's warnings, written on the program's stderr.
    const warnings = createProcessWarnings(() => proc, (text) => { opts.stderr.write(`${text}\n`); });
    const proc = Object.assign(new LifoProcess(opts.stdout, opts.stderr), {
        argv: ['/usr/bin/node', ...opts.argv],
        argv0: 'node',
        env: { ...opts.env },
        cwd: () => opts.cwd,
        chdir: (_dir) => { throw new Error('process.chdir() is not supported in Lifo'); },
        exit: (code = 0) => {
            throw new ProcessExitError(code);
        },
        stdin: {
            isTTY: false,
            fd: 0,
            on: () => { },
            once: () => { },
            resume: () => { },
            pause: () => { },
            setEncoding: () => { },
            read: () => null,
        },
        platform: 'linux',
        arch: 'x64',
        version: 'v22.14.0',
        versions: {
            node: '22.14.0',
            lifo: '0.1.0',
        },
        pid: 1,
        ppid: 0,
        title: 'node',
        execPath: '/usr/bin/node',
        hrtime: Object.assign((prev) => {
            const now = performance.now();
            const sec = Math.floor(now / 1000);
            const nano = Math.floor((now % 1000) * 1e6);
            if (prev) {
                let ds = sec - prev[0];
                let dn = nano - prev[1];
                if (dn < 0) {
                    ds--;
                    dn += 1e9;
                }
                return [ds, dn];
            }
            return [sec, nano];
        }, {
            bigint: () => BigInt(Math.floor(performance.now() * 1e6)),
        }),
        nextTick: (fn, ...args) => {
            queueMicrotask(() => fn(...args));
        },
        memoryUsage: () => {
            const m = performance.memory;
            return {
                rss: m?.usedJSHeapSize ?? 0,
                heapTotal: m?.totalJSHeapSize ?? 0,
                heapUsed: m?.usedJSHeapSize ?? 0,
                external: 0,
                arrayBuffers: 0,
            };
        },
        uptime: () => (Date.now() - startTime) / 1000,
        release: { name: 'node' },
        config: {},
        emitWarning: (warning, type, code, ctor) => {
            warnings.emitWarning(warning, type, code, ctor);
        },
        // POSIX identity stubs (needed by many npm packages)
        getuid: () => 1000,
        getgid: () => 1000,
        geteuid: () => 1000,
        getegid: () => 1000,
        umask: (mask) => mask ?? 0o22,
        // process.binding() stub — low-level Node.js internal, used by execa/errname etc.
        binding: (name) => {
            if (name === 'uv') {
                return {
                    errname: (code) => `UV_UNKNOWN_${code}`,
                    UV_EOF: -4095,
                };
            }
            if (name === 'natives')
                return {};
            if (name === 'constants')
                return { os: {}, fs: {}, crypto: {} };
            return {};
        },
        // Feature detection flags
        allowedNodeEnvironmentFlags: new Set(),
        features: { inspector: false, debug: false, uv: false, tls_alpn: false, tls_sni: false, tls_ocsp: false, tls: false },
        ...unflagged,
    });
    // Node's own 'warning' listener, unless warnings are off.
    if (warnings.installs)
        proc.on('warning', warnings.onWarning);
    return proc;
}
