import { Buffer } from 'node:buffer';
import realm from 'node:process';
import { createFs } from './fs.js';
import { createPath, createUrl } from './cwd-relative.js';
import { createOs } from './os.js';
import { createProcess } from './process.js';
import { EventEmitter } from 'node:events';
import { createHttp } from './http.js';
import { createChildProcess } from './child_process.js';
import * as zlibModule from './zlib.js';
import { ttyOf } from './tty-streams.js';
import { createDns } from './dns.js';
import { createModuleShim } from './module.js';
import { createRimraf } from './rimraf.js';
import { createEsbuild } from './esbuild.js';
import { createVm } from './vm.js';
import { createHttp2Module } from '../../../_shared/http2-module.js';
import { unavailable } from './unavailable.js';
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
/** The engine's `module` with each of `names` refused (unavailable). */
function withoutHostReach(module, name, names) {
    const refused = Object.fromEntries(names.map((method) => [method, () => unavailable(`${name}.${method}`)]));
    return { ...module, ...refused };
}
export function createModuleMap(ctx) {
    // One fs and one dns: fs/promises, dns/promises and constants are theirs, as Node's are.
    let fs;
    const fsModule = () => (fs ??= createFs(ctx.filesystem(), ctx.cwd, ctx.stdin, ctx.reachStreams));
    let dns;
    const dnsModule = () => (dns ??= createDns(ctx.dns));
    // One path module for every name it has (path, path/posix, path/win32).
    let path;
    const programPath = () => path ??= createPath(ctx.cwd);
    const map = {
        fs: fsModule,
        'fs/promises': () => fsModule().promises,
        path: programPath,
        'path/posix': () => programPath().posix,
        'path/win32': () => programPath().win32,
        os: () => createOs(ctx.env),
        process: () => createProcess({
            argv: ctx.argv,
            env: ctx.env,
            cwd: ctx.cwd,
            stdio: ctx.stdio,
            identity: ctx.identity,
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
        url: () => createUrl(ctx.cwd),
        crypto: () => realm.getBuiltinModule('node:crypto'),
        zlib: () => zlibModule,
        string_decoder: () => realm.getBuiltinModule('node:string_decoder'),
        tty: () => (ctx.reachStreams?.(), ttyOf(ctx.stdio).module),
        dns: dnsModule,
        'dns/promises': () => dnsModule().promises,
        // The engine's own (X-2): over process.stdin, as Node's reads its input.
        readline: () => (ctx.reachStreams?.(), realm.getBuiltinModule('node:readline')),
        'readline/promises': () => (ctx.reachStreams?.(), realm.getBuiltinModule('node:readline/promises')),
        constants: () => ({ ...createOs(ctx.env).constants, ...fsModule().constants }),
        // The engine's own, context-free (X-3). v8 is the engine's but for what
        // would reach the host's files or flags (a heap snapshot file, coverage,
        // V8 flags), each refused. vm is the engine's but for its main-context
        // loader, which imports past the program's module map (vm.ts). domain,
        // trace_events and wasi are refused whole: domain sets the engine's own
        // process (its domain and uncaught-exception capture), and trace_events
        // and wasi reach the host's files.
        assert: () => realm.getBuiltinModule('node:assert'),
        'assert/strict': () => realm.getBuiltinModule('node:assert/strict'),
        async_hooks: () => realm.getBuiltinModule('node:async_hooks'),
        diagnostics_channel: () => realm.getBuiltinModule('node:diagnostics_channel'),
        domain: () => unavailable('domain'),
        perf_hooks: () => realm.getBuiltinModule('node:perf_hooks'),
        punycode: () => realm.getBuiltinModule('node:punycode'),
        querystring: () => realm.getBuiltinModule('node:querystring'),
        sys: () => realm.getBuiltinModule('node:sys'),
        timers: () => realm.getBuiltinModule('node:timers'),
        'timers/promises': () => realm.getBuiltinModule('node:timers/promises'),
        'util/types': () => realm.getBuiltinModule('node:util/types'),
        v8: () => withoutHostReach(realm.getBuiltinModule('node:v8'), 'v8', ['writeHeapSnapshot', 'setFlagsFromString', 'setHeapSnapshotNearHeapLimit', 'takeCoverage', 'stopCoverage']),
        vm: createVm,
        trace_events: () => unavailable('trace_events'),
        wasi: () => unavailable('wasi'),
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
    // npm packages it serves itself, which are not core (PROVIDED_PACKAGES).
    const provided = {
        rimraf: () => createRimraf(ctx.filesystem(), ctx.cwd),
        esbuild: () => createEsbuild(),
    };
    Object.assign(map, provided);
    return map;
}
export { ProcessExitError } from './process.js';
