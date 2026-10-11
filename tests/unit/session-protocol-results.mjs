import assert from 'node:assert/strict';
import { Nimbus } from '../../packages/sdk/src/sandbox.ts';
import { sessionFileStatOf } from '../../packages/core/src/runtime/session-protocol.ts';

const process = {
  pid: 7, command: 'server', argv: ['server'], cwd: '/home/user', state: 'running',
  exitCode: null, startTime: 1, endTime: null, longRunning: true, execId: 'job:7',
};
const port = { port: 3000, pid: 7, registeredAt: 1, capability: 'port-capability', execId: 'job:7' };
const install = { spec: 'python', exitCode: 0, stdout: 'installed\n', stderr: '' };
const replies = {
  ready: { ok: true, preinstalled: [] },
  startProcess: { command: 'server', pid: 7, process, ports: [port], startedAt: 1 },
  listProcesses: [process], listPorts: [port], installRuntime: install, ensureRuntimes: [install],
  writeFile: 0, mkdir: undefined,
  stat: { type: 'file', size: 3, mtime: 1, mode: 0o644, ino: 41, revision: 7 },
  lstat: { type: 'symlink', size: 7, mtime: 1, mode: 0o777, ino: 42, revision: 8 },
  readlink: '../file',
};
const client = Nimbus.connect({ endpoint: 'https://protocol.test', fetch: async (_url, init) => {
  const { op } = JSON.parse(init.body);
  assert.ok(Object.hasOwn(replies, op), `unexpected operation ${op}`);
  return Response.json({ ok: true, result: replies[op] });
} }).sandbox('protocol');

const started = await client.startProcess('server');
assert.equal(started.process.attachedTty, false, 'older process replies retain the existing default');
assert.deepEqual(started.ports, [port]);
assert.deepEqual(await client.processes.list(), [{ ...process, attachedTty: false }]);
assert.deepEqual(await client.ports.list(), [port]);
assert.deepEqual(await client.runtimes.install('python'), install);
assert.deepEqual(await client.runtimes.ensure(['python']), [install]);
assert.equal(await client.files.write('/home/user/file', ''), undefined, 'numeric zero is a present wire result, and the public write is void');
assert.equal(await client.files.mkdir('/home/user/directory'), undefined, 'a truly void wire result needs no result property');
assert.deepEqual(await client.files.stat('/file'), replies.stat, 'remote stat preserves inode and revision');
assert.deepEqual(await client.files.lstat('/link'), replies.lstat, 'remote lstat preserves the symlink metadata');
assert.equal(await client.files.readlink('/link'), '../file', 'remote readlink returns the stored target verbatim');
replies.stat = { type: 'file', size: 3, mtime: 1, mode: 0o644 };
assert.deepEqual(await client.files.stat('/mounted/file'), replies.stat, 'a backend without revision or inode reports neither');
replies.readlink = null;
assert.equal(await client.files.readlink('/missing'), null);
assert.deepEqual(sessionFileStatOf({ ...replies.stat, ino: 0, revision: 0 }), replies.stat, 'runtime unknown sentinels are absent on the session wire');
assert.equal(sessionFileStatOf(null), null);

replies.installRuntime = { ...install, exitCode: '0' };
await assert.rejects(client.runtimes.install('python'), (error) => error.name === 'ZodError' && error.issues.some((issue) => issue.path[0] === 'exitCode'));
replies.ensureRuntimes = [{ spec: 'python', exitCode: 0, stdout: '' }];
await assert.rejects(client.runtimes.ensure(['python']), (error) => error.name === 'ZodError' && error.issues.some((issue) => issue.path.at(-1) === 'stderr'));
replies.startProcess = { ...replies.startProcess, pid: '7' };
await assert.rejects(client.startProcess('server'), (error) => error.name === 'ZodError');
replies.listPorts = [{ ...port, capability: undefined }];
await assert.rejects(client.ports.list(), (error) => error.name === 'ZodError');
replies.writeFile = { written: 0 };
await assert.rejects(client.files.write('/home/user/file', ''), (error) => error.name === 'ZodError');
console.log('session-protocol-results: ok');
