#!/usr/bin/env bun
// sdk/new/programmatic-sdk - @nimbus-sh/sdk exposes a usable
// Worker-side sandbox handle over a Durable Object binding.

import { makeAsserter } from '../../_driver.mjs';

const a = makeAsserter('sdk/new/programmatic-sdk');
const { Nimbus } = await import('../../../../packages/sdk/src/index.ts');
const { defineNimbusConfig } = await import('../../../../packages/config/src/index.ts');

class FakeNamespace {
  constructor(stub) {
    this.stub = stub;
    this.names = [];
  }
  idFromName(name) {
    this.names.push(name);
    return { name };
  }
  get(_id) {
    return this.stub;
  }
}

const calls = [];
const processLogChunks = [];
let processLogCursor = 0;
const stub = {
  async _rpcReady(options) {
    calls.push(['ready', options]);
    return { ok: true, preinstalled: options?.preinstall ?? [] };
  },
  async _rpcExec(command, options) {
    calls.push(['exec', command, options]);
    return { command, exitCode: 0, success: true, stdout: 'ok\n', stderr: '', duration: 1, timestamp: Date.now() };
  },
  async _rpcStartProcess(command, options) {
    calls.push(['startProcess', command, options]);
    return {
      command, exitCode: 0, success: true, stdout: '', stderr: '', duration: 1, timestamp: Date.now(),
      pid: 7,
      process: { pid: 7, command, argv: command.split(/\s+/), cwd: options.cwd, state: 'running', exitCode: null, startTime: 1, endTime: null, longRunning: true },
      ports: [{ port: 3000, pid: 7, registeredAt: 1 }],
    };
  },
  async _rpcRunCode(code, options) {
    calls.push(['runCode', code, options]);
    return { command: code, exitCode: 0, success: true, stdout: '4\n', stderr: '', duration: 1, timestamp: Date.now() };
  },
  async _rpcReadFile(path) { calls.push(['readFile', path]); return 'file'; },
  async _rpcReadFileBytes(path) { calls.push(['readFileBytes', path]); return new Uint8Array([1, 2]); },
  async _rpcWriteFile(path, content) { calls.push(['writeFile', path, content]); },
  async _rpcStat(path) { calls.push(['stat', path]); return { type: 'file', size: 4, mtime: 1, mode: 0o644 }; },
  async _rpcReaddir(path) { calls.push(['readdir', path]); return [{ name: 'a.txt', type: 'file' }]; },
  async _rpcExists(path) { calls.push(['exists', path]); return true; },
  async _rpcMkdir(path) { calls.push(['mkdir', path]); },
  async _rpcDeleteFile(path, options) { calls.push(['deleteFile', path, options]); },
  async _rpcInstallRuntime(spec, options) { calls.push(['installRuntime', spec, options]); return { spec, exitCode: 0 }; },
  async _rpcEnsureRuntimes(specs, options) { calls.push(['ensureRuntimes', specs, options]); return specs.map((spec) => ({ spec, exitCode: 0 })); },
  async _rpcListRuntimes() {
    calls.push(['listRuntimes']);
    return {
      installed: [{ name: 'clang', version: 'wasi-libc-modern', root: '/home/user/.nimbus/runtimes/clang/wasi-libc-modern', abi: 'wasm32-wasi-nimbus', bins: ['clang', 'wasm-ld'], sizeBytes: 1, license: 'Apache-2.0' }],
      available: [{ name: 'python', abi: 'pyodide', defaultVersion: '0.29.4', versions: [] }],
    };
  },
  async _rpcListProcesses() { calls.push(['listProcesses']); return []; },
  async _rpcKillProcess(pid) { calls.push(['killProcess', pid]); return { ok: true, pid }; },
  async _rpcWriteProcessInput(pid, data) {
    calls.push(['writeProcessInput', pid, data]);
    processLogChunks.push({ seq: processLogCursor++, ts: Date.now(), stream: 'stdout', data });
    return { ok: true, pid };
  },
  async _rpcEndProcessInput(pid) { calls.push(['endProcessInput', pid]); return { ok: true, pid }; },
  async _rpcResizeProcess(pid, size) { calls.push(['resizeProcess', pid, size]); return { ok: true, pid }; },
  async _rpcSignalProcess(pid, signal) { calls.push(['signalProcess', pid, signal]); return { ok: true, pid }; },
  async _rpcProcessLogs(pid, options = {}) {
    calls.push(['processLogs', pid, options]);
    const chunks = options.cursor === undefined
      ? [...processLogChunks]
      : processLogChunks.filter((chunk) => chunk.seq >= Number(options.cursor));
    return {
      pid,
      chunks,
      text: chunks.map((chunk) => chunk.data).join(''),
      cursor: processLogCursor,
      truncated: false,
      exit: null,
    };
  },
  async _rpcListPorts() { calls.push(['listPorts']); return [{ port: 3000, pid: 7, registeredAt: 1 }]; },
  async _rpcExposePort(port) { calls.push(['exposePort', port]); return { port, listening: true, pid: 7, registeredAt: 1 }; },
  async _rpcUnexposePort(port) { calls.push(['unexposePort', port]); return { port, ok: true }; },
  async _rpcDestroy(options) { calls.push(['destroy', options]); return { ok: true, killed: 0, destroyedAt: 1, reason: options?.reason ?? null }; },
};

const ns = new FakeNamespace(stub);
const config = defineNimbusConfig({
  endpoint: 'https://nimbus-os.dev',
  sandboxes: {
    proteus: {
      root: '/home/user/project',
      runtimes: {
        preinstall: ['python', 'clang'],
        onDemand: true,
        allow: ['node', 'bun', 'npm', 'git', 'python', 'ruby', 'clang', 'shell'],
      },
      tools: { namespace: 'sandbox', kind: 'sandbox' },
      preview: { pathStyle: true },
    },
    strict: {
      runtimes: {
        preinstall: ['python'],
        onDemand: false,
        allow: ['node', 'python', 'ruby', 'shell'],
      },
    },
    hostname: {},
  },
});

// The preview host suffix is a property of the DEPLOYMENT, so it comes off
// the bindings — never restated per profile, where it could drift.
const nimbus = Nimbus.fromEnv(
  { NIMBUS_SESSION: ns, NIMBUS_PREVIEW_HOST_SUFFIX: 'nimbus-os.dev' },
  config,
);
const box = nimbus.sandbox('agent-1', { profile: 'proteus', tenant: 'acme', subject: 'alice' });

const exec = await box.exec('node -e "console.log(4)"');
a.check('exec returns stdout', exec.stdout === 'ok\n');
a.check('DO name uses tenant subject session', ns.names[0] === 'acme:alice:agent-1', ns.names[0]);
a.check('ready preinstalls profile runtimes', JSON.stringify(calls[0]) === JSON.stringify(['ready', { preinstall: ['python', 'clang'] }]));
a.check('exec cwd defaults to profile root', calls.find((c) => c[0] === 'exec')?.[2]?.cwd === '/home/user/project');

const py = await box.runCode('print(2+2)', { language: 'python', install: 'ifMissing' });
a.check('runCode passes python install policy', py.stdout === '4\n'
  && calls.find((c) => c[0] === 'runCode')?.[2]?.language === 'python'
  && calls.find((c) => c[0] === 'runCode')?.[2]?.install === 'ifMissing');

await box.runtimes.ensure(['python', 'clang']);
a.check('runtimes.ensure calls RPC', !!calls.find((c) => c[0] === 'ensureRuntimes' && c[1].length === 2));

const runtimeList = await box.runtimes.list();
a.check('runtimes.list exposes installed runtime ABI',
  runtimeList.installed[0]?.abi === 'wasm32-wasi-nimbus',
  JSON.stringify(runtimeList.installed[0] ?? null));
a.check('runtimes.list exposes available runtime ABI',
  runtimeList.available[0]?.abi === 'pyodide',
  JSON.stringify(runtimeList.available[0] ?? null));

const port = await box.ports.expose(3000);
a.check('exposePort honours the profile pathStyle opt-out', port.url === 'https://nimbus-os.dev/s/agent-1/port/3000/');

const hostnameBox = nimbus.sandbox('host-safe-1', { profile: 'hostname' });
a.check('ports.url uses the deployment preview host for a host-safe sid',
  hostnameBox.ports.url(4173) === 'https://4173--host-safe-1.nimbus-os.dev/');
const unsafeHostnameBox = nimbus.sandbox('sdk.sandbox', { profile: 'hostname' });
a.check('ports.url keeps the path form for a DNS-unsafe sid',
  unsafeHostnameBox.ports.url(4173) === 'https://nimbus-os.dev/s/sdk.sandbox/port/4173/');

const remote = Nimbus.fromEnv({ NIMBUS_SESSION: ns }, config).sandbox('host-safe-1', { profile: 'hostname' });
a.check('ports.url keeps the path form when the deployment has no preview host',
  remote.ports.url(4173) === 'https://nimbus-os.dev/s/host-safe-1/port/4173/');

const provider = box.tools();
a.check('tools namespace from profile', provider.name === 'sandbox' && provider.kind === 'sandbox');
a.check('tools expose Proteus exec', typeof provider.tools.exec.execute === 'function');
a.check('capabilities do not claim docker', !provider.capabilities.includes('docker'));
a.check('capabilities report allowed runtimes without generic native overclaim',
  provider.capabilities.includes('python')
    && provider.capabilities.includes('ruby')
    && provider.capabilities.includes('wasi')
    && provider.capabilities.includes('clang_wasi')
    && !provider.capabilities.includes('native_binary'),
  JSON.stringify(provider.capabilities));

const stat = await box.files.stat('/home/user/project/a.txt');
a.check('files.stat exposes VFS stat', stat?.type === 'file' && stat.size === 4);

await box.processes.resize(7, { columns: 100, rows: 31 });
a.check('processes.resize calls terminal-size RPC',
  !!calls.find((c) => c[0] === 'resizeProcess' && c[1] === 7 && c[2]?.columns === 100 && c[2]?.rows === 31));

await box.processes.signal(7, 'SIGWINCH');
a.check('processes.signal calls process signal RPC',
  !!calls.find((c) => c[0] === 'signalProcess' && c[1] === 7 && c[2] === 'SIGWINCH'));

const attached = box.processes.attach(7, { pollIntervalMs: 25 });
await attached.write('hello-sdk\n');
const firstLogs = await attached.logs({ cursor: 0 });
a.check('processes.attach writes input and reads sequenced logs',
  firstLogs.text === 'hello-sdk\n'
  && firstLogs.cursor === 1
  && firstLogs.chunks[0]?.seq === 0
  && calls.find((c) => c[0] === 'writeProcessInput' && c[2] === 'hello-sdk\n'));

await attached.logs({ lines: 0 });
a.check('processes.logs preserves zero line limits',
  calls.some((c) => c[0] === 'processLogs' && c[2]?.lines === 0),
  JSON.stringify(calls.filter((c) => c[0] === 'processLogs').slice(-3)));

const zeroStreamController = new AbortController();
const zeroStreamStart = calls.length;
const zeroAttachment = box.processes.attach(7);
const zeroIterator = zeroAttachment.stream({
  bytes: 0,
  lines: 99,
  pollIntervalMs: 25,
  signal: zeroStreamController.signal,
})[Symbol.asyncIterator]();
const zeroNext = zeroIterator.next().catch((err) => ({ error: String(err?.message ?? err) }));
for (let i = 0; i < 20; i++) {
  if (calls.slice(zeroStreamStart).some((c) => c[0] === 'processLogs')) break;
  await new Promise((resolve) => setTimeout(resolve, 5));
}
zeroStreamController.abort();
await Promise.race([
  zeroNext,
  new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 100)),
]);
a.check('processes.attach stream preserves zero byte limits',
  calls.slice(zeroStreamStart).some((c) =>
    c[0] === 'processLogs'
    && c[2]?.bytes === 0
    && c[2]?.lines === undefined),
  JSON.stringify(calls.filter((c) => c[0] === 'processLogs').slice(-4)));

const controller = new AbortController();
const streaming = box.processes.attach(7, { pollIntervalMs: 25, signal: controller.signal });
await streaming.logs({ cursor: 0 });
const iterator = streaming[Symbol.asyncIterator]();
const nextChunk = iterator.next();
await streaming.write('stream-sdk\n');
const streamed = await Promise.race([
  nextChunk,
  new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 500)),
]);
controller.abort();
a.check('processes.attach streams new log chunks from the cursor',
  !streamed.timeout
  && streamed.value?.data === 'stream-sdk\n'
  && streamed.value?.seq === 1,
  JSON.stringify(streamed));

await attached.endInput();
a.check('processes.attach can end stdin',
  !!calls.find((c) => c[0] === 'endProcessInput' && c[1] === 7));

const destroyed = await box.destroy({ reason: 'test-cleanup' });
a.check('destroy calls lifecycle RPC',
  destroyed.ok === true
  && destroyed.reason === 'test-cleanup'
  && calls.find((c) => c[0] === 'destroy')?.[1]?.reason === 'test-cleanup');

const strict = nimbus.sandbox('agent-2', { profile: 'strict' });
await strict.runtimes.install('python');
a.check('preinstalled runtime is allowed with onDemand disabled',
  !!calls.find((c) => c[0] === 'installRuntime' && c[1] === 'python'));

let onDemandBlocked = false;
try {
  await strict.runtimes.install('ruby');
} catch (err) {
  onDemandBlocked = /on-demand runtime installs are disabled/.test(String(err?.message ?? err));
}
a.check('onDemand false blocks non-preinstalled runtime installs', onDemandBlocked);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
