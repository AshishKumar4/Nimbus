/**
 * Node's process warnings (lib/internal/process/warning.js and
 * pre_execution.js setupWarningHandler, v22.22.3), for a process Nimbus
 * makes: the worker's node shims (as a preamble) and lifo's node
 * (substrate/lifo/node-compat/process.ts). process.emitWarning makes the
 * warning an Error named for its type and tells the process's 'warning'
 * listeners on the next tick; the listener Node installs writes it,
 * "(node:<pid>) [<code>] <Type>: <message>", the first time with how to
 * trace it. --disable-warning and --redirect-warnings are not read.
 */
/** A function a warning's stack starts above (process.emitWarning's `ctor`). */
export type WarningConstructor = (...args: never[]) => unknown;
/** process.emitWarning's options form. */
export interface WarningOptions {
    type?: string;
    code?: string;
    detail?: string;
    ctor?: WarningConstructor;
}
/** What Node's warnings read off the process, and how they reach its listeners. */
export interface WarningProcess {
    readonly pid: number;
    readonly argv0?: string;
    readonly release: {
        readonly name: string;
    };
    readonly env: Readonly<Record<string, string | undefined>>;
    noDeprecation?: boolean;
    throwDeprecation?: boolean;
    traceDeprecation?: boolean;
    traceProcessWarnings?: boolean;
    emitWarning(warning: string | Error, type?: string | WarningOptions | WarningConstructor, code?: string | WarningConstructor, ctor?: WarningConstructor): void;
    nextTick(callback: () => void): void;
    emit(event: 'warning', warning: Error): boolean;
}
export interface ProcessWarnings {
    /** process.emitWarning. */
    emitWarning(warning: string | Error, type?: string | WarningOptions | WarningConstructor, code?: string | WarningConstructor, ctor?: WarningConstructor): void;
    /** The 'warning' listener Node installs; `write` takes each warning's text. */
    onWarning(warning: unknown): void;
    /** Whether Node would install it: not under NODE_NO_WARNINGS=1 or NODE_OPTIONS' --no-warnings. */
    readonly installs: boolean;
    /** Drops the warnings whose tick has not run: an uncaught exception that ends the process runs no more ticks. */
    dropQueued(): void;
}
/** Node's warnings for `process` (read when a warning is made, so a process made after may be named). */
export declare function createProcessWarnings(process: () => WarningProcess, write: (text: string) => void): ProcessWarnings;
//# sourceMappingURL=node-warning.d.ts.map