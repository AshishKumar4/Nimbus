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
        emitWarning: (msg) => { opts.stderr.write(`Warning: ${msg}\n`); },
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
            if (event)
                delete listeners[event];
            else
                Object.keys(listeners).forEach((k) => delete listeners[k]);
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
    };
    return proc;
}
