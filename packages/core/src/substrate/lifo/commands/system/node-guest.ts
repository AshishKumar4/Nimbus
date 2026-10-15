/**
 * An inline `node` run, inside the worker that is its realm (node-realm.ts).
 *
 * Everything the program reaches outside the realm goes through the host
 * (runtime/realm-guest.ts): the filesystem and fd 0 by synchronous calls,
 * its output and its network by events. The realm is joined before the
 * program runs, and its ports live only in this module's closure.
 *
 * The realm lives as a Node process does: while its event loop has work. Its
 * own timers hold it; so does `events` while a server it started listens, while
 * a request it made is unanswered and while it waits on a response body (its
 * synchronous calls need no loop). A
 * rejection or exception nothing handles is printed and ends it with 1, an
 * ES module whose top-level await never settles with 13.
 */

import realm from 'node:process';
import { joinRealm } from '../../../../runtime/realm-guest.js';
import { DNSResolver } from '../../kernel/dns-resolver.js';
import { createHostsResolver, type VirtualRequest, type VirtualRequestHandler, type VirtualResponse } from '../../kernel/index.js';
import type { NodeFilesystem } from '../../node-compat/filesystem.js';
import type { VfsEvent } from '../../../../vfs/events.js';
import type { FailableOutput, OutputSource, StandardInput, StandardPiece } from '../../node-compat/standard-streams.js';
import type { ProgramTerminal } from '../../node-compat/tty-streams.js';
import type { CommandOutputStream } from '../types.js';
import { uncaughtReport, writeFailure } from '../../node-compat/output-failure.js';
import type { LifoProcess } from '../../node-compat/process.js';
import { ProcessExitError } from '../../node-compat/index.js';
import { useNodeErrorInspect } from '../../../../_shared/node-error.js';
import { runNodeProgram } from './node-program.js';
import { routeFetchThroughHost, type RealmEgressGuest } from '../../../../runtime/realm-egress-guest.js';
import { isEgressHostEvent } from '../../../../runtime/realm-egress.js';
import {
  isDirEntries, isHostEvent, isNodeRealmPayload, isOutputFailures, isStat, type OutputFailure,
  type FdKind, type GuestEvent, type NodeCall, type RealmResponse,
} from './node-realm-protocol.js';
import { fromRealmError } from '../../../../runtime/realm.js';

// Node's errors show a value as util.inspect does ('a string' quoted), the program's realm's.
useNodeErrorInspect((value, options) => realm.getBuiltinModule('node:util').inspect(value, options));

const joined = await joinRealm();
if (!isNodeRealmPayload(joined.payload)) throw new Error('node-guest: started without a program');
const { program, hosts, egress } = joined.payload;
// The kernel's resolver, as the host sent it; one with the default /etc/hosts without a kernel.
const dns = hosts === undefined ? createHostsResolver() : new DNSResolver();
if (hosts !== undefined) dns.loadHostsFile(hosts);
const { events } = joined;

/** A synchronous call to the host: its value is the host's answer, as cloned. */
const call = (request: NodeCall): unknown => joined.call(request);

/** A host answer that is not the shape its call returns: a broken realm, not a program error. */
function malformed(method: string): never {
  throw new Error(`node: the host answered ${method} with something it does not return`);
}

function post(event: GuestEvent): void {
  joined.post(event);
}

// ── Liveness ────────────────────────────────────────────────────────────────

let mainDone = false;
let exiting = false;
const fetched = new Map<number, (response: RealmResponse | null) => void>();
/**
 * Under an egress, the program's network is its host's: `fetch` (and the
 * http and https modules, which use it) crosses to the host, which sends each
 * request out through the egress (runtime/realm-egress.ts). WebSocket frames
 * cross the realm too. What the program waits
 * on from off the box (a response's head, a chunk of a body it is reading)
 * holds the realm, as an active socket holds a Node process.
 */
let offTheBox: RealmEgressGuest | null = null;
/** `events` holds the realm open while anything of the program's waits on it. */
function holdWhileBusy(): void {
  joined.hold(fetched.size > 0 || ports.size > 0 || persistentWatches > 0 || (offTheBox?.awaited ?? 0) > 0 || settling || stdinHolds > 0);
}

/** End the process now with `code`, as process.exit() and a fatal error do: a write that fails later is no one's. */
function exitNow(code: number): never {
  const status = exiting ? code : tellExit(code, true);
  exiting = true;
  post({ type: 'exit', code: status, ended: true });
  return realm.exit(status);
}

/** The program's process hears 'exit' (LifoProcess.exitWith), and its status is then what its listeners leave. */
function tellExit(code: number, explicit: boolean): number {
  if (programProcess === null) return code;
  try {
    return programProcess.exitWith(code, explicit);
  } catch (error) {
    postOutput(2, 'console', 0, `${uncaughtReport(error, (value) => realm.getBuiltinModule('node:util').inspect(value))}\n`);
    return 1;
  }
}

/** The program's process, once runNodeProgram has made it. */
let programProcess: LifoProcess | null = null;

// ── The filesystem, each method's answer narrowed to what it returns ───────

const bytes = (value: unknown, method: string) => value instanceof Uint8Array ? value : malformed(method);
const text = (value: unknown, method: string) => typeof value === 'string' ? value : malformed(method);
const flagOf = (value: unknown, method: string) => typeof value === 'boolean' ? value : malformed(method);
const stat = (value: unknown, method: string) => isStat(value) ? value : malformed(method);
const count = (value: unknown, method: string) => Number.isSafeInteger(value) && typeof value === 'number' && value >= 0 ? value : malformed(method);
/** The program's watches (NodeFilesystem.watch), by id: the host tells each its changes. */
const watches = new Map<number, { readonly listener: (event: VfsEvent) => void; persistent: boolean }>();
let nextWatch = 1;
let persistentWatches = 0;
const filesystem: NodeFilesystem = {
  readFile: (path) => bytes(call({ op: 'fs', method: 'readFile', args: [path] }), 'readFile'),
  readFileString: (path) => text(call({ op: 'fs', method: 'readFileString', args: [path] }), 'readFileString'),
  writeFile: (path, data) => { call({ op: 'fs', method: 'writeFile', args: [path, data] }); },
  appendFile: (path, data) => { call({ op: 'fs', method: 'appendFile', args: [path, data] }); },
  exists: (path) => flagOf(call({ op: 'fs', method: 'exists', args: [path] }), 'exists'),
  isFile: (path) => flagOf(call({ op: 'fs', method: 'isFile', args: [path] }), 'isFile'),
  isDirectory: (path) => flagOf(call({ op: 'fs', method: 'isDirectory', args: [path] }), 'isDirectory'),
  stat: (path) => stat(call({ op: 'fs', method: 'stat', args: [path] }), 'stat'),
  lstat: (path) => stat(call({ op: 'fs', method: 'lstat', args: [path] }), 'lstat'),
  realpath: (path) => text(call({ op: 'fs', method: 'realpath', args: [path] }), 'realpath'),
  mkdir: (path, options) => { call({ op: 'fs', method: 'mkdir', args: [path, options] }); },
  readdir: (path) => {
    const entries = call({ op: 'fs', method: 'readdir', args: [path] });
    return isDirEntries(entries) ? entries : malformed('readdir');
  },
  unlink: (path) => { call({ op: 'fs', method: 'unlink', args: [path] }); },
  rmdir: (path) => { call({ op: 'fs', method: 'rmdir', args: [path] }); },
  rmdirRecursive: (path) => { call({ op: 'fs', method: 'rmdirRecursive', args: [path] }); },
  rename: (from, to) => { call({ op: 'fs', method: 'rename', args: [from, to] }); },
  copyFile: (from, to) => { call({ op: 'fs', method: 'copyFile', args: [from, to] }); },
  chmod: (path, mode) => { call({ op: 'fs', method: 'chmod', args: [path, mode] }); },
  chown: (path, uid, gid, follow) => { call({ op: 'fs', method: 'chown', args: [path, uid, gid, follow] }); },
  open: (path, flags) => count(call({ op: 'fs', method: 'open', args: [path, flags] }), 'open'),
  read: (fd, position, length) => bytes(call({ op: 'fs', method: 'read', args: [fd, position, length] }), 'read'),
  write: (fd, position, data) => count(call({ op: 'fs', method: 'write', args: [fd, position, data] }), 'write'),
  fstat: (fd) => stat(call({ op: 'fs', method: 'fstat', args: [fd] }), 'fstat'),
  fchown: (fd, uid, gid) => { call({ op: 'fs', method: 'fchown', args: [fd, uid, gid] }); },
  ftruncate: (fd, size) => { call({ op: 'fs', method: 'ftruncate', args: [fd, size] }); },
  fsync: (fd) => { call({ op: 'fs', method: 'fsync', args: [fd] }); },
  close: (fd) => { call({ op: 'fs', method: 'close', args: [fd] }); },
  watch: (path, listener, options) => {
    const id = nextWatch++;
    const watch = { listener, persistent: options?.persistent !== false };
    call({ op: 'watch', id, path });
    watches.set(id, watch);
    if (watch.persistent) persistentWatches++;
    holdWhileBusy();
    return {
      close() {
        if (!watches.delete(id)) return;
        if (watch.persistent) persistentWatches--;
        call({ op: 'watch', id, path: null });
        holdWhileBusy();
      },
      ref() {
        if (!watches.has(id) || watch.persistent) return;
        watch.persistent = true;
        persistentWatches++;
        holdWhileBusy();
      },
      unref() {
        if (!watches.has(id) || !watch.persistent) return;
        watch.persistent = false;
        persistentWatches--;
        holdWhileBusy();
      },
    };
  },
};

/**
 * The program's output `fd`, as its stream (process.stdout, process.stderr)
 * and its console write it: each write crosses to the host, which makes it
 * later. One the host could not make is told to the stream (FailableOutput),
 * with what made it.
 */
function realmOutput(fd: 1 | 2): { readonly stream: FailableOutput; readonly console: CommandOutputStream; fail(error: Error, source: OutputSource, writer: number): void } {
  // Each writer of the descriptor hears its own writes' failures, and its end waits for its own writes (its last
  // one's number): 0 is process.stdout or process.stderr, and its console.
  const listeners = new Map<number, ((error: Error, source: OutputSource) => void)[]>();
  const lastWrites = new Map<number, number>();
  let writers = 0;
  const through = (source: OutputSource, writer: number): CommandOutputStream => ({
    write: (data: string) => { lastWrites.set(writer, postOutput(fd, source, writer, data)); },
    writeBytes: (data: Uint8Array) => { lastWrites.set(writer, postOutput(fd, source, writer, data)); },
  });
  const streamOf = (writer: number): FailableOutput => ({
    ...through('stream', writer),
    onFailure: (listener) => {
      listeners.set(writer, [...listeners.get(writer) ?? [], listener]);
      return () => {
        const rest = (listeners.get(writer) ?? []).filter((heard) => heard !== listener);
        if (rest.length > 0) { listeners.set(writer, rest); return; }
        // A writer no one hears any more: its writes' failures are no one's, as a destroyed stream's are in Node.
        listeners.delete(writer);
        lastWrites.delete(writer);
        post({ type: 'heard', fd, writer });
      };
    },
    another: () => streamOf(++writers),
    settled: () => outputSettled(lastWrites.get(writer) ?? 0),
  });
  return {
    stream: streamOf(0),
    console: through('console', 0),
    fail(error, source, writer) {
      for (const listener of listeners.get(writer) ?? []) listener(error, source);
    },
  };
}
/** Output writes posted, and the last the host has settled (made, or failed). */
let postedOutput = 0;
let settledOutput = 0;
/** Whether the guest waits for the host to settle its writes (settle): the realm is held meanwhile. */
let settling = false;
/** What waits for writes up to a number to be settled, and the number the request outstanding names. */
const settleWaits: { readonly upTo: number; resolve(): void }[] = [];
let askedUpTo = 0;
/** Once the host settled writes up to number `upTo`, a failure told first: asked of it, holding the realm meanwhile. */
function outputSettled(upTo: number): Promise<void> {
  if (settledOutput >= upTo) return Promise.resolve();
  return new Promise((resolve) => {
    settleWaits.push({ upTo, resolve });
    askSettle();
  });
}
/** Ask the host for the nearest number a wait needs: a request outstanding for a later one is lowered, so that no wait waits on writes after its own. */
function askSettle(): void {
  const upTo = settleWaits.reduce((nearest, wait) => Math.min(nearest, wait.upTo), Infinity);
  if (settling && askedUpTo <= upTo) return;
  settling = true;
  askedUpTo = upTo;
  post({ type: 'settle', upTo });
  holdWhileBusy();
}
/**
 * Writes after number `after`, up to the last posted, made before this
 * returns, as Node makes a write to a pipe or a file when it is written: the
 * host answers once they are made, with those that failed (told only so, no
 * event of them coming), each then told to what wrote it.
 */
function settleNow(after: number): void {
  const upTo = postedOutput;
  const failures = call({ op: 'settle', after, upTo });
  if (!isOutputFailures(failures)) malformed('settle');
  for (const failure of failures) taken(failure);
  if (upTo > settledOutput) settledOutput = upTo;
  const waiting = settleWaits.splice(0);
  for (const wait of waiting) {
    if (wait.upTo <= settledOutput) wait.resolve();
    else settleWaits.push(wait);
  }
}
/** A failed write, told to what wrote it: a stream's is heard here, whatever the program makes of it, and the host reports it no more. */
function taken(failure: OutputFailure): void {
  if (failure.source === 'stream') post({ type: 'heard', fd: failure.fd, writer: failure.writer });
  outputs[failure.fd].fail(writeFailure(failure.code, failure.pipe), failure.source, failure.writer);
}
/** Its number. */
function postOutput(fd: 1 | 2, source: OutputSource, writer: number, data: string | Uint8Array): number {
  post({ type: 'output', fd, source, writer, data });
  return ++postedOutput;
}
const outputs = { 1: realmOutput(1), 2: realmOutput(2) };

/** fd 0, a piece at a time, each read asked of the host and answered once; the readers waiting on it hold the realm. */
const stdinAnswers = new Map<number, { resolve(piece: StandardPiece): void; reject(error: Error): void }>();
let stdinReads = 0;
let stdinHolds = 0;
const input: StandardInput = {
  read: () => {
    const id = ++stdinReads;
    const piece = new Promise<StandardPiece>((resolve, reject) => { stdinAnswers.set(id, { resolve, reject }); });
    post({ type: 'stdin-read', id });
    return { piece, cancel: () => { if (stdinAnswers.has(id)) post({ type: 'stdin-cancel', id }); } };
  },
  hold: (on) => {
    stdinHolds += on ? 1 : -1;
    holdWhileBusy();
  },
};

/** What a standard descriptor is, asked of the host once. */
const fdKinds = new Map<number, FdKind>();
const fdKind = (fd: number): FdKind => {
  let kind = fdKinds.get(fd);
  if (kind === undefined) {
    const answer = call({ op: 'fdKind', fd });
    kind = answer === 'terminal' || answer === 'pipe' || answer === 'other' ? answer : malformed('fdKind');
    fdKinds.set(fd, kind);
  }
  return kind;
};
const terminal: ProgramTerminal = {
  isatty: (fd) => fdKind(fd) === 'terminal',
  isPipe: (fd) => fdKind(fd) === 'pipe',
  setRawMode: (on) => { call({ op: 'rawMode', on }); },
};

/** The program's servers, as the session reaches them: listening is the host's to record, and holds the realm. */
class RealmPorts extends Map<number, VirtualRequestHandler> {
  override set(port: number, handler: VirtualRequestHandler): this {
    call({ op: 'listen', port });
    super.set(port, handler);
    holdWhileBusy();
    return this;
  }
  override delete(port: number): boolean {
    if (super.has(port)) call({ op: 'unlisten', port });
    const deleted = super.delete(port);
    holdWhileBusy();
    return deleted;
  }
}
const ports = new RealmPorts();

let fetches = 0;

async function routeLoopback(port: number, request: Request): Promise<Response | null> {
  const id = ++fetches;
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => { headers[key] = value; });
  const body = request.body ? await request.text() : null;
  const answer = new Promise<RealmResponse | null>((resolve) => fetched.set(id, resolve));
  holdWhileBusy();
  post({ type: 'fetch', id, port, url: request.url, method: request.method, headers, body });
  const response = await answer;
  if (!response) return null;
  const empty = response.status === 204 || response.status === 304;
  return new Response(empty ? null : response.body, { status: response.status, headers: response.headers });
}

/** A request the host forwards to one of the program's servers. */
async function serve(id: number, port: number, request: VirtualRequest): Promise<void> {
  const handler = ports.get(port);
  if (!handler) {
    post({ type: 'served', id, response: null });
    return;
  }
  const response: VirtualResponse = { statusCode: 200, headers: {}, body: '' };
  try {
    handler(request, response);
    if (response._donePromise) await response._donePromise;
    post({ type: 'served', id, response: { status: response.statusCode, headers: response.headers, body: response.body } });
  } catch {
    post({ type: 'served', id, response: null });
  }
}

events.on('message', (event) => {
  if (isEgressHostEvent(event)) { offTheBox?.answer(event); return; }
  if (!isHostEvent(event)) return;
  switch (event.type) {
    case 'fetched':
      fetched.get(event.id)?.(event.response);
      fetched.delete(event.id);
      holdWhileBusy();
      return;
    case 'serve':
      void serve(event.id, event.port, event.request);
      return;
    case 'changed':
      watches.get(event.id)?.listener(event.event);
      return;
    case 'stdin': {
      const answer = stdinAnswers.get(event.id);
      stdinAnswers.delete(event.id);
      if ('error' in event) answer?.reject(fromRealmError(event.error));
      else answer?.resolve('withdrawn' in event ? 'withdrawn' : event.data);
      return;
    }
    case 'output-failed':
      taken(event);
      return;
    case 'output-settled': {
      settledOutput = event.seq;
      settling = false;
      const waiting = settleWaits.splice(0);
      for (const wait of waiting) {
        if (wait.upTo <= settledOutput) wait.resolve();
        else settleWaits.push(wait);
      }
      if (settleWaits.length > 0) askSettle();
      holdWhileBusy();
      return;
    }
  }
});

// ── Fatal errors, as Node ends a process on them ───────────────────────────

const fatal = (reason: unknown): never => {
  if (reason instanceof ProcessExitError) return exitNow(reason.exitCode);
  postOutput(2, 'console', 0, `${uncaughtReport(reason, (value) => realm.getBuiltinModule('node:util').inspect(value))}\n`);
  return exitNow(1);
};

/** An error nothing caught is the program's process's first (LifoProcess.takeUncaught); one it does not take ends it. */
const uncaught = (origin: 'uncaughtException' | 'unhandledRejection') => (reason: unknown, promise?: Promise<unknown>): void => {
  if (reason instanceof ProcessExitError || programProcess === null) {
    fatal(reason);
    return;
  }
  try {
    if (origin === 'unhandledRejection' && programProcess.emit('unhandledRejection', reason, promise)) return;
    if (programProcess.takeUncaught(reason, origin)) return;
  } catch (thrown) {
    fatal(thrown);
  }
  fatal(reason);
};
realm.on('unhandledRejection', uncaught('unhandledRejection'));
realm.on('uncaughtException', uncaught('uncaughtException'));
// The loop ran empty: a program that would hear of a failed write
// (LifoProcess.hearsWriteFailures), whenever it began to listen, waits for its
// writes, as a Node process's are made before it ends. What it hears may run
// more of it, and the loop runs empty again. Once nothing it would hear of is
// outstanding, its process hears 'beforeExit', as Node's does each time its
// loop runs empty (a top-level await unsettled too); the writes its
// listeners make are made before the loop is asked again, so that only work
// they scheduled runs it again, as in Node.
realm.on('beforeExit', () => {
  if (programProcess === null) return;
  if (settledOutput < postedOutput && programProcess.hearsWriteFailures()) {
    void outputSettled(postedOutput);
    return;
  }
  const after = postedOutput;
  post({ type: 'settle-mark', after });
  try {
    programProcess.emitBeforeExit();
  } finally {
    settleNow(after);
  }
});
// The loop ran empty with the main script still waiting: an ES module whose
// top-level await never settled.
// The program's status once its loop runs empty: its process.exitCode then
// (set after main ran), told only when it is not the one main ended with.
let finalCode = (): number => 0;
let mainCode = 0;
realm.on('exit', () => {
  if (exiting) return;
  if (mainDone) {
    const code = tellExit(finalCode(), false);
    if (code !== mainCode) post({ type: 'exit', code, ended: false });
    return;
  }
  postOutput(2, 'console', 0, `Warning: Detected unsettled top-level await at ${program.filename}\n`);
  post({ type: 'exit', code: tellExit(13, true), ended: false });
});

if (egress) {
  offTheBox = routeFetchThroughHost(post, holdWhileBusy);
}
holdWhileBusy();
const end = await runNodeProgram(program, {
  filesystem: () => filesystem,
  stdout: outputs[1].console,
  stderr: outputs[2].console,
  stdoutStream: outputs[1].stream,
  stderrStream: outputs[2].stream,
  stdin: () => bytes(call({ op: 'stdin' }), 'stdin'),
  input,
  terminal,
  setUmask: (mask) => { call({ op: 'umask', mask }); },
  started: (process) => { programProcess = process; },
  portRegistry: ports,
  routeLoopback,
  dns,
});
if (end.ended) exitNow(end.code);
post({ type: 'exit', code: end.code, ended: false });
mainCode = end.code;
finalCode = end.finalCode;
mainDone = true;
