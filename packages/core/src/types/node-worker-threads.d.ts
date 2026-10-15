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
    constructor(url: URL, options?: { env: Record<string, string> });
    constructor(source: string, options: { eval: true });
    postMessage(value: unknown, transferList?: readonly MessagePort[]): void;
    on(event: 'error', listener: (error: Error) => void): this;
    once(event: 'exit', listener: (code: number) => void): this;
    once(event: 'message', listener: (value: unknown) => void): this;
    terminate(): Promise<number>;
    ref(): void;
    unref(): void;
  }
  export const parentPort: MessagePort | null;
  export function receiveMessageOnPort(port: MessagePort): { message: unknown } | undefined;
  export type { MessagePort };
}

declare module 'node:process' {
  import type * as NodeAsyncHooks from 'node:async_hooks';
  import type * as NodeBuffer from 'node:buffer';
  import type * as NodeConsole from 'node:console';
  import type * as NodeCrypto from 'node:crypto';
  import type * as NodeFs from 'node:fs';
  import type * as NodePath from 'node:path';
  import type * as NodeUrl from 'node:url';
  import type NodeStream from 'node:stream';
  import type { EventEmitter } from 'node:events';
  import type * as NodeStringDecoder from 'node:string_decoder';
  import type * as NodeReadline from 'node:readline';
  import type * as NodeUtil from 'node:util';
  import type * as NodeVm from 'node:vm';
  interface RealmProcess {
    on(event: 'unhandledRejection' | 'uncaughtException', listener: (reason: unknown) => void): RealmProcess;
    on(event: 'beforeExit' | 'exit', listener: (code: number) => void): RealmProcess;
    on(event: 'warning', listener: (warning: Error) => void): RealmProcess;
    removeAllListeners(event: 'warning'): RealmProcess;
    /** The realm's own warnings (a native builtin's): node.ts makes them the program's. */
    emitWarning(
      warning: string | Error,
      type?: string | { type?: string; code?: string; detail?: string; ctor?: (...args: never[]) => unknown } | ((...args: never[]) => unknown),
      code?: string | ((...args: never[]) => unknown),
      ctor?: (...args: never[]) => unknown,
    ): void;
    exit(code: number): never;
    nextTick(callback: () => void): void;
    /** The engine running this process: a process realm's guest runs under the same. */
    readonly execPath: string;
    readonly pid: number;
    readonly ppid: number;
    readonly argv: readonly string[];
    /** A negative pid: its process group. */
    kill(pid: number, signal: 'SIGKILL'): boolean;
    /** The engine's own builtin, as `require` gives it (node-compat/index.ts's module map). */
    getBuiltinModule(id: 'node:async_hooks'): typeof NodeAsyncHooks;
    getBuiltinModule(id: 'node:buffer'): typeof NodeBuffer;
    getBuiltinModule(id: 'node:console'): typeof NodeConsole;
    getBuiltinModule(id: 'node:crypto'): typeof NodeCrypto;
    getBuiltinModule(id: 'node:events'): typeof EventEmitter;
    getBuiltinModule(id: 'node:fs'): typeof NodeFs;
    getBuiltinModule(id: 'node:path'): typeof NodePath;
    getBuiltinModule(id: 'node:url'): typeof NodeUrl;
    getBuiltinModule(id: 'node:stream'): typeof NodeStream;
    getBuiltinModule(id: 'node:stream/promises' | 'node:stream/consumers' | 'node:stream/web'): object;
    getBuiltinModule(id: 'node:string_decoder'): typeof NodeStringDecoder;
    getBuiltinModule(id: 'node:readline'): typeof NodeReadline;
    getBuiltinModule(id: 'node:readline/promises'): object;
    getBuiltinModule(id: 'node:assert' | 'node:assert/strict' | 'node:diagnostics_channel' | 'node:domain' | 'node:perf_hooks' | 'node:punycode'
      | 'node:querystring' | 'node:sys' | 'node:timers' | 'node:timers/promises' | 'node:util/types' | 'node:v8'): object;
    getBuiltinModule(id: 'node:vm'): typeof NodeVm;
    getBuiltinModule(id: 'node:util'): typeof NodeUtil;
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
    /** Absent when the process could not be started. */
    readonly pid: number | undefined;
    /**
     * With stdio ['ignore', 'inherit', 'inherit', 'pipe', 'pipe', 'pipe', 'pipe']: the pipes at 3 to 6.
     * Bun gives none for a process it could not start.
     */
    readonly stdio: readonly [null, null, null, Writable | null, Writable | null, Readable | null, Writable | null];
    on(event: 'error', listener: (error: Error) => void): this;
    once(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
    kill(signal: 'SIGKILL'): boolean;
    ref(): void;
    unref(): void;
  }
  export function spawn(
    command: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      detached: boolean;
      stdio: readonly ['ignore', 'inherit', 'inherit', 'pipe', 'pipe', 'pipe', 'pipe'];
    },
  ): ChildProcess;
}

// The engine's vm, as node-compat/vm.ts serves it: what it wraps, and its options' import callback.
declare module 'node:vm' {
  /** How a dynamic import in compiled code is answered: the engine's main-context loader (constants), or a function. */
  export type ImportModuleDynamically = symbol | ((specifier: string, referrer: object, attributes: Record<string, string>) => object | Promise<object>);
  export interface ScriptOptions {
    filename?: string;
    importModuleDynamically?: ImportModuleDynamically;
  }
  export interface ContextOptions {
    importModuleDynamically?: ImportModuleDynamically;
  }
  export class Script {
    constructor(code: string, options?: string | ScriptOptions);
    runInThisContext(options?: object): object;
    runInContext(contextifiedObject: object, options?: object): object;
    runInNewContext(contextObject?: object, options?: object): object;
    createCachedData(): Uint8Array;
    readonly cachedDataRejected: boolean | undefined;
    readonly sourceMapURL: string | undefined;
  }
  export const constants: { readonly USE_MAIN_CONTEXT_DEFAULT_LOADER: symbol };
  export function createContext(contextObject?: object, options?: ContextOptions): object;
  export function runInThisContext(code: string, options?: string | ScriptOptions): object;
  export function runInContext(code: string, contextifiedObject: object, options?: string | ScriptOptions): object;
  export function runInNewContext(code: string, contextObject?: object, options?: string | ScriptOptions): object;
  export function compileFunction(code: string, params?: readonly string[], options?: ScriptOptions): Function;
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
