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
import type { FailableOutput } from '../../node-compat/standard-streams.js';
import { uncaughtReport, writeFailure } from '../../node-compat/output-failure.js';
import type { LifoProcess } from '../../node-compat/process.js';
import { ProcessExitError } from '../../node-compat/index.js';
import { runNodeProgram } from './node.js';
import { routeFetchThroughHost, type RealmEgressGuest } from '../../../../runtime/realm-egress-guest.js';
import { isEgressHostEvent } from '../../../../runtime/realm-egress.js';
import {
  isDirEntries, isHostEvent, isNodeRealmPayload, isOutputFailures, isStat,
  type GuestEvent, type NodeCall, type RealmResponse,
} from './node-realm.js';

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
  joined.hold(fetched.size > 0 || ports.size > 0 || persistentWatches > 0 || (offTheBox?.awaited ?? 0) > 0 || (mainDone && settledOutput < postedOutput && hears()));
}

/** End the process now with `code`, as process.exit() and a fatal error do: a write that fails later is no one's. */
function exitNow(code: number): never {
  exiting = true;
  post({ type: 'exit', code, ended: true });
  return realm.exit(code);
}

/** The program's process, once runNodeProgram has made it. */
let programProcess: LifoProcess | null = null;
/** Whether a failed write would reach anything of the program's (LifoProcess.hearsWriteFailures). */
const hears = (): boolean => programProcess?.hearsWriteFailures() ?? false;

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
  open: (path, flags) => count(call({ op: 'fs', method: 'open', args: [path, flags] }), 'open'),
  read: (fd, position, length) => bytes(call({ op: 'fs', method: 'read', args: [fd, position, length] }), 'read'),
  write: (fd, position, data) => count(call({ op: 'fs', method: 'write', args: [fd, position, data] }), 'write'),
  fstat: (fd) => stat(call({ op: 'fs', method: 'fstat', args: [fd] }), 'fstat'),
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
 * The program's output `fd`: its writes cross to the host, which makes them
 * later. One the host could not make fails the output (failOutput): the
 * program's stream of it errors, as Node's does, and later writes go nowhere
 * (a console write's failure is ignored, as Node ignores it).
 */
function realmOutput(fd: 1 | 2): FailableOutput & { fail(error: Error): void } {
  let failure: Error | null = null;
  const listeners: ((error: Error) => void)[] = [];
  const send = (data: string | Uint8Array) => {
    if (failure !== null) return;
    postOutput(fd, data);
    // Once its code has run, a program that would hear a failed write waits
    // for its writes (holdWhileBusy), asking once, for the first unsettled;
    // one that would not ends as it would, and the host reports a failure.
    if (mainDone && postedOutput === settledOutput + 1 && hears()) {
      post({ type: 'settle' });
      holdWhileBusy();
    }
  };
  return {
    write: (data: string) => send(data),
    writeBytes: (data: Uint8Array) => send(data),
    // The program's stream of it: a failure ends the program unless it is heard. The host is told, once.
    onFailure: (listener) => {
      if (failure !== null) {
        listener(failure);
        return;
      }
      if (listeners.length === 0) post({ type: 'stream', fd });
      listeners.push(listener);
    },
    fail(error) {
      if (failure !== null) return;
      failure = error;
      for (const listener of listeners.splice(0)) listener(error);
    },
  };
}
/** Output writes posted, and the last the host has settled (made, or failed): the realm is held while any is not. */
let postedOutput = 0;
let settledOutput = 0;
/** An output write to the host, counted as the host counts them. */
function postOutput(fd: 1 | 2, data: string | Uint8Array): void {
  post({ type: 'output', fd, data });
  postedOutput++;
}
const outputs = { 1: realmOutput(1), 2: realmOutput(2) };

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
    case 'output-failed':
      // Heard here, whatever the program makes of it: the host reports it no more.
      post({ type: 'heard', fd: event.fd });
      outputs[event.fd].fail(writeFailure(event.code, event.pipe));
      return;
    case 'output-settled':
      settledOutput = event.seq;
      holdWhileBusy();
      return;
  }
});

// ── Fatal errors, as Node ends a process on them ───────────────────────────

const fatal = (reason: unknown): never => {
  if (reason instanceof ProcessExitError) return exitNow(reason.exitCode);
  postOutput(2, `${uncaughtReport(reason, (value) => realm.getBuiltinModule('node:util').inspect(value))}\n`);
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
// The loop ran empty with the main script still waiting: an ES module whose
// top-level await never settled.
// The program's status once its loop runs empty: its process.exitCode then
// (set after main ran), told only when it is not the one main ended with.
let finalCode = (): number => 0;
let mainCode = 0;
realm.on('exit', () => {
  if (exiting) return;
  if (mainDone) {
    const code = finalCode();
    if (code !== mainCode) post({ type: 'exit', code, ended: false });
    return;
  }
  postOutput(2, `Warning: Detected unsettled top-level await at ${program.filename}\n`);
  post({ type: 'exit', code: 13, ended: false });
});

if (egress) {
  offTheBox = routeFetchThroughHost(post, holdWhileBusy);
}
holdWhileBusy();
const end = await runNodeProgram(program, {
  filesystem: () => filesystem,
  stdout: outputs[1],
  stderr: outputs[2],
  stdin: () => bytes(call({ op: 'stdin' }), 'stdin'),
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
// The program's code has run: one that would hear of a write that failed
// hears it before it ends, as a Node process's pending writes hold it (one
// call waits for them all). One that would not is not held: the host reports
// a failure as the error that would have ended it.
if (postedOutput > 0 && hears()) {
  const failures = call({ op: 'flush', upTo: postedOutput });
  if (!isOutputFailures(failures)) malformed('flush');
  for (const failure of failures) outputs[failure.fd].fail(writeFailure(failure.code, failure.pipe));
  settledOutput = postedOutput;
}
mainDone = true;
holdWhileBusy();
