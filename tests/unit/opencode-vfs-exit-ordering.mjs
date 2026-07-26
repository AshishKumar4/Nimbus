#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { generateOpencodeRunnerCode } from '../../packages/worker/src/runtime/opencode-facet-runner.ts';

const source = generateOpencodeRunnerCode({
  argv: ['serve'],
  env: {},
  cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  cwd: '/home/user',
  stdin: '',
  shimsCode: 'const __nimbusTestShimMarker = true;',
  vfsBundle: '{}',
  vfsManifest: '{}',
  vfsMetadata: '{}',
  mode: 'server',
});

assert.ok(
  source.indexOf('const __nimbusDeferProcessExitReport = true;')
    < source.indexOf('const __nimbusTestShimMarker = true;'),
  'the shared shim evaluates under deferred terminal reporting',
);

const attachedStart = source.indexOf('async function __ocRunAttachedTui()');
const serveStart = source.indexOf('async function __ocRunServe()');
const oneShotStart = source.indexOf('async function __ocOneShotFetch(');
assert.ok(attachedStart >= 0 && serveStart > attachedStart && oneShotStart > serveStart);

const attached = source.slice(attachedStart, serveStart);
assert.ok(attached.includes('__nimbusProcessExitPromise.then'));
assert.ok(
  attached.indexOf('await __ocDrainVfsWrites();')
    < attached.indexOf('await __ocReportFinalExit();'),
  'attached mode drains VFS mutations before terminal reporting',
);

const serve = source.slice(serveStart, oneShotStart);
assert.ok(
  serve.includes('exitCode = Number(await __nimbusProcessExitPromise);'),
  'serve mode has an exit watcher instead of an uninterruptible keepalive',
);
assert.ok(
  serve.lastIndexOf('await __ocDrainVfsWrites();')
    < serve.indexOf('await __ocReportFinalExit();'),
  'serve mode performs its final VFS drain before terminal reporting',
);

const oneShot = source.slice(oneShotStart);
assert.ok(
  oneShot.indexOf('await __ocDrainVfsWrites();')
    < oneShot.indexOf('return __ocHostResponse.json({'),
  'one-shot mode drains VFS mutations before returning its result envelope',
);
assert.equal(
  oneShot.includes('await __ocReportFinalExit();'),
  false,
  'the manager, not the staged one-shot facet, owns terminal reporting',
);

const drainStart = source.indexOf('async function __ocDrainVfsWrites()');
const reportStart = source.indexOf('async function __ocReportFinalExit()');
const drain = source.slice(drainStart, reportStart);
assert.ok(drain.includes('await __nimbusDrainVfsWrites(__supervisor);'));
assert.equal(
  drain.includes('Object.keys(__vfsWrites).length'),
  false,
  'clean range/truncate mutations are drained even without whole-file cells',
);

console.log('opencode-vfs-exit-ordering: all assertions passed');
