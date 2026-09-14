#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSupervisorOpHandler } from '../../packages/core/src/workspace/supervisor-op.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { getCtxExports, supervisorEntrypoint, hostNamespace, hostDispatchMethod } from '../../packages/platform/src/composition.ts';
import { getCtxExports as fabricExports } from '../../packages/fabric/src/composition.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const processes = new SessionProcessSupervisor();
const proc = processes.spawn('node', [], '/home/user');
const output = [];
const exports = { Supervisor: ({ props }) => ({ props }) };
const ws = await NimbusWorkspace.create({
  sql: harness.sql, transactions: { ...harness.ctx, exports: { wrong: () => null } },
  processes, ctxExports: exports,
  fabric: { supervisorEntrypoint: 'Supervisor', hostNamespace: 'ACTORS', hostDispatchMethod: 'workspaceCall' },
  processOutput: (...args) => output.push(args),
  supervisorOps: { status: () => 'healthy' },
});
const op = (name, ...args) => ws.supervisorOp({ op: name, args, pid: proc.pid });
try {
  assert.equal(getCtxExports(), exports);
  assert.equal(fabricExports(), exports);
  assert.equal(supervisorEntrypoint(), exports.Supervisor);
  assert.equal(hostNamespace(), 'ACTORS');
  assert.equal(hostDispatchMethod(), 'workspaceCall');
  const path = '/home/user/project';
  await op('mkdir', path);
  await op('writeFile', `${path}/a`, 'abcdef');
  assert.equal(await op('readFile', `${path}/a`), 'abcdef');
  assert.equal((await ws.exec(`cat ${path}/a`)).stdout, 'abcdef');
  assert.deepEqual(await op('readFileBytes', `${path}/a`), new TextEncoder().encode('abcdef'));
  assert.equal((await op('stat', `${path}/a`)).uid, 1000);
  assert.equal(await op('exists', `${path}/missing`), false);
  for (const name of ['fsReadRange', 'fsReadRangeUncached']) {
    assert.deepEqual(await op(name, `${path}/a`, 1, 3), new TextEncoder().encode('bcd'));
  }
  await op('symlink', `${path}/a`, `${path}/link`);
  assert.equal(await op('readlink', `${path}/link`), `${path}/a`);
  assert.equal((await op('lstat', `${path}/link`)).type, 'symlink');
  assert.equal((await op('stat', `${path}/link`)).type, 'file');
  assert.equal(await op('hasLegacySymlinkUnder', path), false);
  await op('chmod', `${path}/a`, 0o600);
  await op('utimes', `${path}/a`, 100, 200);
  assert.equal((await op('stat', `${path}/a`)).mtime, 200);
  await op('rename', `${path}/a`, `${path}/b`);
  await op('fsTruncate', `${path}/b`, 3);
  assert.equal(await op('readFile', `${path}/b`), 'abc');
  assert.ok(await op('fsRevision') > 0);
  assert.deepEqual((await op('readdir', path)).map((entry) => entry.name).sort(), ['b', 'link']);
  await op('unlink', `${path}/link`);
  await op('unlink', `${path}/b`);
  await op('rmdir', path);
  await op('stdout', 'progress');
  await op('stderr', 'warning');
  assert.deepEqual(output, [['stdout', proc.pid, 'progress'], ['stderr', proc.pid, 'warning']]);
  assert.equal(await op('status'), 'healthy');
  for (const name of ['missing', 'constructor', 'toString', '__proto__']) {
    await assert.rejects(op(name), /not served/);
  }
  await assert.rejects(ws.supervisorOp(null), /names no operation/);
  await assert.rejects(op('readFile', 7), /must be a string/);
  await assert.rejects(op('fsReadRange', '/x', NaN, 3), /must be a number/);
  await assert.rejects(op('writeFile', '/x', {}), /must be bytes or text/);
  await assert.rejects(op('writeBatchStream'), /no stream/);
  for (const pid of [0, -1, 1.5, 987654321]) {
    await assert.rejects(ws.supervisorOp({ op: 'writeFile', args: ['/home/user/denied', 'bad'], pid }));
  }
  const kernel = ws.vfs.as(CRED_KERNEL);
  kernel.writeFile('/private', 'secret', { mode: 0o600 });
  await assert.rejects(op('readFile', '/private'), /EACCES/);
  await assert.rejects(ws.supervisorOp({ op: 'readFile', args: ['/private'] }), /EACCES/);

  const stream = encodeWriteBatchStream({
    inodes: [{ path: 'home/user/streamed', parentPath: 'home/user', isDir: false,
      size: 3, mtime: 0, mode: 0o644, chunkCount: 1 }],
    chunks: [{ path: 'home/user/streamed', chunkId: 0, data: new Uint8Array([1, 2, 3]) }],
  });
  const result = await ws.supervisorOp({ op: 'writeBatchStream', pid: proc.pid, stream });
  assert.equal(result.ok, true);
  assert.deepEqual(await op('readFileBytes', '/home/user/streamed'), new Uint8Array([1, 2, 3]));
  const overrides = createSupervisorOpHandler({ vfs: ws.vfs, extend: { stdout: (e) => e.args[0] } });
  assert.equal(await overrides({ op: 'stdout', args: ['host owns accounting'] }), 'host owns accounting');
  const standalone = createSupervisorOpHandler({ vfs: ws.vfs });
  await standalone({ op: 'writeFile', args: ['/home/user/standalone', 'user'], pid: 42 });
  assert.equal(kernel.stat('/home/user/standalone').uid, 1000);
  console.log('workspace-supervisor-op: shared state, real filesystem, credentials and extensions passed');
} finally {
  harness.db.close();
}
