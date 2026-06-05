#!/usr/bin/env bun
// sdk/new/flue-adapter — @nimbus-sh/sdk/flue adapts a NimbusSandbox to
// Flue's sandbox connector contract without a hard runtime dependency.

import { makeAsserter } from '../../_driver.mjs';

const a = makeAsserter('sdk/new/flue-adapter');
const { Nimbus } = await import('../../../../packages/sdk/src/index.ts');
const { nimbusFlue, NimbusFlueApi } = await import('../../../../packages/sdk/src/flue.ts');

class FakeNamespace {
  constructor(stub) {
    this.stub = stub;
  }
  idFromName(name) { return { name }; }
  get() { return this.stub; }
}

const calls = [];
const stub = {
  async _rpcReady(options) { calls.push(['ready', options]); return { ok: true, preinstalled: [] }; },
  async _rpcExec(command, options) {
    calls.push(['exec', command, options]);
    return { command, exitCode: 0, success: true, stdout: 'ok\n', stderr: '', duration: 1, timestamp: 1 };
  },
  async _rpcReadFile(path) { calls.push(['readFile', path]); return 'hello'; },
  async _rpcReadFileBytes(path) { calls.push(['readFileBytes', path]); return new Uint8Array([104, 105]); },
  async _rpcWriteFile(path, content) { calls.push(['writeFile', path, content]); },
  async _rpcStat(path) { calls.push(['stat', path]); return { type: 'file', size: 5, mtime: 1, mode: 0o644 }; },
  async _rpcReaddir(path) { calls.push(['readdir', path]); return [{ name: 'a.txt', type: 'file' }]; },
  async _rpcExists(path) { calls.push(['exists', path]); return path !== '/missing'; },
  async _rpcMkdir(path) { calls.push(['mkdir', path]); },
  async _rpcDeleteFile(path, options) { calls.push(['deleteFile', path, options]); },
  async _rpcStartProcess(command, options) { calls.push(['startProcess', command, options]); return { command, exitCode: 0, success: true, stdout: '', stderr: '', duration: 1, timestamp: 1, pid: null, process: null, ports: [] }; },
  async _rpcRunCode(code, options) { calls.push(['runCode', code, options]); return { command: code, exitCode: 0, success: true, stdout: '', stderr: '', duration: 1, timestamp: 1 }; },
  async _rpcInstallRuntime(spec, options) { calls.push(['installRuntime', spec, options]); return { spec }; },
  async _rpcEnsureRuntimes(specs, options) { calls.push(['ensureRuntimes', specs, options]); return []; },
  async _rpcListRuntimes() { calls.push(['listRuntimes']); return { installed: [], available: [] }; },
  async _rpcListProcesses() { calls.push(['listProcesses']); return []; },
  async _rpcKillProcess(pid) { calls.push(['killProcess', pid]); return { ok: true, pid }; },
  async _rpcProcessLogs(pid, options) { calls.push(['processLogs', pid, options]); return { text: '' }; },
  async _rpcListPorts() { calls.push(['listPorts']); return []; },
  async _rpcExposePort(port) { calls.push(['exposePort', port]); return { port, listening: false, pid: null, registeredAt: null }; },
  async _rpcUnexposePort(port) { calls.push(['unexposePort', port]); return { port, ok: true }; },
};

const box = Nimbus
  .fromEnv({ NIMBUS_SESSION: new FakeNamespace(stub) }, { sandboxes: { default: { root: '/workspace' } } })
  .sandbox('flue-job');

const captured = {};
const runtime = {
  createSandboxSessionEnv(api, cwd) {
    captured.api = api;
    captured.cwd = cwd;
    return { api, cwd };
  },
};

const factory = nimbusFlue(box, { runtime, cwd: '/workspace' });
const env = await factory.createSessionEnv({ id: 'session-1' });
a.check('factory returns runtime-created session env', env.cwd === '/workspace' && env.api instanceof NimbusFlueApi);

const exec = await captured.api.exec('echo ok', { cwd: '/workspace', timeout: 2 });
a.check('exec adapts timeout seconds to Nimbus milliseconds',
  exec.stdout === 'ok\n' && calls.find((c) => c[0] === 'exec')?.[2]?.timeoutMs === 2000);

const content = await captured.api.readFile('a.txt');
const bytes = await captured.api.readFileBuffer('a.bin');
const stat = await captured.api.stat('a.txt');
const names = await captured.api.readdir('/workspace');
await captured.api.writeFile('b.txt', 'new');
await captured.api.mkdir('/workspace/dir', { recursive: true });
await captured.api.rm('/workspace/dir', { recursive: true });

a.check('readFile returns file content', content === 'hello');
a.check('readFileBuffer returns bytes', bytes instanceof Uint8Array && bytes[0] === 104);
a.check('stat maps to Flue file stat', stat.isFile === true && stat.isDirectory === false && stat.size === 5);
a.check('readdir returns names', JSON.stringify(names) === JSON.stringify(['a.txt']));
a.check('write/mkdir/rm route to Nimbus file RPCs',
  calls.some((c) => c[0] === 'writeFile')
  && calls.some((c) => c[0] === 'mkdir')
  && calls.some((c) => c[0] === 'deleteFile' && c[2]?.recursive === true));

let missing = false;
try {
  await nimbusFlue(box).createSessionEnv({ id: 'missing-runtime' });
} catch (e) {
  missing = /requires @flue\/runtime/.test(String(e?.message ?? e));
}
a.check('missing Flue runtime error is explicit', missing);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
