// The `node:buffer`, `node:util` and `node:string_decoder` surface core uses:
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
