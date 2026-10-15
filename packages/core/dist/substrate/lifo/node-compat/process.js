import { EventEmitter } from 'node:events';
import { createProcessWarnings } from '../../../_shared/node-warning.js';
import { standardStream } from './standard-streams.js';
import { NODE_VERSION, NODE_VERSIONS } from '../../../constants.js';
import { nodeError } from '../../../_shared/node-error.js';
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
/**
 * A mode argument as Node's parseFileMode reads it: an octal string of
 * digits alone, or an unsigned 32-bit integer. Anything else is refused with
 * Node's error, before anything changes.
 */
function parseFileMode(given, name) {
    let value = given;
    if (typeof value === 'string') {
        if (!/^[0-7]+$/.test(value)) {
            throw nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', `The argument '${name}' must be a 32-bit unsigned integer or an octal string. Received ${JSON.stringify(value)}`);
        }
        // Then checked as a number is (validateUint32): '40000000000' is 2 ** 32, out of range.
        value = Number.parseInt(value, 8);
    }
    if (typeof value !== 'number') {
        throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "${name}" argument must be of type number. Received ${value === null ? 'null' : `type ${typeof value}`}`);
    }
    if (!Number.isInteger(value)) {
        throw nodeError(RangeError, 'ERR_OUT_OF_RANGE', `The value of "${name}" is out of range. It must be an integer. Received ${value}`);
    }
    if (value < 0 || value > 0xffff_ffff) {
        throw nodeError(RangeError, 'ERR_OUT_OF_RANGE', `The value of "${name}" is out of range. It must be >= 0 && <= 4294967295. Received ${value}`);
    }
    return value;
}
export function createProcess(opts) {
    const startTime = Date.now();
    const { identity } = opts;
    let mask = identity.umask & 0o777;
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
        // Node's: no code is process.exitCode's.
        exit: (code) => { throw new ProcessExitError(code ?? exitCodeOf(proc)); },
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
