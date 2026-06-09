/**
 * Node.js `readline` module shim for Lifo.
 *
 * Provides Interface (createInterface), clearLine, clearScreenDown,
 * cursorTo, moveCursor, and the promises API.
 */
import { EventEmitter } from './events.js';
export interface InterfaceOptions {
    input?: {
        on?: (event: string, cb: (...args: unknown[]) => void) => void;
    };
    output?: {
        write?: (data: string) => void;
    };
    prompt?: string;
    terminal?: boolean;
    historySize?: number;
    completer?: (line: string) => [string[], string];
    crlfDelay?: number;
}
export declare class Interface extends EventEmitter {
    private _prompt;
    private _output;
    private _closed;
    private _lines;
    terminal: boolean;
    constructor(opts?: InterfaceOptions);
    setPrompt(prompt: string): void;
    getPrompt(): string;
    prompt(preserveCursor?: boolean): void;
    write(data: string): void;
    question(query: string, cb: (answer: string) => void): void;
    question(query: string, options: {
        signal?: AbortSignal;
    }, cb: (answer: string) => void): void;
    close(): void;
    pause(): this;
    resume(): this;
    getCursorPos(): {
        rows: number;
        cols: number;
    };
    get closed(): boolean;
    [Symbol.asyncIterator](): AsyncIterableIterator<string>;
}
export declare function createInterface(opts: InterfaceOptions): Interface;
export declare function createInterface(input: InterfaceOptions['input'], output?: InterfaceOptions['output']): Interface;
export declare function clearLine(stream: {
    write?: (data: string) => void;
}, dir: number, cb?: () => void): boolean;
export declare function clearScreenDown(stream: {
    write?: (data: string) => void;
}, cb?: () => void): boolean;
export declare function cursorTo(stream: {
    write?: (data: string) => void;
}, x: number, y?: number | (() => void), cb?: () => void): boolean;
export declare function moveCursor(stream: {
    write?: (data: string) => void;
}, dx: number, dy: number, cb?: () => void): boolean;
export declare function emitKeypressEvents(_stream: unknown): void;
export declare const promises: {
    createInterface: (opts: InterfaceOptions) => Interface & {
        question: (query: string, options?: {
            signal?: AbortSignal;
        }) => Promise<string>;
    };
};
declare const _default: {
    Interface: typeof Interface;
    createInterface: typeof createInterface;
    clearLine: typeof clearLine;
    clearScreenDown: typeof clearScreenDown;
    cursorTo: typeof cursorTo;
    moveCursor: typeof moveCursor;
    emitKeypressEvents: typeof emitKeypressEvents;
    promises: {
        createInterface: (opts: InterfaceOptions) => Interface & {
            question: (query: string, options?: {
                signal?: AbortSignal;
            }) => Promise<string>;
        };
    };
};
export default _default;
//# sourceMappingURL=readline.d.ts.map