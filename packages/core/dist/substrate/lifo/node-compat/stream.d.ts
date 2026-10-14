import { EventEmitter } from 'node:events';
/** Node's legacy Stream: an emitter, the base of every stream, and what require('stream') is. */
export declare class Stream extends EventEmitter {
    static Stream: typeof Stream;
    static Readable: typeof Readable;
    static Writable: typeof Writable;
    static Duplex: typeof Duplex;
    static PassThrough: typeof PassThrough;
}
export declare class Readable extends Stream {
    private _buffer;
    protected _ended: boolean;
    readable: boolean;
    push(chunk: string | null): void;
    read(): string | null;
    pipe<T extends Writable>(dest: T): T;
    destroy(): this;
    setEncoding(_encoding: string): this;
    resume(): this;
    pause(): this;
}
export declare class Writable extends Stream {
    private _ended;
    writable: boolean;
    write(chunk: string, _encoding?: string, cb?: () => void): boolean;
    end(chunk?: string): void;
    destroy(): this;
}
export declare class Duplex extends Readable {
    writable: boolean;
    private _writableEnded;
    write(chunk: string, _encoding?: string, cb?: () => void): boolean;
    end(chunk?: string): void;
}
export declare class PassThrough extends Duplex {
}
export default Stream;
//# sourceMappingURL=stream.d.ts.map