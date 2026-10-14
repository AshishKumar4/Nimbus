import { Buffer } from 'node:buffer';
import realm from 'node:process';
import { createFs } from './fs.js';
import pathModule from './path.js';
import { createOs } from './os.js';
import { createProcess } from './process.js';
import { EventEmitter } from 'node:events';
import { createHttp } from './http.js';
import { createChildProcess } from './child_process.js';
import * as urlModule from './url.js';
import * as timersModule from './timers.js';
import * as zlibModule from './zlib.js';
import { createTty } from './tty.js';
import { createDns } from './dns.js';
import { createModuleShim } from './module.js';
import * as readlineModule from './readline.js';
import { createRimraf } from './rimraf.js';
import { createEsbuild } from './esbuild.js';
import { assertEqualHolds } from './loose-equality.js';
import { createHttp2Module } from '../../../_shared/http2-module.js';
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
    encrypted = true;
}
class StubServer extends EventEmitter {
    listen(_port, _host, cb) { cb?.(); return this; }
    close(cb) { cb?.(); return this; }
    address() { return { port: 0, family: 'IPv4', address: '127.0.0.1' }; }
    unref() { return this; }
    ref() { return this; }
}
export function createModuleMap(ctx) {
    const map = {
        fs: () => createFs(ctx.filesystem(), ctx.cwd, ctx.stdin, ctx.reachStreams),
        'fs/promises': () => createFs(ctx.filesystem(), ctx.cwd, ctx.stdin, ctx.reachStreams).promises,
        path: () => pathModule,
        os: () => createOs(ctx.env),
        process: () => createProcess({
            argv: ctx.argv,
            env: ctx.env,
            cwd: ctx.cwd,
            stdout: ctx.stdout,
            stderr: ctx.stderr,
        }),
        events: () => realm.getBuiltinModule('node:events'),
        // The engine's own, as its require gives them (X-3), loaded when first
        // required. `realm` is the host's process: the program's globalThis.process
        // is lifo's.
        buffer: () => realm.getBuiltinModule('node:buffer'),
        util: () => realm.getBuiltinModule('node:util'),
        http: () => createHttp(ctx.portRegistry, 'http:', ctx.routeLoopback),
        https: () => createHttp(ctx.portRegistry, 'https:', ctx.routeLoopback),
        child_process: () => createChildProcess(ctx.executeCapture),
        stream: () => (ctx.reachStreams?.(), realm.getBuiltinModule('node:stream')),
        'stream/promises': () => (ctx.reachStreams?.(), realm.getBuiltinModule('node:stream/promises')),
        'stream/consumers': () => (ctx.reachStreams?.(), realm.getBuiltinModule('node:stream/consumers')),
        'stream/web': () => (ctx.reachStreams?.(), realm.getBuiltinModule('node:stream/web')),
        url: () => urlModule,
        timers: () => timersModule,
        crypto: () => realm.getBuiltinModule('node:crypto'),
        zlib: () => zlibModule,
        string_decoder: () => realm.getBuiltinModule('node:string_decoder'),
        tty: () => (ctx.reachStreams?.(), createTty()),
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
            assert.equal = (a, b, msg) => { if (!assertEqualHolds(a, b))
                throw new Error(msg || `${a} != ${b}`); };
            assert.strictEqual = (a, b, msg) => { if (a !== b)
                throw new Error(msg || `${a} !== ${b}`); };
            assert.notEqual = (a, b, msg) => { if (assertEqualHolds(a, b))
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
            createServer: () => new StubServer(),
            createConnection: () => new StubSocket(),
            connect: (...args) => {
                const socket = new StubSocket();
                // call connection callback if provided
                const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
                if (cb)
                    queueMicrotask(cb);
                return socket;
            },
            Socket: StubSocket,
            Server: StubServer,
            isIP: (s) => /^\d+\.\d+\.\d+\.\d+$/.test(s) ? 4 : /^[0-9a-f:]+$/i.test(s) ? 6 : 0,
            isIPv4: (s) => /^\d+\.\d+\.\d+\.\d+$/.test(s),
            isIPv6: (s) => /^[0-9a-f:]+$/i.test(s),
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
                postMessage() { }
                terminate() { return Promise.resolve(0); }
            },
            threadId: 0,
        }),
        // http2 — Node's exports; opening HTTP/2 refuses (core/_shared/http2-module.ts,
        // which the node shims embed too)
        http2: () => (ctx.reachStreams?.(), createHttp2Module({
            EventEmitter,
            Readable: realm.getBuiltinModule('node:stream').Readable,
            Stream: realm.getBuiltinModule('node:stream'),
            Buffer,
            emitWarning: (message) => { ctx.stderr.write(`Warning: ${message}\n`); },
        })),
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
    map.rimraf = () => createRimraf(ctx.filesystem(), ctx.cwd);
    map.esbuild = () => createEsbuild();
    return map;
}
export { ProcessExitError } from './process.js';
