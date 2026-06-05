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
  async _rpcListRuntimes() { calls.push(['listRuntimes']); return { installed: [], available: [{ name: 'python', defaultVersion: '0.29.4', versions: [] }] }; },
  async _rpcListProcesses() { calls.push(['listProcesses']); return []; },
  async _rpcKillProcess(pid) { calls.push(['killProcess', pid]); return { ok: true, pid }; },
  async _rpcProcessLogs(pid, options) { calls.push(['processLogs', pid, options]); return { text: 'logs' }; },
  async _rpcListPorts() { calls.push(['listPorts']); return [{ port: 3000, pid: 7, registeredAt: 1 }]; },
  async _rpcExposePort(port) { calls.push(['exposePort', port]); return { port, listening: true, pid: 7, registeredAt: 1 }; },
  async _rpcUnexposePort(port) { calls.push(['unexposePort', port]); return { port, ok: true }; },
};

const ns = new FakeNamespace(stub);
const config = defineNimbusConfig({
  endpoint: 'https://nimbus.ashishkumarsingh.com',
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
  },
});

const nimbus = Nimbus.fromEnv({ NIMBUS_SESSION: ns }, config);
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

const port = await box.ports.expose(3000);
a.check('exposePort returns path-style URL', port.url === 'https://nimbus.ashishkumarsingh.com/s/agent-1/port/3000/');

const provider = box.tools();
a.check('tools namespace from profile', provider.name === 'sandbox' && provider.kind === 'sandbox');
a.check('tools expose Proteus exec', typeof provider.tools.exec.execute === 'function');
a.check('capabilities do not claim docker', !provider.capabilities.includes('docker'));

const stat = await box.files.stat('/home/user/project/a.txt');
a.check('files.stat exposes VFS stat', stat?.type === 'file' && stat.size === 4);

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
