import { EventEmitter } from 'node:events';
import { createProcessWarnings } from '../../../_shared/node-warning.js';
import { ttyOf } from './tty-streams.js';
import { NODE_VERSION, NODE_VERSIONS } from '../../../constants.js';
import { invalidArgType, nodeError } from '../../../_shared/node-error.js';
import { parseFileMode } from '../../../_shared/node-arguments.js';
/** The status a program's process ends with when it ends by itself: its process.exitCode, as Node reads it (0 unset). */
export function exitCodeOf(proc) {
    const code = Reflect.get(proc, 'exitCode');
    return typeof code === 'number' && Number.isInteger(code) ? code : 0;
}
export class ProcessExitError extends Error {
    exitCode;
    constructor(code) {
        super(`process.exit(${code})`);
        this.name = 'ProcessExitError';
        this.exitCode = code;
    }
}
/**
 * A program's process: an emitter, as Node's is. Its stdin, stdout and
 * stderr are made when the program first reaches them (a stream costs the
 * engine's stream module, which a program that only logs never loads), and
 * are its tty module's streams where the descriptor is the terminal.
 */
export class LifoProcess extends EventEmitter {
    #stdio;
    #stdout;
    #stderr;
    #capture = null;
    constructor(stdio) {
        super();
        this.#stdio = stdio;
    }
    /** Node's: `fn` takes every error nothing caught, in place of 'uncaughtException'; null clears it. */
    setUncaughtExceptionCaptureCallback(fn) {
        if (fn === null) {
            this.#capture = null;
            return;
        }
        if (typeof fn !== 'function')
            throw invalidArgType('fn', ['Function', 'null'], fn);
        if (this.#capture !== null) {
            throw nodeError(Error, 'ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET', '`process.setupUncaughtExceptionCapture()` was called while a capture callback was already active');
        }
        this.#capture = fn;
    }
    hasUncaughtExceptionCaptureCallback() {
        return this.#capture !== null;
    }
    /**
     * An error nothing caught, in Node's order: 'uncaughtExceptionMonitor', then
     * the capture callback or 'uncaughtException'. False when nothing took it,
     * and the program ends of it.
     */
    takeUncaught(error, origin) {
        this.emit('uncaughtExceptionMonitor', error, origin);
        if (this.#capture !== null) {
            this.#capture(error);
            return true;
        }
        return this.emit('uncaughtException', error, origin);
    }
    /**
     * Whether a failed write would reach anything of the program's: an 'error'
     * listener on its stdout or stderr (on, once and the prepends share one
     * list), or one for an error nothing caught (takeUncaught's, the monitor's
     * included).
     */
    #exited = false;
    /**
     * Node's 'exit', heard once as the process ends: with `code`, which an
     * explicit end (process.exit(), a fatal error) also makes its
     * process.exitCode, or, when its loop ran empty, its process.exitCode. Its
     * listeners may set process.exitCode, which is then its status; a
     * process.exit() among them ends it there.
     */
    exitWith(code, explicit) {
        if (this.#exited)
            return code;
        this.#exited = true;
        if (explicit)
            Reflect.set(this, 'exitCode', code);
        try {
            this.emit('exit', code);
        }
        catch (error) {
            if (error instanceof ProcessExitError)
                return error.exitCode;
            throw error;
        }
        return exitCodeOf(this);
    }
    /** Node's 'beforeExit', each time its loop runs empty but on process.exit() or a fatal error: with its process.exitCode. */
    emitBeforeExit() {
        this.emit('beforeExit', exitCodeOf(this));
    }
    hearsWriteFailures() {
        return (this.#stdout?.listenerCount('error') ?? 0) > 0 || (this.#stderr?.listenerCount('error') ?? 0) > 0
            || this.#capture !== null || this.listenerCount('uncaughtException') > 0 || this.listenerCount('uncaughtExceptionMonitor') > 0
            // Its 'exit' listeners see a status a failed write changed; its
            // 'beforeExit' listeners run only if no failed write ended it first.
            || this.listenerCount('exit') > 0 || this.listenerCount('beforeExit') > 0
            // A WriteStream it made that listens for its own writes' failures.
            || ttyOf(this.#stdio).writersHear();
    }
    get stdin() {
        return ttyOf(this.#stdio).stdin();
    }
    get stdout() {
        return this.#stdout ??= ttyOf(this.#stdio).stdout();
    }
    get stderr() {
        return this.#stderr ??= ttyOf(this.#stdio).stderr();
    }
}
export function createProcess(opts) {
    const startTime = Date.now();
    const { identity } = opts;
    let mask = identity.umask & 0o777;
    // Unset until the program sets them, as in a Node run without their options.
    const unflagged = {};
    // Node's warnings, written on the program's stderr.
    const warnings = createProcessWarnings(() => proc, (text) => { opts.stdio.stderr.write(`${text}\n`); });
    const proc = Object.assign(new LifoProcess(opts.stdio), {
        argv: ['/usr/bin/node', ...opts.argv],
        argv0: 'node',
        env: { ...opts.env },
        cwd: () => opts.cwd,
        chdir: (_dir) => { throw new Error('process.chdir() is not supported in Lifo'); },
        // Node's: no code is process.exitCode's.
        exit: (code) => { throw new ProcessExitError(code ?? exitCodeOf(proc)); },
        platform: 'linux',
        arch: 'x64',
        // One release, core's (constants.ts), as `node --version` reports it.
        version: NODE_VERSION,
        versions: { ...NODE_VERSIONS },
        pid: identity.pid,
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
        // The process's credential: root's under sudo.
        getuid: () => identity.uid,
        getgid: () => identity.gid,
        geteuid: () => identity.uid,
        getegid: () => identity.gid,
        getgroups: () => [...identity.groups],
        /** Its mask; a new one (a number or an octal string) is what it creates with from now on, and the one before is answered. */
        umask: (next) => {
            const previous = mask;
            if (next === undefined)
                return previous;
            // umask(2) keeps the permission bits of what it is given.
            mask = parseFileMode(next, 'mask') & 0o777;
            identity.setUmask(mask);
            return previous;
        },
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
