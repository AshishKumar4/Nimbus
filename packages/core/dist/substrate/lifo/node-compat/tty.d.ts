/**
 * Node.js `tty` module shim for Lifo, as lifo's public module: the streams
 * tty-streams.ts makes, which a program's module map makes when it requires
 * tty (this module loads the engine's stream module as it loads).
 */
declare const tty: {
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
    isatty: (_fd: number) => boolean;
};
export declare const ReadStream: {
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
}, WriteStream: {
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
}, isatty: (_fd: number) => boolean;
export default tty;
//# sourceMappingURL=tty.d.ts.map