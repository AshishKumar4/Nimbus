#!/usr/bin/env bun
// A lifo process's stdout over an output that takes text (a lifo command's,
// in the host's realm): bytes and text written to it reach the output as one
// stream decodes them, a character the bytes left unfinished before text a
// replacement character, as Node's stdout written to a pipe reads back; and
// an output's failure that comes after end() is the stream's error, never a
// finish. Under Bun against the source, then under node against the built
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

const failed = [];
const check = async (name, run) => {
  try { await run(); } catch (error) { failed.push(`${name}: ${String(error?.message ?? error).split('\n').slice(0, 6).join(' | ')}`); }
};
const quiet = { write() {} };

await check('bytes and text decode as one stream for a text output', async () => {
  const seen = [];
  const proc = createProcess({ argv: [], env: {}, cwd: '/', stdout: { write: (text) => { seen.push(text); } }, stderr: quiet });
  proc.stdout.write(Buffer.from([0xe2]));
  proc.stdout.write('x');
  proc.stdout.write(Buffer.from([0x82, 0xac]));
  await new Promise((resolve) => proc.stdout.end(resolve));
  assert.equal(seen.join(''), '\ufffdx\ufffd\ufffd');
});

await check('an empty write is no boundary: a character split around it decodes whole', async () => {
  const seen = [];
  const proc = createProcess({ argv: [], env: {}, cwd: '/', stdout: { write: (text) => { seen.push(text); } }, stderr: quiet });
  proc.stdout.write(Buffer.from([0xe2]));
  proc.stdout.write('');
  proc.stdout.write(Buffer.from([0x82, 0xac]));
  await new Promise((resolve) => proc.stdout.end(resolve));
  assert.equal(seen.join(''), '\u20ac');
});

await check('an output that fails after end() errors the stream, which does not finish', async () => {
  const proc = createProcess({
    argv: [], env: {}, cwd: '/', stderr: quiet,
    stdout: { write: () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('output gone')), 20)) },
  });
  const outcome = await new Promise((resolve) => {
    proc.stdout.on('finish', () => resolve('finished'));
    proc.stdout.on('error', (error) => resolve(`error ${error.message}`));
    proc.stdout.end('x');
  });
  assert.equal(outcome, 'error output gone');
});

if (underBun) {
  // Under node whatever Bun answered, so a red run shows both.
  const node = spawnSync('node', ['--no-warnings', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 120_000 });
  assert.deepEqual(failed, [], `bun:\n${failed.join('\n')}\n\nunder node (exit ${node.status}):\n${node.stdout}${node.stderr}`);
  assert.equal(node.status, 0, `under node:\n${node.stdout}${node.stderr}`);
  assert.match(node.stdout, /^ok - under node/m, node.stdout);
  console.log('ok - lifo-standard-streams (one decoding stream, failure after end; under Bun and Node)');
} else {
  assert.deepEqual(failed, [], `node:\n${failed.join('\n')}`);
  console.log('ok - under node');
}
