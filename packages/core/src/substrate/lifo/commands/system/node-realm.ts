/**
 * The inline `node`'s realm: each run is a worker thread of its own.
 *
 * The program used to be evaluated with `new Function` in the host's realm,
 * so its globals and intrinsics were the host's: a program that rebound
 * `Array` or installed fake timers changed them for the host (in Kinu's CLI, a
 * rebound `globalThis.Array` broke the host's sqlite-vfs). A worker thread is
 * a realm and an event loop of its own, which ends when its program does, and
 * `terminate()` ends even a loop that never yields. A `vm` context is a realm
 * too, but every host object handed into it (the fs bridge, Buffer, the
 * http module) carries the host's prototypes, a sync loop in it cannot be
 * stopped, and a blocking read could only block the host's own thread.
 *
 * The guest (node-guest.ts) runs node.ts's runNodeProgram. What it reaches
 * outside its realm crosses here:
 *
 *   - synchronous calls (the filesystem `require` and `fs` read, fd 0, the
 *     session's ports): the guest posts the call on `calls` and waits on
 *     `wake` (Atomics.wait); this side answers on `calls` and wakes it, and
 *     the guest takes the answer with receiveMessageOnPort. Only answers
 *     travel guest-bound on `calls`, so nothing else can be taken for one.
 *     A call this side answers asynchronously (fd 0, read to its end) holds
 *     the guest exactly as a blocking read holds a Node program;
 *   - asynchronous traffic, on `events`: its output, the requests its loopback
 *     clients make, the requests this side forwards to its servers, its exit.
 *
 * The program shares its realm with the guest, so everything it sends is
 * untrusted: the ports reach the guest by its first message, never through
 * `workerData` a program can import, and this side answers only the calls it
 * names below, with arguments of their kind, and never lets a message, an
 * answer that cannot cross, or a failed request end the host.
 *
 * Bun and Node both carry node:worker_threads, SharedArrayBuffer and
 * Atomics.wait in workers; workerd does not, and its sessions run their own
 * `node` (worker hosted/commands.ts).
 */

import type * as WorkerThreads from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import type { RuntimeVfsDirEntry, RuntimeVfsStat } from '../../../../runtime/os-contracts.js';
import type { CommandContext, CommandOutputStream } from '../types.js';
import type { Kernel, VirtualRequest, VirtualRequestHandler, VirtualResponse } from '../../kernel/index.js';
import type { NodeFilesystem } from '../../node-compat/filesystem.js';
import { synchronousFilesystem } from '../../node-compat/filesystem.js';
import { isVfsErrorCode, VfsError } from '../../../../vfs/vfs-error.js';
import { dispatchWorkspaceRequest } from '../net/kernel-fetch.js';
import type { NodeProgram } from './node.js';

/** The session services a run reaches: the kernel's ports and loopback, where the host has them. */
export type NodeRealmKernel = Pick<Kernel, 'portRegistry'> & Partial<Pick<Kernel, 'routeLoopback'>>;

/** The filesystem methods a call names: NodeFilesystem's, but its change listener. */
export type FsMethod = Exclude<keyof NodeFilesystem, 'onChange'>;

/** A synchronous call the guest makes. */
export type RealmCall =
  | { readonly op: 'fs'; readonly method: FsMethod; readonly args: readonly unknown[] }
  | { readonly op: 'stdin' }
  | { readonly op: 'listen'; readonly port: number }
  | { readonly op: 'unlisten'; readonly port: number }
  | { readonly op: 'watch'; readonly on: boolean };

/** A call's answer: its value, or the error it threw, as data. */
export type RealmAnswer = { readonly value: unknown } | { readonly error: RealmError };

export interface RealmError {
  readonly name: string;
  readonly message: string;
  readonly properties: Readonly<Record<string, string | number | boolean | null>>;
}

/** A response, as data, either way across. */
export interface RealmResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** What the guest posts on `events`. */
export type GuestEvent =
  | { readonly type: 'output'; readonly fd: 1 | 2; readonly data: string | Uint8Array }
  | { readonly type: 'fetch'; readonly id: number; readonly port: number; readonly url: string; readonly method: string; readonly headers: Record<string, string>; readonly body: string | null }
  | { readonly type: 'served'; readonly id: number; readonly response: RealmResponse | null }
  | { readonly type: 'exit'; readonly code: number };

/** What this side posts on `events`. */
export type HostEvent =
  | { readonly type: 'fetched'; readonly id: number; readonly response: RealmResponse | null }
  | { readonly type: 'serve'; readonly id: number; readonly port: number; readonly request: VirtualRequest }
  | { readonly type: 'changed' };

/** The guest's first message: its program and its ports. */
export interface RealmStart {
  readonly program: NodeProgram;
  readonly calls: MessagePort;
  readonly events: MessagePort;
  /** One Int32: set to 1 and notified when an answer is on `calls`. */
  readonly wake: SharedArrayBuffer;
}

// ── The protocol's messages, narrowed where they arrive ─────────────────────
// Each side receives a structured clone it must narrow: a guard per shape.

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const stringRecord = (value: unknown): value is Record<string, string> =>
  record(value) && Object.values(value).every((entry) => typeof entry === 'string');

export function isRealmAnswer(value: unknown): value is RealmAnswer {
  return record(value) && ('value' in value || (record(value.error) && typeof value.error.message === 'string'));
}

const isResponse = (value: unknown): value is RealmResponse | null =>
  value === null || (record(value) && typeof value.status === 'number' && stringRecord(value.headers) && typeof value.body === 'string');

export function isGuestEvent(value: unknown): value is GuestEvent {
  if (!record(value)) return false;
  switch (value.type) {
    case 'output': return (value.fd === 1 || value.fd === 2) && (typeof value.data === 'string' || value.data instanceof Uint8Array);
    case 'fetch':
      return Number.isSafeInteger(value.id) && Number.isSafeInteger(value.port) && typeof value.url === 'string'
        && typeof value.method === 'string' && stringRecord(value.headers) && (value.body === null || typeof value.body === 'string');
    case 'served': return Number.isSafeInteger(value.id) && isResponse(value.response);
    case 'exit': return Number.isSafeInteger(value.code);
    default: return false;
  }
}

export function isHostEvent(value: unknown): value is HostEvent {
  if (!record(value)) return false;
  switch (value.type) {
    case 'fetched': return typeof value.id === 'number' && isResponse(value.response);
    case 'serve': return typeof value.id === 'number' && typeof value.port === 'number' && record(value.request);
    case 'changed': return true;
    default: return false;
  }
}

export function isRealmStart(value: unknown): value is RealmStart {
  return record(value) && record(value.program) && typeof value.program.source === 'string'
    && value.wake instanceof SharedArrayBuffer && record(value.calls) && record(value.events);
}

export function isStat(value: unknown): value is RuntimeVfsStat {
  return record(value) && typeof value.type === 'string' && typeof value.mode === 'number' && typeof value.size === 'number';
}

export function isDirEntries(value: unknown): value is RuntimeVfsDirEntry[] {
  return Array.isArray(value) && value.every((entry) => record(entry) && typeof entry.name === 'string' && typeof entry.type === 'string');
}

// ── Errors, either way across ──────────────────────────────────────────────

/** An error as data: its class name, message and own primitive properties (code, syscall, path, errno, dest, detail). */
export function realmError(error: unknown): RealmError {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error), properties: {} };
  const properties: Record<string, string | number | boolean | null> = {};
  for (const key of Object.getOwnPropertyNames(error)) {
    if (key === 'message' || key === 'stack') continue;
    const value = Reflect.get(error, key);
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') properties[key] = value;
  }
  return { name: error.name, message: error.message, properties };
}

/**
 * The error `error` was: a VfsError as a VfsError (node-compat's fs tells a
 * filesystem refusal by its class, as `rm(..., { force: true })` of a missing
 * path does), a standard class as itself, else an Error bearing its name; with
 * its message and own properties.
 */
export function fromRealmError(error: RealmError): Error {
  const text = (key: string): string | undefined => {
    const value = error.properties[key];
    return typeof value === 'string' ? value : undefined;
  };
  const code = error.properties.code;
  let rebuilt: Error;
  if (error.name === 'VfsError' && isVfsErrorCode(code)) {
    rebuilt = new VfsError(code, '', text('path'), { syscall: text('syscall'), dest: text('dest'), detail: text('detail') });
  } else {
    const Standard = error.name === 'TypeError' ? TypeError : error.name === 'RangeError' ? RangeError : error.name === 'SyntaxError' ? SyntaxError : Error;
    rebuilt = new Standard(error.message);
    if (rebuilt.name !== error.name) Object.defineProperty(rebuilt, 'name', { value: error.name, configurable: true, writable: true });
  }
  Object.defineProperty(rebuilt, 'message', { value: error.message, configurable: true, writable: true });
  for (const [key, value] of Object.entries(error.properties)) {
    if (key === 'name' || key === 'errno' || Object.hasOwn(rebuilt, key)) continue;
    Object.defineProperty(rebuilt, key, { value, configurable: true, enumerable: true, writable: true });
  }
  return rebuilt;
}

// ── The calls this side answers ─────────────────────────────────────────────

/** What a run's calls are answered from. */
export interface RealmServices {
  filesystem(): NodeFilesystem;
  /** fd 0, read to its end, once; empty after. */
  stdin(): Promise<Uint8Array>;
  listen(port: number): void;
  unlisten(port: number): void;
  watch(on: boolean): void;
}

/** A call no method answers, or with arguments not of its kind. */
function refused(what: string): VfsError {
  return new VfsError('EINVAL', `the realm's host answers no ${what}`);
}

const pathArg = (value: unknown): string => {
  if (typeof value !== 'string') throw refused('call without a path');
  return value;
};
const dataArg = (value: unknown): string | Uint8Array => {
  if (typeof value !== 'string' && !(value instanceof Uint8Array)) throw refused('write of anything but text or bytes');
  return value;
};
const modeArg = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || typeof value !== 'number') throw refused('mode that is not a number');
  return value;
};
const mkdirArg = (value: unknown): { recursive?: boolean; mode?: number } | undefined => {
  if (value === undefined) return undefined;
  if (!record(value)) throw refused('mkdir option that is not an object');
  const recursive = value.recursive === undefined || typeof value.recursive === 'boolean' ? value.recursive : undefined;
  if (value.recursive !== undefined && recursive === undefined) throw refused('mkdir option `recursive` that is not a boolean');
  return { ...(recursive === undefined ? {} : { recursive }), ...(value.mode === undefined ? {} : { mode: modeArg(value.mode) }) };
};
const portArg = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0 || value > 65535) throw refused('port that is not one');
  return value;
};

/** NodeFilesystem's `method` on `args`, each checked to be of its kind: only these, never one the object inherits. */
function callFilesystem(fs: NodeFilesystem, method: unknown, args: readonly unknown[]): unknown {
  const [a, b] = args;
  switch (method) {
    case 'readFile': return fs.readFile(pathArg(a));
    case 'readFileString': return fs.readFileString(pathArg(a));
    case 'writeFile': return fs.writeFile(pathArg(a), dataArg(b));
    case 'appendFile': return fs.appendFile(pathArg(a), dataArg(b));
    case 'exists': return fs.exists(pathArg(a));
    case 'isFile': return fs.isFile(pathArg(a));
    case 'isDirectory': return fs.isDirectory(pathArg(a));
    case 'stat': return fs.stat(pathArg(a));
    case 'lstat': return fs.lstat(pathArg(a));
    case 'mkdir': return fs.mkdir(pathArg(a), mkdirArg(b));
    case 'readdir': return fs.readdir(pathArg(a));
    case 'unlink': return fs.unlink(pathArg(a));
    case 'rmdir': return fs.rmdir(pathArg(a));
    case 'rmdirRecursive': return fs.rmdirRecursive(pathArg(a));
    case 'rename': return fs.rename(pathArg(a), pathArg(b));
    case 'copyFile': return fs.copyFile(pathArg(a), pathArg(b));
    case 'chmod': return fs.chmod(pathArg(a), modeArg(b));
    default: throw refused(`filesystem method ${JSON.stringify(String(method))}`);
  }
}

async function performCall(call: unknown, services: RealmServices): Promise<unknown> {
  if (!record(call)) throw refused('call that is not one');
  switch (call.op) {
    case 'fs': {
      if (!Array.isArray(call.args)) throw refused('filesystem call without arguments');
      return callFilesystem(services.filesystem(), call.method, call.args);
    }
    case 'stdin': return services.stdin();
    case 'listen': return services.listen(portArg(call.port));
    case 'unlisten': return services.unlisten(portArg(call.port));
    case 'watch': {
      if (typeof call.on !== 'boolean') throw refused('watch that is neither on nor off');
      return services.watch(call.on);
    }
    default: throw refused(`call ${JSON.stringify(String(call.op))}`);
  }
}

/**
 * The answer to `call`, whatever the guest sent: the value of one of the calls
 * above, or the error it raised; an error, too, for a call none answers and
 * for a value that cannot cross to the guest. Never rejects.
 */
export async function serveRealmCall(call: unknown, services: RealmServices): Promise<RealmAnswer> {
  try {
    const value = await performCall(call, services);
    // Proven to cross before it is posted: a value that cannot is an error.
    structuredClone(value);
    return { value };
  } catch (error) {
    return { error: realmError(error) };
  }
}

/**
 * Run `program` in a worker of its own, serving what it reaches from `ctx` and
 * `kernel`. Resolves with its exit code once its realm has ended: its event
 * loop ran empty, or the caller's abort (kill, Ctrl-C) terminated it.
 */
export async function runNodeInRealm(program: NodeProgram, ctx: CommandContext, kernel: NodeRealmKernel | undefined): Promise<number> {
  if (ctx.signal.aborted) return 130;
  let threads: typeof WorkerThreads;
  try {
    // Imported when a program runs, not with the module: workerd, which loads
    // this module in the hosted session, has no worker threads.
    threads = await import('node:worker_threads');
  } catch {
    await ctx.stderr.write('node: this host has no worker threads, which the inline node runs each program in (Bun and Node have them)\n');
    return 1;
  }
  // An abort that came while the module loaded: nothing is started.
  if (ctx.signal.aborted) return 130;
  const calls = new threads.MessageChannel();
  const events = new threads.MessageChannel();
  const wake = new SharedArrayBuffer(4);
  const flag = new Int32Array(wake);
  const filesystem = synchronousFilesystem(ctx.vfs);
  const worker = new threads.Worker(new URL('./node-guest.js', import.meta.url));
  // A kill or Ctrl-C ends the realm, even in a loop that never yields; the
  // signal is checked again once the listener is on, so none is missed.
  let aborted = false;
  const abort = () => {
    aborted = true;
    void worker.terminate().catch(() => {});
  };
  ctx.signal.addEventListener('abort', abort, { once: true });
  if (ctx.signal.aborted) abort();
  const start: RealmStart = { program, calls: calls.port2, events: events.port2, wake };
  worker.postMessage(start, [calls.port2, events.port2]);

  // Output in the order it was written, each write after the last.
  let written: Promise<void> = Promise.resolve();
  const write = (stream: CommandOutputStream, data: string | Uint8Array) => {
    written = written.then(async () => {
      if (typeof data === 'string') await stream.write(data);
      else if (stream.writeBytes) await stream.writeBytes(data);
      else await stream.write(new TextDecoder().decode(data));
    }).catch(() => {});
  };
  // Posted, or the post's own failure posted; the guest is woken either way.
  const answer = (reply: RealmAnswer) => {
    try {
      calls.port1.postMessage(reply);
    } catch (error) {
      try { calls.port1.postMessage({ error: realmError(error) }); } catch { /* the port is gone */ }
    }
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  };
  const post = (event: HostEvent): boolean => {
    try {
      events.port1.postMessage(event);
      return true;
    } catch {
      return false;
    }
  };
  const ports = new Set<number>();
  const pending = new Map<number, (response: RealmResponse | null) => void>();
  let served = 0;
  // A server of the guest's, as the session's other processes reach it.
  const serveFromGuest = (port: number): VirtualRequestHandler => (request: VirtualRequest, response: VirtualResponse) => {
    const id = ++served;
    const done = new Promise<void>((resolve) => {
      pending.set(id, (reply) => {
        if (reply) Object.assign(response, { statusCode: reply.status, headers: reply.headers, body: reply.body });
        else Object.assign(response, { statusCode: 502, headers: { 'content-type': 'text/plain' }, body: 'Bad Gateway: the server has ended\n' });
        resolve();
      });
    });
    Object.assign(response, { _donePromise: done });
    if (!post({ type: 'serve', id, port, request })) {
      pending.get(id)?.(null);
      pending.delete(id);
    }
  };
  let unwatch: (() => void) | undefined;
  let stdinTaken = false;
  const services: RealmServices = {
    filesystem,
    stdin: async () => {
      if (stdinTaken || !ctx.stdin || ctx.stdin === ctx.terminalStdin) return new Uint8Array(0);
      stdinTaken = true;
      return readToEnd(ctx.stdin);
    },
    listen: (port) => {
      if (!kernel) throw new VfsError('EACCES', `listen: no ports on this host :${port}`);
      kernel.portRegistry.set(port, serveFromGuest(port));
      ports.add(port);
    },
    unlisten: (port) => {
      if (ports.delete(port)) kernel?.portRegistry.delete(port);
    },
    watch: (on) => {
      unwatch?.();
      unwatch = undefined;
      if (!on) return;
      const fs = filesystem();
      const listener = () => { post({ type: 'changed' }); };
      fs.onChange = listener;
      unwatch = () => { if (fs.onChange === listener) fs.onChange = undefined; };
    },
  };
  calls.port1.on('message', (request) => {
    // Answered as soon as known; fd 0 waits for its end, holding the guest as Node's read does.
    void serveRealmCall(request, services).then(answer);
  });

  let code: number | null = null;
  const onEvent = (event: unknown) => {
    if (!isGuestEvent(event)) return;
    switch (event.type) {
      case 'output':
        write(event.fd === 1 ? ctx.stdout : ctx.stderr, event.data);
        return;
      case 'exit':
        code = event.code;
        return;
      case 'served':
        pending.get(event.id)?.(event.response);
        pending.delete(event.id);
        return;
      case 'fetch':
        void fetchForGuest(kernel, event).then((response) => {
          post({ type: 'fetched', id: event.id, response });
        });
        return;
    }
  };
  events.port1.on('message', onEvent);

  let failure: Error | null = null;
  worker.on('error', (error: Error) => { failure = error; });
  const exited = await new Promise<number>((resolve) => worker.once('exit', resolve));
  ctx.signal.removeEventListener('abort', abort);
  // What the guest posted before it ended, its last output and its exit code
  // among it, may still be queued: the worker's exit does not wait for it.
  for (let left = threads.receiveMessageOnPort(events.port1); left; left = threads.receiveMessageOnPort(events.port1)) {
    onEvent(left.message);
  }

  for (const port of ports) kernel?.portRegistry.delete(port);
  for (const respond of pending.values()) respond(null);
  unwatch?.();
  calls.port1.close();
  events.port1.close();
  await written;
  if (aborted) return 130;
  if (failure !== null) {
    const error: Error = failure;
    await ctx.stderr.write(`${error.stack ?? error.message}\n`);
    return code ?? 1;
  }
  return code ?? exited;
}

/** All of `stdin`, to its end. */
async function readToEnd(stdin: NonNullable<CommandContext['stdin']>): Promise<Uint8Array> {
  if (!stdin.readBytes) return new TextEncoder().encode(await stdin.readAll());
  const pieces: Uint8Array[] = [];
  let length = 0;
  for (let piece = await stdin.readBytes(65536); piece !== null; piece = await stdin.readBytes(65536)) {
    pieces.push(piece);
    length += piece.length;
  }
  const all = new Uint8Array(length);
  let at = 0;
  for (const piece of pieces) { all.set(piece, at); at += piece.length; }
  return all;
}

/**
 * A loopback request of the guest's, served as the session serves its own:
 * the kernel's ports, then its loopback router. Null when it cannot be made
 * or answered, its body included: a failure is the guest's failed request.
 */
async function fetchForGuest(kernel: NodeRealmKernel | undefined, event: Extract<GuestEvent, { type: 'fetch' }>): Promise<RealmResponse | null> {
  if (!kernel) return null;
  try {
    const request = new Request(event.url, { method: event.method, headers: event.headers, body: event.body });
    const result = await dispatchWorkspaceRequest(kernel, event.port, request);
    if (result.kind !== 'response') return null;
    const headers: Record<string, string> = {};
    result.response.headers.forEach((value, key) => { headers[key] = value; });
    return { status: result.response.status, headers, body: await result.response.text() };
  } catch {
    return null;
  }
}
