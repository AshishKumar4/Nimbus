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
  }
  const process: RealmProcess;
  export default process;
}

// The worker's module is found beside the module that starts it.
interface ImportMeta {
  readonly url: string;
}
