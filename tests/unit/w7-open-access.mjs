#!/usr/bin/env bun
// A W7 open carries the access it asks as one value, as open(2)'s O_ACCMODE:
// 'read', 'write' or 'readwrite'. The frame refuses any other shape, the
// two-boolean one included (read, write), so no open asks a combination
// open(2) has none of. The session judges the access asked: O_RDONLY|O_CREAT
// opens a file its owner may only read, O_TRUNC asks write whatever the
// access, and a description keeps only the rights its access asked.
import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { decodeWriteBatchStream, encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const open = (fields) => ({ type: 'call', call: { call: 'open', path: 'home/user/f', mode: 0o644, ...fields } });

/** The calls of a wave of `ops`, as the session decodes them; or its refusal's message. */
async function decoded(ops) {
  try {
    const stream = await decodeWriteBatchStream(encodeWriteBatchStream({ inodes: [], chunks: [], ops }));
    const calls = [];
    for await (const record of stream.records) if (record.type === 'call') calls.push(record.call);
    return calls;
  } catch (error) {
    return String(error?.message ?? error);
  }
}

for (const access of ['read', 'write', 'readwrite']) {
  assert.deepEqual(await decoded([open({ access })]), [{ call: 'open', path: 'home/user/f', mode: 0o644, access }], `${access} is carried`);
}
for (const [what, fields] of [
  ['no access', {}],
  ['the two-boolean shape (read)', { read: true }],
  ['the two-boolean shape (write)', { access: 'read', write: false }],
  ['an access open(2) has none of', { access: 'rw' }],
]) {
  const answer = await decoded([open(fields)]);
  assert.equal(typeof answer, 'string', `${what} is refused: ${JSON.stringify(answer)}`);
  assert.match(answer, /w7-frame/, what);
}

// The session's judgment of the access asked.
const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
const kernel = ws.vfs.as(CRED_KERNEL);
kernel.mkdir('home/user', { recursive: true });
kernel.chown('home/user', 1000, 1000);
kernel.writeFile('home/user/ro', 'read only');
kernel.chown('home/user/ro', 1000, 1000);
kernel.chmod('home/user/ro', 0o444);
kernel.writeFile('home/user/rw', 'kept');
kernel.chown('home/user/rw', 1000, 1000);
const proc = ws.filesystem.bind({ pid: 9100, cred: USER });
const wave = (ops) => proc.writeStream(encodeWriteBatchStream({ inodes: [], chunks: [], ops }));
const errno = (result) => (result.ok ? 'ok' : result.error?.errno ?? result.sequence?.refused?.errno);
const at = (path, fields) => ({ type: 'call', call: { call: 'open', path, mode: 0o644, ...fields } });
assert.equal(errno(await wave([at('home/user/ro', { access: 'read', create: true })])), 'ok', 'O_RDONLY|O_CREAT of a read-only file');
assert.equal(errno(await wave([at('home/user/ro', { access: 'write', create: true })])), 'EACCES', 'O_WRONLY|O_CREAT of it');
assert.equal(errno(await wave([at('home/user/ro', { access: 'read', truncate: true })])), 'EACCES', 'O_RDONLY|O_TRUNC asks write');
assert.equal(dec.decode(kernel.readFile('home/user/ro')), 'read only');
assert.equal(errno(await wave([at('home/user/rw', { access: 'read', description: 'd1' })])), 'ok');
assert.equal(errno(await wave([{ type: 'call', call: { call: 'write', path: 'home/user/rw', description: 'd1', offset: 0, data: enc.encode('XX') } }])), 'EBADF',
  'a read-only description refuses a write through it');
assert.equal(dec.decode(kernel.readFile('home/user/rw')), 'kept');
console.log('w7-open-access: one access value, judged by the session and kept by its descriptions');
