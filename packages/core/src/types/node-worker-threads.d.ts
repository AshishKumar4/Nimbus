// The `node:worker_threads` and `node:process` surface a realm uses
// (runtime/realm.ts, realm-guest.ts; the inline node's and a local facet's).
// Bun and Node provide both; workerd has no worker threads, and isolates of
// its own.
declare module 'node:worker_threads' {
  interface MessagePort {
    postMessage(value: unknown, transferList?: readonly MessagePort[]): void;
    on(event: 'message', listener: (value: unknown) => void): this;
    off(event: 'message', listener: (value: unknown) => void): this;
    close(): void;
    ref(): void;
    unref(): void;
  }
  export class MessageChannel {
    readonly port1: MessagePort;
    readonly port2: MessagePort;
  }
  export class Worker {
    constructor(url: URL);
    constructor(source: string, options: { eval: true });
    postMessage(value: unknown, transferList?: readonly MessagePort[]): void;
    on(event: 'error', listener: (error: Error) => void): this;
    once(event: 'exit', listener: (code: number) => void): this;
    terminate(): Promise<number>;
    ref(): void;
    unref(): void;
  }
  export const parentPort: MessagePort | null;
  export function receiveMessageOnPort(port: MessagePort): { message: unknown } | undefined;
  export type { MessagePort };
}

declare module 'node:process' {
  interface RealmProcess {
    on(event: 'unhandledRejection' | 'uncaughtException', listener: (reason: unknown) => void): RealmProcess;
    on(event: 'exit', listener: (code: number) => void): RealmProcess;
    exit(code: number): never;
    /** The engine running this process: a process realm's guest runs under the same. */
    readonly execPath: string;
  }
  const process: RealmProcess;
  export default process;
}

// A process realm: its guest is a child process of the same engine, its
// channels pipes (runtime/realm.ts, realm-guest.ts).
declare module 'node:child_process' {
  interface Stream {
    on(event: 'error', listener: (error: Error) => void): this;
    ref?(): void;
    unref?(): void;
    destroy(): void;
  }
  export interface Writable extends Stream {
    write(data: Uint8Array): boolean;
  }
  export interface Readable extends Stream {
    on(event: 'data', listener: (chunk: Uint8Array) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    once(event: 'close', listener: () => void): this;
  }
  export interface ChildProcess {
    /** With stdio ['ignore', 'inherit', 'inherit', 'pipe', 'pipe', 'pipe']: the three pipes at 3, 4 and 5. */
    readonly stdio: readonly [null, null, null, Writable, Writable, Readable];
    on(event: 'error', listener: (error: Error) => void): this;
    once(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
    kill(signal: 'SIGKILL'): boolean;
    ref(): void;
    unref(): void;
  }
  export function spawn(
    command: string,
    args: readonly string[],
    options: { stdio: readonly ['ignore', 'inherit', 'inherit', 'pipe', 'pipe', 'pipe'] },
  ): ChildProcess;
}

declare module 'node:v8' {
  export function serialize(value: unknown): Uint8Array;
  export function deserialize(bytes: Uint8Array): unknown;
}

declare module 'node:fs' {
  export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: null): number;
  export function writeSync(fd: number, buffer: Uint8Array, offset: number, length: number): number;
  interface FdReadStream {
    on(event: 'data', listener: (chunk: Uint8Array) => void): this;
    on(event: 'end' | 'error', listener: () => void): this;
  }
  export function createReadStream(path: '', options: { fd: number }): FdReadStream;
}

// The worker's module is found beside the module that starts it.
interface ImportMeta {
  readonly url: string;
}
