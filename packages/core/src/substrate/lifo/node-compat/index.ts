import type { NodeFilesystem } from './filesystem.js';
import type { CommandOutputStream } from '../commands/types.js';
import { createFs } from './fs.js';
import pathModule from './path.js';
import { createOs } from './os.js';
import { createProcess } from './process.js';
import { EventEmitter } from './events.js';
import { Buffer } from './buffer.js';
import * as utilModule from './util.js';
import { createHttp } from './http.js';
import type { LoopbackRouter, VirtualRequestHandler } from '../kernel/index.js';
import type { DNSResolver } from '../kernel/dns-resolver.js';
import { createChildProcess } from './child_process.js';
import * as streamModule from './stream.js';
import * as urlModule from './url.js';
import * as timersModule from './timers.js';
import * as cryptoModule from './crypto.js';
import * as zlibModule from './zlib.js';
import * as stringDecoderModule from './string_decoder.js';
import * as ttyModule from './tty.js';
import { createDns } from './dns.js';
import { createModuleShim } from './module.js';
import * as readlineModule from './readline.js';
import { createRimraf } from './rimraf.js';
import { createEsbuild } from './esbuild.js';
import { assertEqualHolds } from './loose-equality.js';
import { createHttp2Module } from '../../../_shared/http2-module.js';

export interface NodeContext {
  filesystem: () => NodeFilesystem;
  cwd: string;
  env: Record<string, string>;
  stdout: CommandOutputStream;
  stderr: CommandOutputStream;
  argv: string[];
  filename: string;
  dirname: string;
  signal: AbortSignal;
  executeCapture?: (input: string) => Promise<string>;
  /** fd 0 to its end, blocking until stdin ends (readFileSync(0)); absent, fd 0 reads as empty. */
  stdin?: () => Uint8Array;
  portRegistry?: Map<number, VirtualRequestHandler>;
  routeLoopback?: LoopbackRouter;
  /** The kernel's resolver, which dns.lookup answers from as curl and wget do. */
  dns?: DNSResolver;
}

/**
 * The net and tls stubs: a socket that accepts writes and goes nowhere, and a
 * server that listens on nothing. Vite imports both and opens neither
 * outside server mode.
 */
class StubSocket extends EventEmitter {
  write() { return true; }
  end() { return this; }
  destroy() { return this; }
  connect() { return this; }
  unref() { return this; }
  ref() { return this; }
  setTimeout() { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
}

class StubTlsSocket extends StubSocket {
  readonly encrypted = true;
}

class StubServer extends EventEmitter {
  listen(_port?: unknown, _host?: unknown, cb?: () => void) { cb?.(); return this; }
  close(cb?: () => void) { cb?.(); return this; }
  address() { return { port: 0, family: 'IPv4', address: '127.0.0.1' }; }
  unref() { return this; }
  ref() { return this; }
}

export function createModuleMap(ctx: NodeContext): Record<string, () => unknown> {
  const map: Record<string, () => unknown> = {
    fs: () => createFs(ctx.filesystem(), ctx.cwd, ctx.stdin),
    'fs/promises': () => createFs(ctx.filesystem(), ctx.cwd, ctx.stdin).promises,
    path: () => pathModule,
    os: () => createOs(ctx.env),
    process: () => createProcess({
      argv: ctx.argv,
      env: ctx.env,
      cwd: ctx.cwd,
      stdout: ctx.stdout,
      stderr: ctx.stderr,
    }),
    events: () => {
      // Node.js CJS: require('events') returns the EventEmitter constructor itself
      const mod = EventEmitter as typeof EventEmitter & { EventEmitter: typeof EventEmitter; default: typeof EventEmitter };
      mod.EventEmitter = EventEmitter;
      mod.default = EventEmitter;
      return mod;
    },
    buffer: () => ({ Buffer }),
    util: () => utilModule,
    http: () => createHttp(ctx.portRegistry, 'http:', ctx.routeLoopback),
    https: () => createHttp(ctx.portRegistry, 'https:', ctx.routeLoopback),
    child_process: () => createChildProcess(ctx.executeCapture),
    stream: () => {
      // Node.js CJS: require('stream') returns the Stream base class with
      // .Readable, .Writable, .Duplex, .PassThrough, .Stream attached
      const Stream = EventEmitter as unknown as (typeof EventEmitter & {
        Stream: typeof EventEmitter;
        Readable: typeof streamModule.Readable;
        Writable: typeof streamModule.Writable;
        Duplex: typeof streamModule.Duplex;
        PassThrough: typeof streamModule.PassThrough;
        default: typeof EventEmitter;
      });
      Stream.Stream = Stream;
      Stream.Readable = streamModule.Readable;
      Stream.Writable = streamModule.Writable;
      Stream.Duplex = streamModule.Duplex;
      Stream.PassThrough = streamModule.PassThrough;
      Stream.default = Stream;
      return Stream;
    },
    url: () => urlModule,
    timers: () => timersModule,
    crypto: () => cryptoModule,
    zlib: () => zlibModule,
    string_decoder: () => stringDecoderModule,
    tty: () => ttyModule,
    dns: () => createDns(ctx.dns),
    'dns/promises': () => createDns(ctx.dns).promises,
    readline: () => readlineModule,
    'readline/promises': () => readlineModule.promises,
    constants: () => {
      const fs = createFs(ctx.filesystem(), ctx.cwd, ctx.stdin);
      const os = createOs(ctx.env);
      return { ...os.constants, ...fs.constants };
    },
    querystring: () => ({
      parse: (str: string) => {
        const out: Record<string, string> = {};
        new URLSearchParams(str).forEach((value, key) => {
          out[key] = value;
        });
        return out;
      },
      stringify: (obj: Record<string, string>) => new URLSearchParams(obj).toString(),
      escape: encodeURIComponent,
      unescape: decodeURIComponent,
    }),
    assert: () => {
      const assert = (value: unknown, message?: string) => {
        if (!value) throw new Error(message || 'AssertionError');
      };
      assert.ok = assert;
      assert.equal = (a: unknown, b: unknown, msg?: string) => { if (!assertEqualHolds(a, b)) throw new Error(msg || `${a} != ${b}`); };
      assert.strictEqual = (a: unknown, b: unknown, msg?: string) => { if (a !== b) throw new Error(msg || `${a} !== ${b}`); };
      assert.notEqual = (a: unknown, b: unknown, msg?: string) => { if (assertEqualHolds(a, b)) throw new Error(msg || `${a} == ${b}`); };
      assert.notStrictEqual = (a: unknown, b: unknown, msg?: string) => { if (a === b) throw new Error(msg || `${a} === ${b}`); };
      assert.deepStrictEqual = (a: unknown, b: unknown, msg?: string) => {
        if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg || 'deepStrictEqual failed');
      };
      assert.throws = (fn: () => void, msg?: string) => {
        try { fn(); throw new Error(msg || 'Expected function to throw'); } catch (e) { if (e instanceof Error && e.message === (msg || 'Expected function to throw')) throw e; }
      };
      return assert;
    },
    // v8 — stub (vite side-effect imports it)
    v8: () => ({
      getHeapStatistics: () => ({
        total_heap_size: 0, used_heap_size: 0, heap_size_limit: 0,
        total_physical_size: 0, total_available_size: 0,
        malloced_memory: 0, peak_malloced_memory: 0,
      }),
      serialize: (v: unknown) => new Uint8Array(0),
      deserialize: () => undefined,
    }),
    // perf_hooks — vite uses { performance } which is a browser global
    perf_hooks: () => ({
      performance,
      PerformanceObserver: typeof PerformanceObserver === 'undefined'
        ? class PerformanceObserver { observe() {} disconnect() {} }
        : PerformanceObserver,
    }),
    // net — stub (vite imports it but only uses it for actual TCP in server mode)
    net: () => ({
      createServer: () => new StubServer(),
      createConnection: () => new StubSocket(),
      connect: (...args: unknown[]) => {
        const socket = new StubSocket();
        // call connection callback if provided
        const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] as () => void : null;
        if (cb) queueMicrotask(cb);
        return socket;
      },
      Socket: StubSocket,
      Server: StubServer,
      isIP: (s: string) => /^\d+\.\d+\.\d+\.\d+$/.test(s) ? 4 : /^[0-9a-f:]+$/i.test(s) ? 6 : 0,
      isIPv4: (s: string) => /^\d+\.\d+\.\d+\.\d+$/.test(s),
      isIPv6: (s: string) => /^[0-9a-f:]+$/i.test(s),
    }),
    // tls — stub
    tls: () => ({
      createServer: () => new StubServer(),
      connect: () => new StubTlsSocket(),
      TLSSocket: StubTlsSocket,
      SERVER_METHODS: [],
    }),
    // worker_threads — stub (vite uses it for thread pool but can fall back)
    worker_threads: () => ({
      isMainThread: true,
      parentPort: null,
      workerData: null,
      Worker: class Worker extends EventEmitter {
        constructor() { super(); }
        postMessage() {}
        terminate() { return Promise.resolve(0); }
      },
      threadId: 0,
    }),
    // http2 — Node's exports; opening HTTP/2 refuses (core/_shared/http2-module.ts,
    // which the node shims embed too)
    http2: () => createHttp2Module({
      EventEmitter,
      Readable: streamModule.Readable,
      // This stream module has no legacy Stream base; its streams are EventEmitters.
      Stream: EventEmitter,
      Buffer,
      emitWarning: (message) => { ctx.stderr.write(`Warning: ${message}\n`); },
    }),
    // inspector — stub (vite only uses it in --profile mode)
    inspector: () => ({
      Session: class Session extends EventEmitter {
        connect() {}
        disconnect() {}
        post(_method: string, _params?: unknown, cb?: () => void) {
          if (typeof _params === 'function') { _params(); return; }
          cb?.();
        }
      },
      open: () => {},
      close: () => {},
      url: () => undefined,
    }),
  };

  // module shim needs access to the map itself for createRequire
  map.module = () => createModuleShim(map);

  // npm package shims
  map.rimraf = () => createRimraf(ctx.filesystem(), ctx.cwd);
  map.esbuild = () => createEsbuild();

  return map;
}

export { ProcessExitError } from './process.js';
