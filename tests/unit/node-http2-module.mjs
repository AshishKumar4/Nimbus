#!/usr/bin/env bun
// node:http2 against real Node: the same program under `node` and in a
// Nimbus process (a one-shot, through the real shims artifact), and the
// substrate's node-compat module, which builds the module from the same source
// (core/_shared/http2-module.ts).
//
// It compares the export names and their types and lengths, the constants,
// the default settings, what instanceof answers for HTTP/1 objects and for the
// classes' own prototypes, and getPackedSettings / getUnpackedSettings over
// valid and invalid input (bytes, round trips, and each error's class, code,
// message and fields). Astro's dev server asks `res instanceof
// Http2ServerResponse` of every response; Nimbus's module had no such class.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { createModuleMap } from '../../packages/core/src/substrate/lifo/node-compat/index.ts';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { processFiles } from './lib/process-bridge.mjs';
import { createAuthority } from './lib/resident-body.mjs';
import { writeModuleSet } from './lib/module-map-bundle.mjs';

/** The report, as source: the same text runs under each runtime. */
const REPORT = String.raw`
function http2Report(http2, stream, http) {
  const outcome = (run) => {
    try {
      const value = run();
      if (value === undefined) return { value: null };
      if (ArrayBuffer.isView(value)) return { bytes: Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('') };
      return { value };
    } catch (error) {
      return { name: error.name, code: error.code, message: error.message, actual: error.actual, min: error.min, max: error.max };
    }
  };
  const bytes = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
  const names = Object.keys(http2).sort();
  const settings = [
    undefined, {}, { headerTableSize: 100 },
    { headerTableSize: 100, enablePush: false, initialWindowSize: 1, maxFrameSize: 16384, maxConcurrentStreams: 7, maxHeaderListSize: 9, enableConnectProtocol: true },
    { maxHeaderSize: 5 }, { maxHeaderSize: 7, maxHeaderListSize: 9 }, { maxHeaderSize: 9, maxHeaderListSize: 9 },
    { customSettings: { 10: 5 } }, { customSettings: { 200: 8, 100: 7 }, headerTableSize: 1 }, { customSettings: { 2: 5 } },
    { customSettings: { 2: 5 }, initialWindowSize: 9 }, { customSettings: { 9: 1 } }, { customSettings: { 9: 7 } },
    { customSettings: { 12: 0 } }, { customSettings: { 12: '5' } }, { customSettings: [1] }, { customSettings: 5 },
    { customSettings: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i + 20, 1])) },
    { headerTableSize: -1 }, { headerTableSize: 2 ** 32 }, { headerTableSize: 'x' }, { enablePush: 1 },
    { enableConnectProtocol: 'yes' }, { maxFrameSize: 100 }, { maxFrameSize: 2 ** 24 }, { initialWindowSize: 2 ** 31 },
    { maxConcurrentStreams: 2 ** 32 - 1 }, { headerTableSize: '5' },
    null, [], 5, 'x',
  ];
  const packed = settings.map((s) => outcome(() => http2.getPackedSettings(s)));
  const roundTrip = settings.map((s) => outcome(() => http2.getUnpackedSettings(http2.getPackedSettings(s))));
  const frames = ['', '000100000064', '0001000000640007000000050010ffffffff', '000200000002', '000500000001', '000600000009',
    '000800000000', '0005000000010003ffffffff', '0000000000000000ffff00000003'];
  const unpacked = [
    ...frames.map((hex) => outcome(() => http2.getUnpackedSettings(bytes(hex)))),
    ...frames.map((hex) => outcome(() => http2.getUnpackedSettings(bytes(hex), { validate: true }))),
    outcome(() => http2.getUnpackedSettings(bytes('0001000000'))),
    outcome(() => http2.getUnpackedSettings(new DataView(new ArrayBuffer(6)))),
    outcome(() => http2.getUnpackedSettings(null)),
    outcome(() => http2.getUnpackedSettings('a'.repeat(40))),
    outcome(() => http2.getUnpackedSettings(bytes('000100000064'), null)),
  ];
  const defaults = http2.getDefaultSettings();
  return {
    names,
    types: Object.fromEntries(names.map((name) => [name, typeof http2[name]])),
    lengths: Object.fromEntries(names.filter((name) => typeof http2[name] === 'function').map((name) => [name, http2[name].length])),
    sensitiveHeaders: http2.sensitiveHeaders.description,
    constants: http2.constants,
    defaults: { entries: Object.entries(defaults), nullPrototype: Object.getPrototypeOf(defaults) === null },
    instanceOf: {
      plainObject: ({}) instanceof http2.Http2ServerResponse,
      ownRequest: Object.create(http2.Http2ServerRequest.prototype) instanceof http2.Http2ServerRequest,
      ownResponse: Object.create(http2.Http2ServerResponse.prototype) instanceof http2.Http2ServerResponse,
      ...(http ? {
        http1Request: Object.create(http.IncomingMessage.prototype) instanceof http2.Http2ServerRequest,
        http1Response: Object.create(http.ServerResponse.prototype) instanceof http2.Http2ServerResponse,
      } : {}),
      ...(stream && stream.Stream ? {
        requestIsReadable: http2.Http2ServerRequest.prototype instanceof stream.Readable,
        responseIsStream: http2.Http2ServerResponse.prototype instanceof stream.Stream,
      } : {}),
    },
    packed,
    roundTrip,
    unpacked,
  };
}`;
const PROGRAM = `${REPORT}
console.log("HTTP2 " + JSON.stringify(http2Report(require("http2"), require("stream"), require("http"))));
`;
const parse = (out) => JSON.parse(out.split('\n').find((line) => line.startsWith('HTTP2 ')).slice('HTTP2 '.length));

// Real Node.
const node = spawnSync('node', ['-e', PROGRAM], { encoding: 'utf8' });
assert.equal(node.status, 0, node.stderr);
const expected = parse(node.stdout);
assert.deepEqual(expected.names, ['Http2ServerRequest', 'Http2ServerResponse', 'connect', 'constants', 'createSecureServer',
  'createServer', 'getDefaultSettings', 'getPackedSettings', 'getUnpackedSettings', 'performServerHandshake', 'sensitiveHeaders'],
  `this test was written against Node 22's node:http2 (running ${spawnSync('node', ['--version'], { encoding: 'utf8' }).stdout.trim()})`);

// A Nimbus process: a one-shot, the generated runner over the real shims artifact.
const { host, rawVfs } = createAuthority();
const dec = new TextDecoder();
let out = '';
adoptCtxExports({
  SupervisorRPC: ({ props }) => new Proxy({}, {
    get(_target, name) {
      if (typeof name !== 'string' || name === 'then') return undefined;
      if (name === 'stdout' || name === 'stderr') return async (data) => { out += dec.decode(data); };
      if (name === 'reportExit') return async () => {};
      return (...args) => host.supervisorOp({ op: name, args, pid: props?.pid });
    },
  }),
});
const runnerDir = mkdtempSync(join(tmpdir(), 'nimbus-http2-'));
process.on('exit', () => rmSync(runnerDir, { recursive: true, force: true }));
let runnerN = 0;
const env = {
  LOADER: {
    load(config) {
      const file = writeModuleSet(join(runnerDir, `runner-${runnerN++}`), config.modules, 'runner.js');
      const loaded = import(pathToFileURL(file).href);
      const supervisor = config.env?.SUPERVISOR;
      return {
        getEntrypoint: () => ({
          async fetch(request) { return (await loaded).default.fetch(request, { SUPERVISOR: supervisor }); },
          [Symbol.dispose]() {},
        }),
        [Symbol.dispose]() {},
      };
    },
    get() { throw new Error('a one-shot exec never takes the keyed loader path'); },
  },
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\//, '');
      return new Response(readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)));
    },
  },
};
const manager = new FacetManager(createFacetCtx(createFacetWorld(() => ({})), 'node-http2-module'), env, host.processes, new PortRegistry(), processHostFor, {});
manager.setVfs(rawVfs, processFiles(rawVfs));
const real = { console: globalThis.console, process: globalThis.process, Buffer: globalThis.Buffer };
let result;
try {
  result = await manager.exec(PROGRAM, { filename: '/home/user/http2.js', dirname: '/home/user', cwd: '/home/user', captureOutput: true });
} finally { Object.assign(globalThis, real); }
assert.equal(result.exitCode, 0, `the run failed: ${result.stderr}${out}`);
const nimbus = parse(result.stdout + out);
for (const key of Object.keys(expected)) assert.deepEqual(nimbus[key], expected[key], `a Nimbus process's node:http2 ${key} is Node's`);

// The substrate's node-compat map: the same module, without a Stream base.
const compat = createModuleMap({
  filesystem: () => { throw new Error('unused'); }, cwd: '/', env: {}, argv: [], filename: '/x.js', dirname: '/',
  stdout: { write() {} }, stderr: { write() {} }, signal: new AbortController().signal,
});
// As the other two arrive: through JSON.
const substrate = JSON.parse(JSON.stringify(
  new Function('http2', 'stream', `${REPORT}\nreturn http2Report(http2, stream, null);`)(compat.http2(), compat.stream())));
const { http1Request, http1Response, ...nodeShared } = expected.instanceOf;
for (const key of Object.keys(expected)) {
  if (key === 'instanceOf') continue;
  assert.deepEqual(substrate[key], expected[key], `node-compat's node:http2 ${key} is Node's`);
}
assert.deepEqual(substrate.instanceOf, nodeShared, "node-compat's instanceof answers are Node's");
assert.deepEqual({ http1Request, http1Response }, { http1Request: false, http1Response: false }, 'HTTP/1 objects are not HTTP/2 ones');

// What Nimbus cannot do refuses, by name.
for (const http2 of [compat.http2()]) {
  for (const make of [() => http2.createServer(), () => http2.createSecureServer({}), () => http2.performServerHandshake({}),
    () => new http2.Http2ServerResponse({}, {}), () => new http2.Http2ServerRequest({}, {}, {}, [])]) {
    assert.throws(make, (error) => error.code === 'ERR_HTTP2_NOT_SUPPORTED');
  }
  const session = http2.connect('https://example.com');
  const failure = await new Promise((resolve) => session.on('error', resolve));
  assert.equal(failure.code, 'ERR_HTTP2_NOT_SUPPORTED', 'a connection reports the refusal as an error event');
}

console.log('node-http2-module: ok');
