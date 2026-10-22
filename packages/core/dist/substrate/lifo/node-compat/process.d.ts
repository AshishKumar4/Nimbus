import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { type WarningConstructor, type WarningOptions } from '../../../_shared/node-warning.js';
import { type ProgramStdio } from './tty-streams.js';
/** The status a program's process ends with when it ends by itself: its process.exitCode, as Node reads it (0 unset). */
export declare function exitCodeOf(proc: object): number;
export declare class ProcessExitError extends Error {
    exitCode: number;
    constructor(code: number);
}
/**
 * A program's process: an emitter, as Node's is. Its stdin, stdout and
 * stderr are made when the program first reaches them (a stream costs the
 * engine's stream module, which a program that only logs never loads), and
 * are its tty module's streams where the descriptor is the terminal.
 */
export declare class LifoProcess extends EventEmitter {
    #private;
    constructor(stdio: ProgramStdio);
    /** Node's: `fn` takes every error nothing caught, in place of 'uncaughtException'; null clears it. */
    setUncaughtExceptionCaptureCallback(fn: ((error: unknown) => void) | null): void;
    hasUncaughtExceptionCaptureCallback(): boolean;
    /**
     * An error nothing caught, in Node's order: 'uncaughtExceptionMonitor', then
     * the capture callback or 'uncaughtException'. False when nothing took it,
     * and the program ends of it.
     */
    takeUncaught(error: unknown, origin: 'uncaughtException' | 'unhandledRejection'): boolean;
    /**
     * Node's 'exit', heard once as the process ends: with `code`, which an
     * explicit end (process.exit(), a fatal error) also makes its
     * process.exitCode, or, when its loop ran empty, its process.exitCode. Its
     * listeners may set process.exitCode, which is then its status; a
     * process.exit() among them ends it there.
     */
    exitWith(code: number, explicit: boolean): number;
    /** Node's 'beforeExit', each time its loop runs empty but on process.exit() or a fatal error: with its process.exitCode. */
    emitBeforeExit(): void;
    hearsWriteFailures(): boolean;
    get stdin(): Readable;
    get stdout(): Writable;
    get stderr(): Writable;
}
/** Who a program's process is: its pid and credential in the session. */
export interface ProcessIdentity {
    readonly pid: number;
    readonly uid: number;
    readonly gid: number;
    readonly groups: readonly number[];
    /** Its mask as it started: the invoking process's. */
    readonly umask: number;
    /**
     * umask(2): the mask the program creates with from now on. The program is
     * a child of the shell, with its own copy of the mask: the shell's is not
     * changed.
     */
    setUmask(mask: number): void;
}
export interface ProcessOptions {
    argv: string[];
    env: Record<string, string>;
    cwd: string;
    /** Its standard descriptors: the same object its module map's tty is made for. */
    stdio: ProgramStdio;
    identity: ProcessIdentity;
}
export declare function createProcess(opts: ProcessOptions): LifoProcess & {
    noDeprecation?: boolean;
    throwDeprecation?: boolean;
    traceDeprecation?: boolean;
    traceProcessWarnings?: boolean;
    argv: string[];
    argv0: string;
    env: {
        [x: string]: string;
    };
    cwd: () => string;
    chdir: (_dir: string) => never;
    exit: (code?: number) => never;
    platform: string;
    arch: string;
    version: string;
    versions: {
        node: string;
        v8: string;
        modules: string;
    };
    pid: number;
    ppid: number;
    title: string;
    execPath: string;
    hrtime: ((prev?: [number, number]) => [number, number]) & {
        bigint: () => bigint;
    };
    nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => void;
    memoryUsage: () => {
        rss: number;
        heapTotal: number;
        heapUsed: number;
        external: number;
        arrayBuffers: number;
    };
    uptime: () => number;
    release: {
        name: string;
    };
    config: {};
    emitWarning: (warning: string | Error, type?: string | WarningOptions | WarningConstructor, code?: string | WarningConstructor, ctor?: WarningConstructor) => void;
    getuid: () => number;
    getgid: () => number;
    geteuid: () => number;
    getegid: () => number;
    getgroups: () => number[];
    /** Its mask; a new one (a number or an octal string) is what it creates with from now on, and the one before is answered. */
    umask: (next?: unknown) => number;
    binding: (name: string) => {
        errname: (code: number) => string;
        UV_EOF: number;
        os?: {};
        fs?: {};
        crypto?: {};
    } | {
        errname?: undefined;
        UV_EOF?: undefined;
        os?: {};
        fs?: {};
        crypto?: {};
    } | {
        errname?: undefined;
        UV_EOF?: undefined;
        os: {};
        fs: {};
        crypto: {};
    };
    allowedNodeEnvironmentFlags: Set<string>;
    features: {
        inspector: boolean;
        debug: boolean;
        uv: boolean;
        tls_alpn: boolean;
        tls_sni: boolean;
        tls_ocsp: boolean;
        tls: boolean;
    };
};
//# sourceMappingURL=process.d.ts.map