// The `node:buffer`, `node:events`, `node:util` and `node:string_decoder` surface core uses:
// lifo's node gives a program the engine's own builtins, and its console
// formats with the engine's util (substrate/lifo/node-compat). Bun and Node
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
