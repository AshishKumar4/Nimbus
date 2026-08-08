#!/usr/bin/env bun
// live-smoke — drive @computesdk/nimbus against a real Nimbus deployment
// through the ComputeSDK provider interface.
//
//   BASE=<url> NIMBUS_PROBE_TOKEN=<jwt> bun packages/computesdk-nimbus/src/__tests__/live-smoke.mjs
//
// Every assertion checks a value only the sandbox could have produced, so
// a provider that answered locally without reaching Nimbus would fail.

import assert from 'node:assert/strict';
import { nimbus } from '../index.ts';

const endpoint = process.env.BASE;
const token = process.env.NIMBUS_PROBE_TOKEN;
if (!endpoint || !token) {
  console.error('live-smoke: BASE and NIMBUS_PROBE_TOKEN are required');
  process.exit(2);
}

const compute = nimbus({ endpoint, token });
const nonce = `nonce-${Math.random().toString(36).slice(2)}`;
let sandbox;

try {
  sandbox = await compute.sandbox.create();
  console.log(`created ${sandbox.sandboxId}`);

  // The benchmark's command. Node must really be there.
  const version = await sandbox.runCommand('node -v');
  assert.equal(version.exitCode, 0, `node -v failed: ${version.stderr}`);
  assert.match(version.stdout, /^v\d+\.\d+\.\d+/, `unexpected node version: ${version.stdout}`);
  console.log(`node -v → ${version.stdout.trim()} (${version.durationMs}ms)`);

  // Compute something the caller could not have known.
  const computed = await sandbox.runCommand(`node -e "console.log(6*7)"`);
  assert.equal(computed.stdout.trim(), '42');

  // Exit codes are real.
  const failed = await sandbox.runCommand('exit 3');
  assert.equal(failed.exitCode, 3, 'a non-zero exit must survive the round trip');

  // Filesystem round trip through the sandbox, read back by a command so
  // the write is confirmed by a different code path than the one that wrote it.
  await sandbox.filesystem.writeFile('smoke.txt', nonce);
  assert.equal(await sandbox.filesystem.readFile('smoke.txt'), nonce);
  const catted = await sandbox.runCommand('cat smoke.txt');
  assert.equal(catted.stdout.trim(), nonce, 'the file the FS API wrote must be visible to the shell');

  assert.equal(await sandbox.filesystem.exists('smoke.txt'), true);
  assert.equal(await sandbox.filesystem.exists('nope.txt'), false);

  await sandbox.filesystem.mkdir('sub');
  const entries = await sandbox.filesystem.readdir('.');
  const names = entries.map((e) => e.name);
  assert.ok(names.includes('smoke.txt'), `readdir missing smoke.txt: ${names}`);
  assert.equal(entries.find((e) => e.name === 'sub')?.type, 'directory');

  await sandbox.filesystem.remove('smoke.txt');
  assert.equal(await sandbox.filesystem.exists('smoke.txt'), false);

  // getInfo reports the marker's creation time, not now.
  const info = await sandbox.getInfo();
  assert.equal(info.provider, 'nimbus');
  assert.ok(info.createdAt.getTime() > 0 && info.createdAt.getTime() <= Date.now());

  // getById finds what create made, and reports a miss for what it did not.
  const found = await compute.sandbox.getById(sandbox.sandboxId);
  assert.ok(found, 'getById must find a sandbox that create() made');
  assert.equal(
    (await found.getInfo()).createdAt.getTime(),
    info.createdAt.getTime(),
    'getById must recover the original creation time',
  );

  const ghost = await compute.sandbox.getById(`ghost-${Math.random().toString(36).slice(2, 8)}`);
  assert.equal(ghost, null, 'getById must report a miss for an id never created');

  // Streaming exec really streams through the process log cursor.
  const chunks = [];
  const streamed = await sandbox.runCommand(
    `node -e "console.log('a'); console.error('b')"`,
    { onStdout: (d) => chunks.push(d) },
  );
  assert.equal(streamed.exitCode, 0);
  assert.match(streamed.stdout, /a/);
  assert.match(streamed.stderr, /b/);
  assert.ok(chunks.length > 0, 'onStdout must receive at least one chunk');

  // list is refused, not faked.
  await assert.rejects(() => compute.sandbox.list(), /does not support listing/);

  console.log('live-smoke: all assertions passed');
} finally {
  if (sandbox) {
    await sandbox.destroy().catch((e) => console.warn(`cleanup failed: ${e.message}`));
  }
}
