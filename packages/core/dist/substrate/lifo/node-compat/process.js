import { captureStack, invalidArgType } from '../../../_shared/node-error.js';
export class ProcessExitError extends Error {
    exitCode;
    constructor(code) {
        super(`process.exit(${code})`);
        this.name = 'ProcessExitError';
        this.exitCode = code;
    }
}
export function createProcess(opts) {
    const startTime = Date.now();
    const listeners = {};
    // Unset until the program sets them, as in a Node run without their options.
    const unflagged = {};
    const proc = {
        argv: ['/usr/bin/node', ...opts.argv],
        argv0: 'node',
        env: { ...opts.env },
        cwd: () => opts.cwd,
        chdir: (_dir) => { throw new Error('process.chdir() is not supported in Lifo'); },
        exit: (code = 0) => {
            if (code !== 0) {
                opts.stderr.write(`[process.exit] code=${code}\n`);
            }
            throw new ProcessExitError(code);
        },
        stdout: {
            write: (data) => { opts.stdout.write(data); return true; },
            isTTY: false,
            fd: 1,
            bytesWritten: 0,
            columns: 80,
            on: () => { },
            once: () => { },
        },
        stderr: {
            write: (data) => { opts.stderr.write(data); return true; },
            isTTY: false,
            fd: 2,
            bytesWritten: 0,
            columns: 80,
            on: () => { },
            once: () => { },
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
            emitWarning(warning, type, code, ctor);
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
        // EventEmitter-like methods (many packages check for process.on('exit'))
        on: (event, fn) => {
            if (!listeners[event])
                listeners[event] = [];
            listeners[event].push(fn);
            return proc;
        },
        addListener: (event, fn) => {
            return proc.on(event, fn);
        },
        once: (event, fn) => {
            const wrapped = (...args) => {
                proc.removeListener(event, wrapped);
                fn(...args);
            };
            return proc.on(event, wrapped);
        },
        off: (event, fn) => {
            if (listeners[event]) {
                listeners[event] = listeners[event].filter((f) => f !== fn);
            }
            return proc;
        },
        removeListener: (event, fn) => proc.off(event, fn),
        removeAllListeners: (event) => {
            if (event) {
                delete listeners[event];
            }
            else {
                for (const k of Object.keys(listeners))
                    delete listeners[k];
            }
            return proc;
        },
        listeners: (event) => listeners[event] ? [...listeners[event]] : [],
        emit: (event, ...args) => {
            const fns = listeners[event];
            if (!fns || fns.length === 0)
                return false;
            for (const fn of [...fns])
                fn(...args);
            return true;
        },
        listenerCount: (event) => listeners[event]?.length ?? 0,
        setMaxListeners: () => proc,
        getMaxListeners: () => 10,
        prependListener: (event, fn) => {
            if (!listeners[event])
                listeners[event] = [];
            listeners[event].unshift(fn);
            return proc;
        },
        rawListeners: (event) => listeners[event] ? [...listeners[event]] : [],
        eventNames: () => Object.keys(listeners),
        // Feature detection flags
        allowedNodeEnvironmentFlags: new Set(),
        features: { inspector: false, debug: false, uv: false, tls_alpn: false, tls_sni: false, tls_ocsp: false, tls: false },
        ...unflagged,
    };
    /** Node's process.emitWarning (lib/internal/process/warning.js): the warning is told to 'warning' listeners on the next tick. */
    function emitWarning(warning, type, code, ctor) {
        if (proc.noDeprecation && type === 'DeprecationWarning')
            return;
        let name = type;
        let detail;
        if (typeof type === 'object' && type !== null && !Array.isArray(type)) {
            ctor = type.ctor;
            code = type.code;
            if (typeof type.detail === 'string')
                detail = type.detail;
            name = type.type || 'Warning';
        }
        else if (typeof type === 'function') {
            ctor = type;
            code = undefined;
            name = 'Warning';
        }
        if (name !== undefined && typeof name !== 'string')
            throw invalidArgType('type', 'string', name);
        if (typeof code === 'function') {
            ctor = code;
            code = undefined;
        }
        else if (code !== undefined && typeof code !== 'string') {
            throw invalidArgType('code', 'string', code);
        }
        let told;
        if (typeof warning === 'string') {
            told = Object.assign(new Error(warning), { name: String(name || 'Warning') }, code === undefined ? {} : { code }, detail === undefined ? {} : { detail });
            captureStack(told, ctor ?? proc.emitWarning);
        }
        else if (warning instanceof Error) {
            told = warning;
        }
        else {
            throw invalidArgType('warning', ['Error', 'string'], warning);
        }
        if (told.name === 'DeprecationWarning') {
            if (proc.noDeprecation)
                return;
            if (proc.throwDeprecation) {
                proc.nextTick(() => { throw told; });
                return;
            }
        }
        proc.nextTick(() => proc.emit('warning', told));
    }
    // Node's own 'warning' listener (onWarning), unless NODE_NO_WARNINGS=1:
    // each warning on stderr, the hint at how to trace one written once.
    let hintWritten = false;
    const writeWarning = (warning) => {
        if (!(warning instanceof Error))
            return;
        const isDeprecation = warning.name === 'DeprecationWarning';
        if (isDeprecation && proc.noDeprecation)
            return;
        const trace = proc.traceProcessWarnings || (isDeprecation && proc.traceDeprecation);
        let message = `(${proc.release.name}:${proc.pid}) `;
        if ('code' in warning && warning.code)
            message += `[${String(warning.code)}] `;
        message += trace && warning.stack ? warning.stack : String(warning);
        if ('detail' in warning && typeof warning.detail === 'string')
            message += `\n${warning.detail}`;
        if (!trace && !hintWritten) {
            const argv0 = String(proc.argv0 || 'node').replace(/^.*\//, '').replace(/\.exe$/, '');
            message += `\n(Use \`${argv0} ${isDeprecation ? '--trace-deprecation' : '--trace-warnings'} ...\` to show where the warning was created)`;
            hintWritten = true;
        }
        opts.stderr.write(`${message}\n`);
    };
    if (proc.env.NODE_NO_WARNINGS !== '1')
        proc.on('warning', writeWarning);
    return proc;
}
