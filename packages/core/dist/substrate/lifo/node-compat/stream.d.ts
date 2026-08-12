import { EventEmitter } from './events.js';
export declare class Readable extends EventEmitter {
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
export declare class Writable extends EventEmitter {
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
declare const _default: {
    Readable: typeof Readable;
    Writable: typeof Writable;
    Duplex: typeof Duplex;
    PassThrough: typeof PassThrough;
};
export default _default;
//# sourceMappingURL=stream.d.ts.map