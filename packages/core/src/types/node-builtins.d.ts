// The `node:buffer`, `node:events`, `node:stream`, `node:util` and `node:string_decoder` surface core uses
// (and node:fs's stream classes):
// lifo's node gives a program the engine's own builtins, and its console
// formats with the engine's util (substrate/lifo/node-compat); lifo's
// commands know whose code is running by `node:async_hooks`. Bun and Node
// provide them; workerd under nodejs_compat.
declare module 'node:buffer' {
  export class Buffer extends Uint8Array {
    static from(value: string | ArrayBuffer | ArrayLike<number> | Iterable<number>, encodingOrMapFn?: string | ((v: number, k: number) => number)): Buffer;
    static alloc(size: number): Buffer;
    static concat(list: readonly Uint8Array[], totalLength?: number): Buffer;
    static isEncoding(encoding: string): boolean;
    /** An encoding the engine does not know throws, as in Node. */
    toString(encoding?: string, start?: number, end?: number): string;
  }
}

declare module 'node:events' {
  type Listener = (...args: unknown[]) => void;
  export class EventEmitter {
    constructor(options?: { captureRejections?: boolean });
    on(event: string | symbol, listener: Listener): this;
    addListener(event: string | symbol, listener: Listener): this;
    once(event: string | symbol, listener: Listener): this;
    prependListener(event: string | symbol, listener: Listener): this;
    off(event: string | symbol, listener: Listener): this;
    removeListener(event: string | symbol, listener: Listener): this;
    removeAllListeners(event?: string | symbol): this;
    emit(event: string | symbol, ...args: unknown[]): boolean;
    listenerCount(event: string | symbol): number;
    listeners(event: string | symbol): Listener[];
    eventNames(): (string | symbol)[];
    setMaxListeners(n: number): this;
    getMaxListeners(): number;
  }
}

declare module 'node:stream' {
  import { EventEmitter } from 'node:events';
  type Callback = (error?: Error | null) => void;
  export interface ReadableOptions {
    highWaterMark?: number;
    encoding?: string;
    read?(this: Readable, size: number): void;
  }
  export interface WritableOptions {
    highWaterMark?: number;
    decodeStrings?: boolean;
    write?(this: Writable, chunk: Uint8Array | string, encoding: string, callback: Callback): void;
  }
  export class Stream extends EventEmitter {}
  export interface PipeOptions {
    end?: boolean;
  }
  export class Readable extends Stream {
    constructor(options?: ReadableOptions);
    /** Pipes into `destination`, and answers it. */
    pipe(destination: Writable, options?: PipeOptions): Writable;
    readonly readable: boolean;
    push(chunk: Uint8Array | string | null, encoding?: string): boolean;
    setEncoding(encoding: string): this;
    destroy(error?: Error): this;
  }
  export class Writable extends Stream {
    constructor(options?: WritableOptions);
    readonly writable: boolean;
    write(chunk: Uint8Array | string, callback?: Callback): boolean;
    end(callback?: () => void): this;
    destroy(error?: Error): this;
  }
  export class Duplex extends Readable {}
  export class PassThrough extends Duplex {}
  const stream: typeof Stream & { Readable: typeof Readable; Writable: typeof Writable; Duplex: typeof Duplex; PassThrough: typeof PassThrough };
  export default stream;
}

declare module 'node:fs' {
  import type { Readable, Writable } from 'node:stream';
  /** A read stream over the `fs` it is given (open, read, close), as Node's createReadStream takes one. */
  export class ReadStream extends Readable {
    constructor(path: string | undefined, options?: object);
  }
  /** A write stream over the `fs` it is given (open, write, close). */
  export class WriteStream extends Writable {
    constructor(path: string | undefined, options?: object);
  }
}

declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}

declare module 'node:util' {
  export interface InspectOptions {
    depth?: number | null;
    customInspect?: boolean;
    showHidden?: boolean;
    colors?: boolean;
  }
  export function format(...args: unknown[]): string;
  export function inspect(value: unknown, options?: InspectOptions): string;
  const util: { format: typeof format; inspect: typeof inspect };
  export default util;
}

declare module 'node:string_decoder' {
  export class StringDecoder {
    constructor(encoding?: string);
    write(buffer: string | ArrayBufferView): string;
    end(buffer?: string | ArrayBufferView): string;
  }
  const stringDecoder: { StringDecoder: typeof StringDecoder };
  export default stringDecoder;
}
