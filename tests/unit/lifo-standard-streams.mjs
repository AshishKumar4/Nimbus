#!/usr/bin/env bun
// A lifo process's stdout over an output that takes text (a lifo command's,
// in the host's realm): bytes and text written to it reach the output as one
// stream decodes them, a character the bytes left unfinished before text a
// replacement character, as Node's stdout written to a pipe reads back; and
// an output's failure that comes after end() is the stream's error, never a
// finish; a tty.WriteStream the program made lets go of its writes'
// failures once it closes. Under Bun against the source, then under node against the built
// package (packages/core/dist: rebuild first).
//
// Red before: the text overtook the unfinished bytes ('x€' for e2 'x' 82 ac),
// and a later failure came after the stream had finished and was lost.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const underBun = typeof process.versions.bun === 'string';
const { createProcess } = await import(underBun
  ? '../../packages/core/src/substrate/lifo/node-compat/process.ts'
  : '../../packages/core/dist/substrate/lifo/node-compat/process.js');
const { ttyOf } = await import(underBun
  ? '../../packages/core/src/substrate/lifo/node-compat/tty-streams.ts'
  : '../../packages/core/dist/substrate/lifo/node-compat/tty-streams.js');

const failed = [];
const check = async (name, run) => {
  try { await run(); } catch (error) { failed.push(`${name}: ${String(error?.message ?? error).split('\n').slice(0, 6).join(' | ')}`); }
};
const quiet = { write() {} };

// A program's process: the session user's, its mask kept by the test.
const identity = { pid: 2, uid: 1000, gid: 1000, groups: [1000], umask: 0o022, setUmask: () => {} };

await check('bytes and text decode as one stream for a text output', async () => {
  const seen = [];
  const proc = createProcess({ argv: [], env: {}, cwd: '/', identity, stdio: { stdout: { write: (text) => { seen.push(text); } }, stderr: quiet, env: {} } });
  proc.stdout.write(Buffer.from([0xe2]));
  proc.stdout.write('x');
  proc.stdout.write(Buffer.from([0x82, 0xac]));
  await new Promise((resolve) => proc.stdout.end(resolve));
  assert.equal(seen.join(''), '\ufffdx\ufffd\ufffd');
});

await check('an empty write is no boundary: a character split around it decodes whole', async () => {
  const seen = [];
  const proc = createProcess({ argv: [], env: {}, cwd: '/', identity, stdio: { stdout: { write: (text) => { seen.push(text); } }, stderr: quiet, env: {} } });
  proc.stdout.write(Buffer.from([0xe2]));
  proc.stdout.write('');
  proc.stdout.write(Buffer.from([0x82, 0xac]));
  await new Promise((resolve) => proc.stdout.end(resolve));
  assert.equal(seen.join(''), '\u20ac');
});

await check('an output that fails after end() errors the stream, which does not finish', async () => {
  const proc = createProcess({
    argv: [], env: {}, cwd: '/', identity,
    stdio: { stderr: quiet, env: {}, stdout: { write: () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('output gone')), 20)) } },
  });
  const outcome = await new Promise((resolve) => {
    proc.stdout.on('finish', () => resolve('finished'));
    proc.stdout.on('error', (error) => resolve(`error ${error.message}`));
    proc.stdout.end('x');
  });
  assert.equal(outcome, 'error output gone');
});

// A program's writer of a realm's output hears its own writes' failures until it closes, not after: a program that
// makes and closes WriteStreams holds none of them.
await check('a tty.WriteStream lets go of its failures once it closes, ended or destroyed', async () => {
  const subscribed = new Set();
  const output = () => ({
    write() {},
    onFailure(listener) {
      const entry = { listener };
      subscribed.add(entry);
      return () => { subscribed.delete(entry); };
    },
    another: output,
  });
  const stdio = { stdout: output(), stderr: quiet, env: {}, terminal: { isatty: () => false, isPipe: (fd) => fd === 1, setRawMode() {} } };
  const { WriteStream } = ttyOf(stdio).module;
  const baseline = subscribed.size;
  for (let i = 0; i < 20; i++) {
    const w = new WriteStream(1);
    w.on('error', () => {});
    const closed = new Promise((resolve) => w.once('close', resolve));
    if (i % 2 === 0) w.end('x'); else w.destroy();
    await closed;
  }
  assert.equal(subscribed.size, baseline, `${subscribed.size - baseline} closed writers still subscribed`);
});

if (underBun) {
  // Under node whatever Bun answered, so a red run shows both.
  const node = spawnSync('node', ['--no-warnings', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 120_000 });
  assert.deepEqual(failed, [], `bun:\n${failed.join('\n')}\n\nunder node (exit ${node.status}):\n${node.stdout}${node.stderr}`);
  assert.equal(node.status, 0, `under node:\n${node.stdout}${node.stderr}`);
  assert.match(node.stdout, /^ok - under node/m, node.stdout);
  console.log('ok - lifo-standard-streams (one decoding stream, failure after end, closed writers let go; under Bun and Node)');
} else {
  assert.deepEqual(failed, [], `node:\n${failed.join('\n')}`);
  console.log('ok - under node');
}
