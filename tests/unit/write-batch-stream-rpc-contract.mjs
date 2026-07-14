#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { _rpcWriteBatchStream } from '../../packages/worker/src/session/rpc.ts';

const malformed = new ReadableStream({
  start(controller) {
    controller.enqueue(new Uint8Array([0x42, 0x41, 0x44, 0x21]));
    controller.close();
  },
});

const result = await _rpcWriteBatchStream(
  { ensureSqliteFs() {} },
  malformed,
);

assert.deepEqual(result, {
  ok: false,
  committedGroupSequence: 0,
  committedPathCount: 0,
  inodes: 0,
  chunks: 0,
  error: {
    code: 'ERR_WRITE_BATCH_STREAM',
    phase: 'decode',
    message: 'w7-frame: bad magic, expected NW7\\x01, got 42 41 44 21',
  },
});

console.log('writeBatchStream RPC contract: ok');
