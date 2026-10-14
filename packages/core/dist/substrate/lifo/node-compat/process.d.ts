import { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';
import type { CommandOutputStream } from '../commands/types.js';
import { type WarningConstructor, type WarningOptions } from '../../../_shared/node-warning.js';
export declare class ProcessExitError extends Error {
    exitCode: number;
    constructor(code: number);
}
/**
 * A program's process: an emitter, as Node's is. Its stdout and stderr are
 * made when the program first reaches them: a Writable costs the engine's
 * stream module, which a program that only logs never loads.
 */
export declare class LifoProcess extends EventEmitter {
    #private;
    constructor(output: CommandOutputStream, errorOutput: CommandOutputStream);
    get stdout(): Writable;
    get stderr(): Writable;
}
export interface ProcessOptions {
    argv: string[];
    env: Record<string, string>;
    cwd: string;
    stdout: CommandOutputStream;
    stderr: CommandOutputStream;
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
    stdin: {
        isTTY: boolean;
        fd: number;
        on: () => void;
        once: () => void;
        resume: () => void;
        pause: () => void;
        setEncoding: () => void;
        read: () => null;
    };
    platform: string;
    arch: string;
    version: string;
    versions: {
        node: string;
        lifo: string;
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
    getuid: () => 1000;
    getgid: () => 1000;
    geteuid: () => 1000;
    getegid: () => 1000;
    umask: (mask?: number) => number;
    binding: (name: string) => {
        errname: (code: number) => string;
        UV_EOF: number;
        os?: undefined;
        fs?: undefined;
        crypto?: undefined;
    } | {
        errname?: undefined;
        UV_EOF?: undefined;
        os?: undefined;
        fs?: undefined;
        crypto?: undefined;
    } | {
        os: {};
        fs: {};
        crypto: {};
        errname?: undefined;
        UV_EOF?: undefined;
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