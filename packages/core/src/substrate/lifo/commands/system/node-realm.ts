/**
 * The inline `node`'s realm: each run is a realm of its own (runtime/realm.ts).
 *
 * The program used to be evaluated with `new Function` in the host's realm,
 * so its globals and intrinsics were the host's: a program that rebound
 * `Array` or installed fake timers changed them for the host (in Kinu's CLI, a
 * rebound `globalThis.Array` broke the host's sqlite-vfs).
 *
 * The guest (node-guest.ts) runs node-program.ts's runNodeProgram. What it
 * reaches outside its realm crosses here (its messages: node-realm-protocol.ts):
 *
 *   - synchronous calls ({@link NodeCall}: the filesystem `require` and `fs`
 *     read, fd 0, the session's ports). A call this side answers
 *     asynchronously (fd 0, read to its end) holds the guest exactly as a
 *     blocking read holds a Node program;
 *   - events: its output, the requests its loopback clients make, the
 *     requests this side forwards to its servers, its exit, and under an
 *     egress the requests it makes off the box, whose responses cross back
 *     as they arrive (runtime/realm-egress.ts).
 *
 * Everything the program sends is untrusted: this side answers only the calls
 * it names below, with arguments of their kind, and never lets a message, an
 * answer that cannot cross, or a failed request end the host.
 *
 * workerd has no worker threads; its sessions run their own `node` (worker
 * hosted/commands.ts).
 */

import { exitCodeForAbortSignal } from '../../shell/signals.js';
import type { RuntimeOpenFlags, RuntimeVfsDirEntry, RuntimeVfsStat } from '../../../../runtime/os-contracts.js';
import { realmError, realmOutcome, startRealm, type RealmOutcome } from '../../../../runtime/realm.js';
import type { CommandContext } from '../types.js';
import type { Kernel, VirtualRequest, VirtualRequestHandler, VirtualResponse } from '../../kernel/index.js';
import type { NodeFilesystem, NodeWatch } from '../../node-compat/filesystem.js';
import type { VfsEvent } from '../../../../vfs/events.js';
import { synchronousFilesystem } from '../../node-compat/filesystem.js';
import { SinkWriter } from '../../../../_shared/byte-stream.js';
import { uncaughtReport, writeFailure } from '../../node-compat/output-failure.js';
import { concatBytes, enc } from '../../../../_shared/bytes.js';
import { VfsError } from '../../../../vfs/vfs-error.js';
import { dispatchWorkspaceRequest } from '../net/kernel-fetch.js';
import { isEgressGuestEvent, isEgressHostEvent, RealmEgress, type EgressGuestEvent, type EgressHostEvent } from '../../../../runtime/realm-egress.js';
import type { NodeProgram } from './node-program.js';
import type { OutputSource } from '../../node-compat/standard-streams.js';
import {
  isGuestEvent, record, type FdKind, type GuestEvent, type HostEvent, type NodeCall, type NodeRealmPayload, type OutputFailure, type RealmResponse,
} from './node-realm-protocol.js';

/** The session services a run reaches: the kernel's ports and loopback, where the host has them. */
export type NodeRealmKernel = Pick<Kernel, 'portRegistry'> & Partial<Pick<Kernel, 'routeLoopback' | 'dns' | 'network'>>;

// ── The calls this side answers ─────────────────────────────────────────────

/** What a run's calls are answered from. */
export interface RealmServices {
  filesystem(): NodeFilesystem;
  /** fd 0, read to its end, once; empty after. */
  stdin(): Promise<Uint8Array>;
  /** What standard descriptor `fd` is. */
  fdKind(fd: number): FdKind;
  /** The terminal's raw mode, on or off. */
  setRawMode(on: boolean): void;
  listen(port: number): void;
  unlisten(port: number): void;
  /** Watch `path` as watch `id`, or stop it (null). */
  watch(id: number, path: string | null): void;
  /** umask(2): the mask the program creates with from now on. */
  setUmask(mask: number): void;
  /** Once writes up to number `upTo` are made: those after number `after` that failed (`round`'s settle-mark). */
  settle(round: number, after: number, upTo: number): Promise<readonly OutputFailure[]>;
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
const fdArg = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) throw refused('descriptor that is not one');
  return value;
};
/** An offset, or null for the descriptor's own: never a negative one, which the descriptor refuses. */
const positionArg = (value: unknown): number | null => {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || typeof value !== 'number') throw refused('position that is not a number');
  return value;
};
const sizeArg = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) throw refused('size that is not one');
  return value;
};
const bytesArg = (value: unknown): Uint8Array => {
  if (!(value instanceof Uint8Array)) throw refused('write of anything but bytes');
  return value;
};
const OPEN_FLAGS = ['read', 'write', 'append', 'create', 'exclusive', 'directory', 'truncate', 'followSymlinks', 'sync'] as const;
const openFlagsArg = (value: unknown): RuntimeOpenFlags => {
  if (!record(value)) throw refused('open flags that are not an object');
  const flags: RuntimeOpenFlags = {};
  for (const name of OPEN_FLAGS) {
    const flag = value[name];
    if (flag === undefined) continue;
    if (typeof flag !== 'boolean') throw refused(`open flag \`${name}\` that is not a boolean`);
    flags[name] = flag;
  }
  return value.mode === undefined ? flags : { ...flags, mode: modeArg(value.mode) };
};
/** A chown side: a uid or gid, or null, which keeps the file's. */
const ownerArg = (value: unknown): number | null => {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0 || value > 0xffffffff) throw refused('owner that is not an id');
  return value;
};
const flagArg = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw refused('flag that is not a boolean');
  return value;
};
const portArg = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0 || value > 65535) throw refused('port that is not one');
  return value;
};

/** NodeFilesystem's `method` on `args`, each checked to be of its kind: only these, never one the object inherits. */
function callFilesystem(fs: NodeFilesystem, method: unknown, args: readonly unknown[]): unknown {
  const [a, b, c, d] = args;
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
    case 'realpath': return fs.realpath(pathArg(a));
    case 'symlink': return fs.symlink(pathArg(a), pathArg(b));
    case 'readlink': return fs.readlink(pathArg(a));
    case 'mkdir': return fs.mkdir(pathArg(a), mkdirArg(b));
    case 'readdir': return fs.readdir(pathArg(a));
    case 'unlink': return fs.unlink(pathArg(a));
    case 'rmdir': return fs.rmdir(pathArg(a));
    case 'rmdirRecursive': return fs.rmdirRecursive(pathArg(a));
    case 'rename': return fs.rename(pathArg(a), pathArg(b));
    case 'copyFile': return fs.copyFile(pathArg(a), pathArg(b));
    case 'chmod': return fs.chmod(pathArg(a), modeArg(b));
    case 'chown': return fs.chown(pathArg(a), ownerArg(b), ownerArg(c), flagArg(d));
    case 'open': return fs.open(pathArg(a), openFlagsArg(b));
    case 'read': return fs.read(fdArg(a), positionArg(b), sizeArg(c));
    case 'write': return fs.write(fdArg(a), positionArg(b), bytesArg(c));
    case 'fstat': return fs.fstat(fdArg(a));
    case 'fchown': return fs.fchown(fdArg(a), ownerArg(b), ownerArg(c));
    case 'ftruncate': return fs.ftruncate(fdArg(a), sizeArg(b));
    case 'fsync': return fs.fsync(fdArg(a));
    case 'close': return fs.close(fdArg(a));
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
      if (!Number.isSafeInteger(call.id) || typeof call.id !== 'number') throw refused('watch without an id');
      return services.watch(call.id, call.path === null ? null : pathArg(call.path));
    }
    case 'umask': {
      if (!Number.isSafeInteger(call.mask) || typeof call.mask !== 'number' || call.mask < 0 || call.mask > 0o777) throw refused('mask that is not one');
      return services.setUmask(call.mask);
    }
    case 'settle': {
      if (typeof call.round !== 'number' || typeof call.after !== 'number' || typeof call.upTo !== 'number'
        || !Number.isSafeInteger(call.round) || !Number.isSafeInteger(call.after) || !Number.isSafeInteger(call.upTo)) throw refused('settle without its round and write numbers');
      return services.settle(call.round, call.after, call.upTo);
    }
    case 'fdKind': {
      if (call.fd !== 0 && call.fd !== 1 && call.fd !== 2) throw refused('descriptor but 0, 1 or 2');
      return services.fdKind(call.fd);
    }
    case 'rawMode': {
      if (typeof call.on !== 'boolean') throw refused('raw mode that is not on or off');
      return services.setRawMode(call.on);
    }
    default: throw refused(`call ${JSON.stringify(String(call.op))}`);
  }
}

/**
 * The answer to `call`, whatever the guest sent: the value of one of the calls
 * above, or the error it raised; an error, too, for a call none answers and
 * for a value that cannot cross to the guest. Never rejects.
 */
export function serveRealmCall(call: unknown, services: RealmServices): Promise<RealmOutcome> {
  return realmOutcome(() => performCall(call, services));
}

/**
 * Run `program` in a realm of its own, serving what it reaches from `ctx` and
 * `kernel`. Resolves with its exit code once its realm has ended: its event
 * loop ran empty, or the caller's abort (kill, Ctrl-C) terminated it.
 */
export async function runNodeInRealm(program: NodeProgram, ctx: CommandContext, kernel: NodeRealmKernel | undefined): Promise<number> {
  if (ctx.signal.aborted) return exitCodeForAbortSignal(ctx.signal);
  // The program's own mask, a copy of the shell's as it started, as a child's is.
  let mask = ctx.cred.umask;
  const filesystem = synchronousFilesystem(ctx.vfs, () => mask);

  // Output in the order it was written, each write after the last; bytes
  // for an output that takes text are decoded across writes, as one stream.
  // Each write is made, as each is a write(2) in Node (which ignores SIGPIPE);
  // one that fails is the program's to hear of, through what made it.
  let written: Promise<void> = Promise.resolve();
  const writers = new Map<1 | 2, SinkWriter>();
  // The failures of the program's stream writes the guest has not taken
  // (heard), in the order they came; and each writer's writes not yet made,
  // while it has any, with whether their failures are the guest's.
  let unheard: OutputFailure[] = [];
  const inFlight = { 1: new Map<number, { pending: number; heard: boolean }>(), 2: new Map<number, { pending: number; heard: boolean }>() };
  const writerOf = (fd: 1 | 2): SinkWriter => {
    let writer = writers.get(fd);
    if (writer === undefined) writers.set(fd, writer = new SinkWriter(fd === 1 ? ctx.stdout : ctx.stderr));
    return writer;
  };
  // The guest's loop ran empty with writes it would hear of outstanding: it
  // is told once the writes it names are made (settle).
  let lastQueued = 0;
  let lastSettled = 0;
  let settleUpTo = 0;
  // The writes a program's 'beforeExit' listeners make are settled by a call
  // (settle), which may come before their events: the failures after the
  // guest's mark are kept for it, and it waits for the writes it names.
  let marked: { readonly round: number; readonly after: number; readonly failures: OutputFailure[] } | null = null;
  let answeredRound = 0;
  const settleCalls: { readonly upTo: number; resolve(): void }[] = [];
  const settled = () => {
    for (const call of settleCalls.filter((waiting) => waiting.upTo <= lastSettled)) {
      settleCalls.splice(settleCalls.indexOf(call), 1);
      call.resolve();
    }
    if (settleUpTo === 0 || lastSettled < settleUpTo) return;
    settleUpTo = 0;
    post({ type: 'output-settled', seq: lastSettled });
  };
  const write = (fd: 1 | 2, source: OutputSource, writer: number, data: string | Uint8Array) => {
    const seq = ++lastQueued;
    let flight: { pending: number; heard: boolean } | undefined;
    if (source === 'stream') {
      flight = inFlight[fd].get(writer);
      if (flight === undefined) inFlight[fd].set(writer, flight = { pending: 0, heard: false });
      flight.pending++;
    }
    written = written.then(async () => {
      try {
        if (typeof data === 'string') await writerOf(fd).writeText(data);
        else await writerOf(fd).write(data);
      } catch (error) {
        const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
        const failure: OutputFailure = { seq, fd, code: typeof code === 'string' ? code : 'EIO', pipe: ctx.isFdPipe?.(fd) === true, source, writer };
        if (flight !== undefined && !flight.heard) unheard.push(failure);
        // One a 'beforeExit' listener made is told by the settle call's answer, not as an event the guest's loop would run again for.
        if (marked !== null && seq > marked.after) marked.failures.push(failure);
        else post({ type: 'output-failed', ...failure });
      }
      if (flight !== undefined && --flight.pending === 0) inFlight[fd].delete(writer);
      lastSettled = seq;
      settled();
    });
  };
  // The realm, once it has started: a request for one of the guest's servers waits for none before.
  let post: (event: HostEvent) => boolean = () => false;
  const ports = new Set<number>();
  const pending = new Map<number, (response: RealmResponse | null) => void>();
  let served = 0;
  // A server of the guest's, as the session's other processes reach it.
  const serveFromGuest = (port: number): VirtualRequestHandler => (request: VirtualRequest, response: VirtualResponse) => {
    const id = ++served;
    const done = new Promise<void>((resolve) => {
      pending.set(id, (reply) => {
        if (reply) Object.assign(response, { statusCode: reply.status, statusMessage: reply.statusText, headers: reply.headers, body: reply.body });
        else Object.assign(response, { statusCode: 502, headers: { 'content-type': 'text/plain' }, body: 'Bad Gateway: the server has ended\n' });
        resolve();
      });
    });
    response._donePromise = done;
    if (!post({ type: 'serve', id, port, request })) {
      pending.get(id)?.(null);
      pending.delete(id);
    }
  };
  const watches = new Map<number, NodeWatch>();
  // fd 0 has one reader, the program: its pieces and its read to the end are
  // taken in the order asked for. A piece it left waiting for when it ended
  // is withdrawn, so what is typed next is the shell's, not swallowed.
  const ended = new AbortController();
  // The terminal's mode before the program first changed it, which its end restores, as libuv restores the
  // termios it saved (uv_tty_reset_mode); undefined while it has changed nothing.
  let entryRawMode: boolean | undefined;
  let stdinAtEnd = false;
  // Reads waiting for their turn; one `signal` withdraws leaves at once, taking nothing.
  const stdinQueue: Array<() => void> = [];
  let stdinBusy = false;
  const fromStdin = <T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> => new Promise<T>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const leave = () => {
      const at = stdinQueue.indexOf(turn);
      if (at < 0) return;
      stdinQueue.splice(at, 1);
      reject(signal?.reason);
    };
    const turn = () => {
      signal?.removeEventListener('abort', leave);
      stdinBusy = true;
      read().then(resolve, reject).finally(() => {
        stdinBusy = false;
        stdinQueue.shift()?.();
      });
    };
    if (!stdinBusy) { turn(); return; }
    signal?.addEventListener('abort', leave, { once: true });
    stdinQueue.push(turn);
  });
  /** fd 0's next piece, never an empty one, until `signal` ends: a read withdrawn takes nothing. */
  const stdinPiece = (signal: AbortSignal): Promise<Uint8Array | null> => fromStdin(async () => {
    const stdin = ctx.stdin;
    for (;;) {
      if (stdinAtEnd || !stdin) return null;
      signal.throwIfAborted();
      const piece = stdin.readBytes ? await stdin.readBytes(65536, signal) : textPiece(await stdin.read());
      if (piece === null) stdinAtEnd = true;
      if (piece === null || piece.length > 0) return piece;
    }
  }, signal);
  /** The program's reads of fd 0 in flight, each withdrawn when it cancels or ends. */
  const stdinInFlight = new Map<number, AbortController>();
  const services: RealmServices = {
    filesystem,
    stdin: () => fromStdin(async () => {
      if (stdinAtEnd || !ctx.stdin || ctx.stdin === ctx.terminalStdin) return new Uint8Array(0);
      stdinAtEnd = true;
      return readToEnd(ctx.stdin);
    }),
    fdKind: (fd) => (ctx.isFdTerminal?.(fd) ? 'terminal' : ctx.isFdPipe?.(fd) ? 'pipe' : 'other'),
    setRawMode: (on) => {
      entryRawMode ??= ctx.getRawMode?.() ?? false;
      ctx.setRawMode?.(on);
    },
    listen: (port) => {
      if (!kernel) throw new VfsError('EACCES', `listen: no ports on this host :${port}`);
      kernel.portRegistry.set(port, serveFromGuest(port));
      ports.add(port);
    },
    unlisten: (port) => {
      if (ports.delete(port)) kernel?.portRegistry.delete(port);
    },
    setUmask: (next) => { mask = next; },
    settle: async (round, after, upTo) => {
      if (lastSettled < upTo) await new Promise<void>((resolve) => { settleCalls.push({ upTo, resolve }); });
      answeredRound = round;
      const failures = marked !== null && marked.round === round ? marked.failures.filter((failure) => failure.seq > after && failure.seq <= upTo) : [];
      marked = null;
      return failures;
    },
    watch: (id, path) => {
      watches.get(id)?.close();
      watches.delete(id);
      if (path === null) return;
      watches.set(id, filesystem().watch(path, (event) => {
        post({ type: 'changed', id, event: event.oldPath === undefined
          ? { type: event.type, path: event.path, timestamp: event.timestamp }
          : { type: event.type, path: event.path, oldPath: event.oldPath, timestamp: event.timestamp } });
      }));
    },
  };

  let code: number | null = null;
  let endedItself = false;
  // The program's process's network (WorkspaceNetwork.forProcess).
  const network = kernel?.network?.forProcess(ctx.pid);
  const payload: NodeRealmPayload = { program, hosts: kernel?.dns?.hostsFile(), egress: network?.egress !== undefined };
  const egress = network?.egress === undefined ? null : new RealmEgress(network, (event) => { post(event); });
  const realm = await startRealm({
    entry: new URL('./node-guest.js', import.meta.url),
    payload,
    serve: (call) => performCall(call, services),
    onEvent: (event) => {
      if (isEgressGuestEvent(event)) { egress?.handle(event); return; }
      if (!isGuestEvent(event)) return;
      switch (event.type) {
        case 'output':
          write(event.fd, event.source, event.writer, event.data);
          return;
        case 'settle':
          settleUpTo = event.upTo;
          settled();
          return;
        case 'settle-mark':
          // A mark whose round its call has answered already (the call came first, its writes none) keeps nothing.
          if (event.round > answeredRound) marked = { round: event.round, after: event.after, failures: [] };
          return;
        case 'exit':
          code = event.code;
          endedItself ||= event.ended;
          return;
        case 'heard': {
          const flight = inFlight[event.fd].get(event.writer);
          if (flight !== undefined) flight.heard = true;
          unheard = unheard.filter((failure) => failure.fd !== event.fd || failure.writer !== event.writer);
          return;
        }
        case 'served':
          pending.get(event.id)?.(event.response);
          pending.delete(event.id);
          return;
        case 'fetch':
          void fetchForGuest(kernel, event).then((response) => {
            post({ type: 'fetched', id: event.id, response });
          });
          return;
        case 'stdin-read': {
          const withdraw = new AbortController();
          stdinInFlight.set(event.id, withdraw);
          const signal = AbortSignal.any([withdraw.signal, ended.signal]);
          void stdinPiece(signal).then((data) => {
            stdinInFlight.delete(event.id);
            post({ type: 'stdin', id: event.id, data });
          }, (error: unknown) => {
            stdinInFlight.delete(event.id);
            if (signal.aborted) post({ type: 'stdin', id: event.id, withdrawn: true });
            else post({ type: 'stdin', id: event.id, error: realmError(error) });
          });
          return;
        }
        case 'stdin-cancel':
          stdinInFlight.get(event.id)?.abort();
          return;
      }
    },
  });
  if ('unavailable' in realm) {
    await ctx.stderr.write(`node: ${realm.unavailable}, and the inline node runs each program in a realm of its own\n`);
    return 1;
  }
  post = (event) => realm.post(event);
  // A kill or Ctrl-C ends the realm, even in a loop that never yields; the
  // signal is checked again once the listener is on, so none is missed.
  const abort = () => realm.terminate();
  ctx.signal.addEventListener('abort', abort, { once: true });
  if (ctx.signal.aborted) abort();

  const end = await realm.ended;
  ended.abort();
  if (entryRawMode !== undefined && ctx.getRawMode?.() !== entryRawMode) ctx.setRawMode?.(entryRawMode);
  ctx.signal.removeEventListener('abort', abort);
  for (const port of ports) kernel?.portRegistry.delete(port);
  for (const respond of pending.values()) respond(null);
  egress?.close();
  for (const watch of watches.values()) watch.close();
  await written;
  // A write through the program's stream that failed where the program could
  // not hear it (it had ended, nothing listening holding it) ends it as the
  // error would have: Node's report of it, and status 1. The first such
  // failure is the one; a console write's failure is no one's.
  const failure = endedItself || end.terminated || end.failure !== null ? undefined : unheard[0];
  if (failure !== undefined) {
    // util is loaded only here: the guest loads this module too, and every program would pay for it.
    const { inspect } = await import('node:util');
    await writerOf(2).writeText(`${uncaughtReport(writeFailure(failure.code, failure.pipe), (value) => inspect(value))}\n`).catch(() => {});
    code = 1;
  }
  // What a character left unfinished at the end: the program has ended, and
  // no one is left to hear that its last bytes could not be written.
  for (const writer of writers.values()) await writer.end().catch(() => {});
  if (end.terminated) return exitCodeForAbortSignal(ctx.signal);
  if (end.failure !== null) {
    await ctx.stderr.write(`${end.failure.stack ?? end.failure.message}\n`);
    return code ?? 1;
  }
  return code ?? end.code;
}

/** A text read's piece as bytes; null at the end. */
function textPiece(text: string | null): Uint8Array | null {
  return text === null ? null : enc.encode(text);
}

/** All of `stdin`, to its end. */
async function readToEnd(stdin: NonNullable<CommandContext['stdin']>): Promise<Uint8Array> {
  if (!stdin.readBytes) return enc.encode(await stdin.readAll());
  const pieces: Uint8Array[] = [];
  for (let piece = await stdin.readBytes(65536); piece !== null; piece = await stdin.readBytes(65536)) pieces.push(piece);
  return concatBytes(pieces);
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
    return { status: result.response.status, statusText: result.response.statusText, headers, body: await result.response.text() };
  } catch {
    return null;
  }
}
