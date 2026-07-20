#!/usr/bin/env bun
// Regression: the attached-TTY stdin pump must survive TRANSIENT supervisor
// RPC failures (a DO instance reset rejects in-flight calls; the binding
// routes by DO id and recovers on the next call) instead of dying on the
// first rejection and falsely reporting exit 1 for a live process — and must
// still give up on PERSISTENT failure so an orphaned facet unwinds.

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

function makePump(cpReadStdin, reportExit) {
  const supervisor = {
    cpReadStdin,
    reportExit,
    stderr: async () => {},
  };
  const code = generateShimsCode();
  const factory = new Function(
    '__vfsBundle', '__vfsWrites', '__vfsDirs', '__vfsManifest', '__supervisor',
    'cwd', 'argv', 'env', 'filename', 'dirname', '__ProcessExit',
    '"use strict";let stdout = ""; let stderr = "";' + code + '\n;return { process: __processMod };'
  );
  class ProcessExit extends Error {
    constructor(codeArg) { super(`process.exit(${codeArg})`); this.code = codeArg; }
  }
  const sandbox = factory(
    {}, {}, {}, null, supervisor,
    '/home/user', [], { NIMBUS_ATTACHED_TTY: '1', NIMBUS_CP_CHILD_PID: '42' },
    '/home/user/main.mjs', '/home/user', ProcessExit,
  );
  return sandbox.process;
}

// ── [1] transient failures: pump retries and keeps delivering ──────────────
{
  let calls = 0;
  const received = [];
  const exits = [];
  const proc = makePump(
    async () => {
      calls++;
      if (calls <= 3) throw new Error('Internal error in Durable Object storage caused object to be reset');
      if (calls === 4) return { data: 'keystroke' };
      return { ended: true };
    },
    async (code, tail) => { exits.push({ code, tail }); },
  );
  proc.stdin.setEncoding('utf8');
  proc.stdin.on('data', (c) => received.push(String(c)));
  proc.stdin.__nimbusStartLivePump();
  // 3 rejections × 500ms retry pause + delivery + end.
  await new Promise((r) => setTimeout(r, 2400));
  assert.deepEqual(received, ['keystroke'], 'input delivered after transient failures');
  assert.equal(exits.length, 0, 'no false exit report for a live process');
  console.log('  [1] pump retries transient supervisor failures and keeps delivering input');
}

// ── [2] persistent failure: pump gives up and reports once ─────────────────
{
  let calls = 0;
  const exits = [];
  const proc = makePump(
    async () => { calls++; throw new Error('supervisor permanently gone'); },
    async (code, tail) => { exits.push({ code, tail }); },
  );
  proc.stdin.__nimbusStartLivePump();
  // 10 retries × 500ms + the final throw.
  await new Promise((r) => setTimeout(r, 6500));
  assert.ok(calls >= 11, `retry bound honored before giving up (calls=${calls})`);
  assert.equal(exits.length, 1, 'exactly one exit report on persistent failure');
  assert.equal(exits[0].code, 1);
  console.log(`  [2] pump gives up after the retry bound (${calls} attempts) and reports exit once`);
}

console.log('node-shims-stdin-pump-retry OK: transient supervisor failures no longer kill the attached stdin pump');
