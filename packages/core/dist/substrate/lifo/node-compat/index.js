import { createFs } from './fs.js';
import pathModule from './path.js';
import { createOs } from './os.js';
import { createProcess } from './process.js';
import { EventEmitter } from './events.js';
import { Buffer } from './buffer.js';
import * as utilModule from './util.js';
import { createHttp } from './http.js';
import { createChildProcess } from './child_process.js';
import * as streamModule from './stream.js';
import * as urlModule from './url.js';
import * as timersModule from './timers.js';
import * as cryptoModule from './crypto.js';
import * as zlibModule from './zlib.js';
import * as stringDecoderModule from './string_decoder.js';
import * as ttyModule from './tty.js';
import * as dnsModule from './dns.js';
import { createModuleShim } from './module.js';
import * as readlineModule from './readline.js';
import { createRimraf } from './rimraf.js';
import { createEsbuild } from './esbuild.js';
export function createModuleMap(ctx) {
    const map = {
        fs: () => createFs(ctx.vfs, ctx.cwd),
        'fs/promises': () => createFs(ctx.vfs, ctx.cwd).promises,
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
            const mod = EventEmitter;
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
            const Stream = EventEmitter;
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
        dns: () => dnsModule,
        'dns/promises': () => dnsModule.promises,
        readline: () => readlineModule,
        'readline/promises': () => readlineModule.promises,
        constants: () => {
            const fs = createFs(ctx.vfs, ctx.cwd);
            const os = createOs(ctx.env);
            return { ...os.constants, ...fs.constants };
        },
        querystring: () => ({
            parse: (str) => {
                const out = {};
                new URLSearchParams(str).forEach((value, key) => {
                    out[key] = value;
                });
                return out;
            },
            stringify: (obj) => new URLSearchParams(obj).toString(),
            escape: encodeURIComponent,
            unescape: decodeURIComponent,
        }),
        assert: () => {
            const assert = (value, message) => {
                if (!value)
                    throw new Error(message || 'AssertionError');
            };
            assert.ok = assert;
            assert.equal = (a, b, msg) => { if (a != b)
                throw new Error(msg || `${a} != ${b}`); };
            assert.strictEqual = (a, b, msg) => { if (a !== b)
                throw new Error(msg || `${a} !== ${b}`); };
            assert.notEqual = (a, b, msg) => { if (a == b)
                throw new Error(msg || `${a} == ${b}`); };
            assert.notStrictEqual = (a, b, msg) => { if (a === b)
                throw new Error(msg || `${a} === ${b}`); };
            assert.deepStrictEqual = (a, b, msg) => {
                if (JSON.stringify(a) !== JSON.stringify(b))
                    throw new Error(msg || 'deepStrictEqual failed');
            };
            assert.throws = (fn, msg) => {
                try {
                    fn();
                    throw new Error(msg || 'Expected function to throw');
                }
                catch (e) {
                    if (e instanceof Error && e.message === (msg || 'Expected function to throw'))
                        throw e;
                }
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
            serialize: (v) => new Uint8Array(0),
            deserialize: () => undefined,
        }),
        // perf_hooks — vite uses { performance } which is a browser global
        perf_hooks: () => ({
            performance,
            PerformanceObserver: typeof PerformanceObserver === 'undefined'
                ? class PerformanceObserver {
                    observe() { }
                    disconnect() { }
                }
                : PerformanceObserver,
        }),
        // net — stub (vite imports it but only uses it for actual TCP in server mode)
        net: () => ({
            createServer: () => {
                const s = new EventEmitter();
                s.listen = (_port, _host, cb) => { cb?.(); return s; };
                s.close = (cb) => { cb?.(); return s; };
                s.address = () => ({ port: 0, family: 'IPv4', address: '127.0.0.1' });
                s.unref = () => s;
                s.ref = () => s;
                return s;
            },
            createConnection: () => {
                const s = new EventEmitter();
                s.write = () => true;
                s.end = () => s;
                s.destroy = () => s;
                s.connect = () => s;
                s.unref = () => s;
                s.ref = () => s;
                s.setTimeout = () => s;
                s.setNoDelay = () => s;
                s.setKeepAlive = () => s;
                return s;
            },
            connect: (...args) => {
                const s = new EventEmitter();
                s.write = () => true;
                s.end = () => s;
                s.destroy = () => s;
                s.unref = () => s;
                s.ref = () => s;
                s.setTimeout = () => s;
                s.setNoDelay = () => s;
                s.setKeepAlive = () => s;
                // call connection callback if provided
                const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
                if (cb)
                    queueMicrotask(cb);
                return s;
            },
            Socket: class Socket extends EventEmitter {
                write() { return true; }
                end() { return this; }
                destroy() { return this; }
                connect() { return this; }
                unref() { return this; }
                ref() { return this; }
                setTimeout() { return this; }
                setNoDelay() { return this; }
                setKeepAlive() { return this; }
            },
            Server: class Server extends EventEmitter {
                listen(_port, _host, cb) { cb?.(); return this; }
                close(cb) { cb?.(); return this; }
                address() { return { port: 0, family: 'IPv4', address: '127.0.0.1' }; }
                unref() { return this; }
                ref() { return this; }
            },
            isIP: (s) => /^\d+\.\d+\.\d+\.\d+$/.test(s) ? 4 : /^[0-9a-f:]+$/i.test(s) ? 6 : 0,
            isIPv4: (s) => /^\d+\.\d+\.\d+\.\d+$/.test(s),
            isIPv6: (s) => /^[0-9a-f:]+$/i.test(s),
        }),
        // tls — stub
        tls: () => ({
            createServer: () => {
                const s = new EventEmitter();
                s.listen = (_port, _host, cb) => { cb?.(); return s; };
                s.close = (cb) => { cb?.(); return s; };
                s.address = () => ({ port: 0, family: 'IPv4', address: '127.0.0.1' });
                return s;
            },
            connect: () => {
                const s = new EventEmitter();
                s.write = () => true;
                s.end = () => s;
                s.destroy = () => s;
                s.encrypted = true;
                return s;
            },
            TLSSocket: class TLSSocket extends EventEmitter {
            },
            SERVER_METHODS: [],
        }),
        // worker_threads — stub (vite uses it for thread pool but can fall back)
        worker_threads: () => ({
            isMainThread: true,
            parentPort: null,
            workerData: null,
            Worker: class Worker extends EventEmitter {
                constructor() { super(); }
                postMessage() { }
                terminate() { return Promise.resolve(0); }
            },
            threadId: 0,
        }),
        // http2 — stub (vite imports it for HTTP/2 server but falls back to HTTP/1.1)
        http2: () => ({
            createServer: () => {
                const s = new EventEmitter();
                s.listen = (_port, _host, cb) => { cb?.(); return s; };
                s.close = (cb) => { cb?.(); return s; };
                s.setTimeout = () => s;
                return s;
            },
            createSecureServer: () => {
                const s = new EventEmitter();
                s.listen = (_port, _host, cb) => { cb?.(); return s; };
                s.close = (cb) => { cb?.(); return s; };
                s.setTimeout = () => s;
                return s;
            },
            connect: () => {
                const s = new EventEmitter();
                s.close = () => { };
                s.destroy = () => { };
                return s;
            },
            constants: {
                HTTP2_HEADER_PATH: ':path',
                HTTP2_HEADER_METHOD: ':method',
                HTTP2_HEADER_STATUS: ':status',
                HTTP2_HEADER_CONTENT_TYPE: 'content-type',
                HTTP_STATUS_OK: 200,
                HTTP_STATUS_INTERNAL_SERVER_ERROR: 500,
            },
            sensitiveHeaders: Symbol('nodejs.http2.sensitiveHeaders'),
            getDefaultSettings: () => ({}),
            getPackedSettings: () => Buffer.alloc(0),
            getUnpackedSettings: () => ({}),
        }),
        // inspector — stub (vite only uses it in --profile mode)
        inspector: () => ({
            Session: class Session extends EventEmitter {
                connect() { }
                disconnect() { }
                post(_method, _params, cb) {
                    if (typeof _params === 'function') {
                        _params();
                        return;
                    }
                    cb?.();
                }
            },
            open: () => { },
            close: () => { },
            url: () => undefined,
        }),
    };
    // module shim needs access to the map itself for createRequire
    map.module = () => createModuleShim(map);
    // npm package shims
    map.rimraf = () => createRimraf(ctx.vfs, ctx.cwd);
    map.esbuild = () => createEsbuild();
    return map;
}
export { ProcessExitError } from './process.js';
