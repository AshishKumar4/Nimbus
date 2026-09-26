#!/usr/bin/env bun
// Refinement bridge for Nimbus.Vfs.ProcessFiles (FormalModelsLane e32fae61,
// lean/fixtures/process-files.json, VFS-PF-001).
//
// descriptors: processes open, write, fsync, close, are released or killed,
// through ProcessFiles' bound bridges. A case with writeRange runs twice, on
// the SQLite root and on a mounted MemoryVFS; one without runs on a mount
// that cannot write in place, whose handles buffer (cap from the case, EFBIG
// past it, a flush at fsync, the last close and a release; a kill loses the
// buffered bytes and names the descriptors). After each step the kernel's
// read of each file must be the model's, and so must each process's own view
// (readFd, readAs, statAs: its pending writes merged in, in open order).
//
// leases: a root link /x -> /dst; owners take and drop exclusive leases
// through a process's bridge, and write as an owner (a write stream under the
// lease) or as none (writeFile, whose receipt is checked against the path's
// revision read right before and right after).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../lean/fixtures/process-files.json', import.meta.url), 'utf8'));
const letters = (text) => new Uint8Array([...text].map((c) => c.charCodeAt(0) - 97));
const text = (bytes) => String.fromCharCode(...[...bytes].map((b) => b + 97));
const code = (fn) => { try { fn(); return 'ok'; } catch (error) { return { error: error.code ?? String(error.message).split(':')[0] }; } };

function descriptorWorld(testCase, where) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const files = new ProcessFiles(engine, { bufferedWriteBytes: testCase.cap });
  let root = '';
  let kernelRead;
  if (where === 'sqlite') {
    const kernel = engine.as(CRED_KERNEL);
    kernelRead = (path) => (kernel.exists(path.slice(1)) ? kernel.readFile(path.slice(1)) : null);
  } else {
    const memory = new MemoryVFS();
    // A backend that cannot write in place: its handles buffer.
    const mount = testCase.writeRange ? memory : Object.assign(Object.create(memory), { writeRange: undefined });
    if (!testCase.writeRange) mount.sync = mount;
    files.vfs.mount('/m', mount);
    root = '/m';
    kernelRead = (path) => (memory.stat(path) === null ? null : memory.readFile(path));
  }
  return { files, root, kernelRead };
}

function runDescriptors(testCase, where) {
  const { files, root, kernelRead } = descriptorWorld(testCase, where);
  const bridges = new Map();
  const bridgeOf = (pid) => {
    if (!bridges.has(pid)) bridges.set(pid, files.bind({ pid, cred: CRED_KERNEL }));
    return bridges.get(pid);
  };
  const fds = new Map(); // model fd -> { pid, id }
  const failures = [];
  for (const [at, step] of testCase.steps.entries()) {
    let got = 'ok';
    let want = 'expect' in step ? step.expect : 'ok';
    switch (step.op) {
      case 'open': {
        const bridge = bridgeOf(step.pid);
        const handle = bridge.open(`${root}${step.path}`, { read: true, write: true, create: true, append: step.append, truncate: step.trunc });
        fds.set(step.fd, { pid: step.pid, id: handle.id });
        break;
      }
      case 'write': {
        const fd = fds.get(step.fd);
        got = code(() => bridgeOf(fd.pid).write(fd.id, null, letters(step.bytes)));
        break;
      }
      case 'fsync': { const fd = fds.get(step.fd); got = code(() => bridgeOf(fd.pid).fsync(fd.id)); break; }
      case 'close': { const fd = fds.get(step.fd); got = code(() => bridgeOf(fd.pid).close(fd.id)); break; }
      case 'release': files.releaseProcess(step.pid); break;
      case 'kill': {
        const { lost } = files.killProcess(step.pid);
        const byId = new Map([...fds].filter(([, fd]) => fd.pid === step.pid).map(([modelFd, fd]) => [fd.id, modelFd]));
        got = lost.map((id) => byId.get(id)).sort((a, b) => a - b);
        want = [...step.lost].sort((a, b) => a - b);
        break;
      }
      case 'read': {
        const bytes = kernelRead(step.path);
        got = bytes === null ? null : text(bytes);
        break;
      }
      // A process's own view: its pending writes merged in (page cache);
      // pid 3 holds nothing and sees the mount.
      case 'readFd': {
        const fd = fds.get(step.fd);
        got = text(bridgeOf(fd.pid).read(fd.id, 0, 1 << 20));
        break;
      }
      case 'readAs': {
        const bytes = bridgeOf(step.pid).readFile(`${root}${step.path}`);
        got = bytes === null ? null : text(bytes);
        break;
      }
      case 'statAs': {
        const stat = bridgeOf(step.pid).stat(`${root}${step.path}`);
        got = stat === null ? null : { size: stat.size };
        break;
      }
      default: throw new Error(`unknown op ${step.op}`);
    }
    if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${where} step ${at} ${JSON.stringify(step)}: got ${JSON.stringify(got)}`);
  }
  return failures;
}

async function runLeases(testCase) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const files = new ProcessFiles(engine);
  const bridge = files.bind({ pid: 9, cred: CRED_KERNEL });
  const leases = new Map(); // model owner -> lease
  const failures = [];
  for (const [at, step] of testCase.steps.entries()) {
    let got = 'ok';
    switch (step.op) {
      case 'mkdir': got = code(() => bridge.mkdir(step.path)); break;
      case 'symlink': got = code(() => bridge.symlink(step.target, step.path)); break;
      case 'lease': got = code(() => { leases.set(step.owner, bridge.acquireExclusiveMutation(step.path)); }); break;
      case 'unlease': bridge.releaseExclusiveMutation(leases.get(step.owner).owner); leases.delete(step.owner); break;
      case 'writeFile': {
        if (step.owner === 0) {
          const before = engine.revision(step.path.slice(1));
          let receipt;
          got = code(() => { receipt = bridge.writeFile(step.path, letters(step.bytes)); });
          if (got === 'ok' && step.receipt) {
            const after = engine.revision(step.path.slice(1));
            // The contract's receipt is the revision after (a number).
            if (receipt !== after || !(after > before)) got = { receipt, before, after };
          }
          break;
        }
        const lease = leases.get(step.owner);
        const path = step.path.slice(1);
        const frames = encodeWriteBatchStream({
          inodes: [{ path, parentPath: path.slice(0, path.lastIndexOf('/')), isDir: false, size: 1, mtime: 1, mode: 0o644, chunkCount: 1 }],
          chunks: [{ path, chunkId: 0, data: letters(step.bytes) }],
        });
        const result = await bridge.writeStream(frames, lease === undefined ? {} : { mutationOwner: lease.owner });
        got = result.ok ? 'ok' : { error: (/\b(EBUSY|EPERM|EACCES|ENOENT)\b/.exec(result.error.message) ?? [result.error.message])[0] };
        break;
      }
      default: throw new Error(`unknown op ${step.op}`);
    }
    // A write lands where its name resolves (/x is a link to /dst).
    if (got === 'ok' && step.op === 'writeFile') {
      const landed = step.path.replace(/^\/x\//, 'dst/').replace(/^\//, '');
      if (!engine.as(CRED_KERNEL).exists(landed) || text(engine.as(CRED_KERNEL).readFile(landed)) !== step.bytes) got = { notAt: landed };
    }
    if (JSON.stringify(got) !== JSON.stringify(step.expect ?? 'ok')) failures.push(`leases step ${at} ${JSON.stringify(step)}: got ${JSON.stringify(got)}`);
  }
  return failures;
}

const failures = [];
let steps = 0;
for (const [index, testCase] of fixture.cases.entries()) {
  if (testCase.kind === 'descriptors') {
    for (const where of testCase.writeRange ? ['sqlite', 'mount'] : ['mount']) {
      failures.push(...runDescriptors(testCase, where).map((f) => `case ${index} ${f}`));
      steps += testCase.steps.length;
    }
  } else {
    failures.push(...(await runLeases(testCase)).map((f) => `case ${index} ${f}`));
    steps += testCase.steps.length;
  }
}
if (failures.length > 0) {
  for (const failure of failures.slice(0, 12)) console.log(`FAIL ${failure}`);
  console.log(`process-files-refinement: ${failures.length} of ${steps} steps disagree with the model`);
  process.exit(1);
}
console.log(`process-files-refinement: ${steps} steps in ${fixture.cases.length} cases agree with the model`);
