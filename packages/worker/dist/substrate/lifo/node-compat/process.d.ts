import type { CommandOutputStream } from '../commands/types.js';
export declare class ProcessExitError extends Error {
    exitCode: number;
    constructor(code: number);
}
export interface ProcessOptions {
    argv: string[];
    env: Record<string, string>;
    cwd: string;
    stdout: CommandOutputStream;
    stderr: CommandOutputStream;
}
export declare function createProcess(opts: ProcessOptions): {
    argv: string[];
    argv0: string;
    env: {
        [x: string]: string;
    };
    cwd: () => string;
    chdir: (_dir: string) => never;
    exit: (code?: number) => never;
    stdout: {
        write: (data: string) => boolean;
        isTTY: boolean;
        fd: number;
        bytesWritten: number;
        columns: number;
        on: () => void;
        once: () => void;
    };
    stderr: {
        write: (data: string) => boolean;
        isTTY: boolean;
        fd: number;
        bytesWritten: number;
        columns: number;
        on: () => void;
        once: () => void;
    };
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
    emitWarning: (msg: string) => void;
    getuid: () => number;
    getgid: () => number;
    geteuid: () => number;
    getegid: () => number;
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
    on: (event: string, fn: (...args: unknown[]) => void) => /*elided*/ any;
    addListener: (event: string, fn: (...args: unknown[]) => void) => /*elided*/ any;
    once: (event: string, fn: (...args: unknown[]) => void) => /*elided*/ any;
    off: (event: string, fn: (...args: unknown[]) => void) => /*elided*/ any;
    removeListener: (event: string, fn: (...args: unknown[]) => void) => /*elided*/ any;
    removeAllListeners: (event?: string) => /*elided*/ any;
    listeners: (event: string) => ((...args: unknown[]) => void)[];
    emit: (event: string, ...args: unknown[]) => boolean;
    listenerCount: (event: string) => number;
    setMaxListeners: () => /*elided*/ any;
    getMaxListeners: () => number;
    prependListener: (event: string, fn: (...args: unknown[]) => void) => /*elided*/ any;
    rawListeners: (event: string) => ((...args: unknown[]) => void)[];
    eventNames: () => string[];
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