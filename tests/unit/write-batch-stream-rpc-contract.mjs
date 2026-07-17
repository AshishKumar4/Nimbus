#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { SessionProcessSupervisor } from '../../packages/worker/src/runtime/session-process-supervisor.ts';
import { _rpcWriteBatchStream } from '../../packages/worker/src/session/rpc.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const malformed = new ReadableStream({
  type: 'bytes',
  start(controller) {
    controller.enqueue(new Uint8Array([0x42, 0x41, 0x44, 0x21]));
    controller.close();
  },
});

const harness = createSqliteVfsTestHarness();
const processes = new SessionProcessSupervisor();
const process = processes.spawn('git', ['clone'], '/home/user');
const result = await _rpcWriteBatchStream({
  sqliteFs: new SqliteVFS(harness.sql, harness.ctx),
  processes,
  ensureSqliteFs() {},
}, malformed, undefined, process.pid);

assert.deepEqual(result, {
  ok: false,
  committedGroupSequence: 0,
  committedPathCount: 0,
  inodes: 0,
  chunks: 0,
  error: {
    code: 'ERR_WRITE_BATCH_STREAM',
    phase: 'decode',
    message: 'w7-frame: bad magic, expected NW7\\x03, got 42 41 44 21',
  },
});

let forwardedOwner;
let forwardedCred;
const ownerResult = await _rpcWriteBatchStream({
  sqliteFs: {
    as(cred) {
      forwardedCred = cred;
      return {
        async writeStream(_stream, options) {
          forwardedOwner = options.mutationOwner;
          return {
            ok: true,
            committedGroupSequence: 0,
            committedPathCount: 0,
            inodes: 0,
            chunks: 0,
          };
        },
      };
    },
  },
  processes,
  ensureSqliteFs() {},
}, new ReadableStream(), 'clone-owner', process.pid);

assert.deepEqual(forwardedCred, process.cred);
assert.equal(forwardedOwner, 'clone-owner');
assert.equal(ownerResult.ok, true);

console.log('writeBatchStream RPC contract: ok');
