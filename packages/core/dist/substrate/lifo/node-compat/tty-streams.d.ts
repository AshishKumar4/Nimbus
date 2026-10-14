/**
 * Node.js `tty` module shim for Lifo (tty.ts is its public module).
 *
 * In the browser there is no real TTY, so ReadStream/WriteStream behave like
 * plain streams with the TTY-specific properties stubbed to sensible defaults.
 */
/**
 * The tty module, its streams the engine's own stream classes, made when a
 * program requires it (the engine's stream module is loaded then). Neither
 * stream is joined to a descriptor yet: a ReadStream gives nothing, and what
 * a WriteStream is given goes nowhere, as lifo's own streams did.
 */
export declare function createTty(): {
    ReadStream: {
        new (): {
            readonly isTTY: true;
            readonly isRaw: false;
            setRawMode(_mode: boolean): /*elided*/ any;
            pipe(destination: import("node:stream").Writable, options?: import("node:stream").PipeOptions): import("node:stream").Writable;
            readonly readable: boolean;
            push(chunk: Uint8Array | string | null, encoding?: string): boolean;
            setEncoding(encoding: string): /*elided*/ any;
            destroy(error?: Error): /*elided*/ any;
            on(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            addListener(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            once(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            prependListener(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            off(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            removeListener(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            removeAllListeners(event?: string | symbol): /*elided*/ any;
            emit(event: string | symbol, ...args: unknown[]): boolean;
            listenerCount(event: string | symbol): number;
            listeners(event: string | symbol): import("node:events").Listener[];
            eventNames(): (string | symbol)[];
            setMaxListeners(n: number): /*elided*/ any;
            getMaxListeners(): number;
        };
    };
    WriteStream: {
        new (): {
            readonly isTTY: true;
            columns: number;
            rows: number;
            clearLine(dir: number, cb?: () => void): boolean;
            clearScreenDown(cb?: () => void): boolean;
            cursorTo(x: number, y?: number | (() => void), cb?: () => void): boolean;
            moveCursor(dx: number, dy: number, cb?: () => void): boolean;
            getColorDepth(): number;
            hasColors(count?: number): boolean;
            getWindowSize(): [number, number];
            readonly writable: boolean;
            write(chunk: Uint8Array | string, callback?: (error?: Error | null) => void): boolean;
            end(callback?: () => void): /*elided*/ any;
            destroy(error?: Error): /*elided*/ any;
            on(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            addListener(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            once(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            prependListener(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            off(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            removeListener(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            removeAllListeners(event?: string | symbol): /*elided*/ any;
            emit(event: string | symbol, ...args: unknown[]): boolean;
            listenerCount(event: string | symbol): number;
            listeners(event: string | symbol): import("node:events").Listener[];
            eventNames(): (string | symbol)[];
            setMaxListeners(n: number): /*elided*/ any;
            getMaxListeners(): number;
        };
    };
    isatty: typeof isatty;
};
declare function isatty(_fd: number): boolean;
export {};
//# sourceMappingURL=tty-streams.d.ts.map