#!/usr/bin/env bun
// cli-failure — a CI script's failure ends with its cause on one line, and its
// caller quotes that line, or nothing when the child ended some other way
// (scripts/ci/lib/cli-failure.mjs).
import assert from 'node:assert/strict';
import { causeOf, printFailure } from '../../scripts/ci/lib/cli-failure.mjs';

const printed = (command, error) => {
  const lines = [];
  const write = console.error;
  console.error = (line) => { lines.push(String(line)); };
  try { printFailure(command, error); } finally { console.error = write; }
  return lines.join('\n');
};

const multiline = new Error('the Preview did not land:\n  wrangler exited 1\n  rerun with --rotate-secrets');
const stderr = printed('up', multiline);
assert.equal(causeOf({ stderr }), 'up failed: the Preview did not land: / wrangler exited 1 / rerun with --rotate-secrets',
  'a multiline cause is quoted whole, on one line');
assert.ok(stderr.includes(multiline.stack.split('\n')[1]), 'the stack is printed above it');
assert.equal(causeOf({ stderr: printed('version', 'refused') }), 'version failed: refused', 'a thrown non-Error too');
assert.equal(causeOf({ stderr: '33 | export async function cfApi(path) {\nTypeError: getaddrinfo EAI_AGAIN\n\nBun v1.4.0 (Linux x64)\n' }), '',
  'a child that did not end with printFailure is quoted from its stderr whole, not by its last line');
assert.equal(causeOf({ error: new Error('spawnSync bun ENOENT'), stderr: null }), 'spawnSync bun ENOENT', 'a child that never started: why it did not');
console.log('cli-failure OK');
