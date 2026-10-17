#!/usr/bin/env bun
// One byte-to-hex encoder (platform/hex.ts bytesToHex), and the spellings
// built on it unchanged: node's Buffer hex is the oracle for the encoder,
// through the runtime's native Uint8Array.prototype.toHex and through its
// table (a fresh module where the runtime has none), over every byte value
// and over random lengths; and for each consumer whose own encoder it
// replaces, node's createHash or Buffer gives what it must still write.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import { bytesToHex } from '../../packages/platform/src/hex.ts';
import { hex as contentKeyHex } from '../../packages/core/src/vfs/content-chunking.ts';
import { sha256Hex } from '../../packages/core/src/_shared/crypto.ts';
import { runtimeCodeKey } from '../../packages/core/src/_shared/commonjs-cell.ts';
import { runtimeCodeKeySource } from '../../packages/core/src/_shared/runtime-code-identity.ts';
import { createPortCapability } from '../../packages/core/src/runtime/port-registry.ts';
import { facetImageDigest } from '../../packages/fabric/src/process-fabric.ts';
import { oidToHex } from '../../packages/worker/src/git/pack/format.ts';
import { npxCacheDir } from '../../packages/worker/src/npm/npx-install.ts';

const every = Uint8Array.from({ length: 256 }, (_, byte) => byte);
const samples = [new Uint8Array(0), every, ...Array.from({ length: 64 }, (_, n) => new Uint8Array(randomBytes(n + 1)))];
const nodeHex = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');

/** Each sample, and a window of it, as `encode` spells it, against node's. */
function matchesNode(label, encode) {
  for (const bytes of samples) {
    assert.equal(encode(bytes), nodeHex(bytes), `${label}: ${bytes.length} bytes`);
    if (bytes.length > 2) assert.equal(encode(bytes.subarray(1, bytes.length - 1)), nodeHex(bytes.subarray(1, bytes.length - 1)), `${label}: a window`);
  }
}

matchesNode('bytesToHex', bytesToHex);
// The table, where the runtime has no native encoder: a fresh module with it removed.
const native = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toHex');
if (native) delete Uint8Array.prototype.toHex;
try {
  const { bytesToHex: tableHex } = await import('../../packages/platform/src/hex.ts?table');
  matchesNode('bytesToHex by its table', tableHex);
} finally {
  if (native) Object.defineProperty(Uint8Array.prototype, 'toHex', native);
}
console.log(`  ok  bytesToHex (${native ? 'native and' : 'no native;'} table) is node's hex`);

// The consumers, each as it spelled its value before.
assert.equal(contentKeyHex, bytesToHex, 'a content key is spelled by the platform\'s encoder');
const text = 'an image ✓';
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
assert.equal(await sha256Hex(text), sha256(text), 'sha256Hex');
assert.equal(await facetImageDigest(text), sha256(text), 'facetImageDigest of a string');
assert.equal(await facetImageDigest(new TextEncoder().encode(text)), sha256(text), 'facetImageDigest of its bytes');
const framed = new TextEncoder().encode(`[${text}]`);
assert.equal(await facetImageDigest(framed.subarray(1, framed.length - 1)), sha256(text), 'facetImageDigest of a view into larger bytes');
const entry = { kind: 'expression', code: '1 + 1' };
assert.equal(runtimeCodeKey(entry), sha256(new TextEncoder().encode(runtimeCodeKeySource(entry))), 'runtimeCodeKey');
const pack = new Uint8Array(randomBytes(70));
assert.equal(oidToHex(pack), nodeHex(pack.subarray(0, 20)), 'oidToHex at 0');
assert.equal(oidToHex(pack, 37), nodeHex(pack.subarray(37, 57)), 'oidToHex inside a buffer');
const specs = ['b@1', 'a@2'];
const npx = await npxCacheDir(specs);
assert.equal(npx.slice(npx.lastIndexOf('/') + 1), createHash('sha512').update('a@2\nb@1').digest('hex').slice(0, 16), 'npxCacheDir: the first 8 bytes of its SHA-512');
assert.match(createPortCapability(), /^[0-9a-f]{24}$/, 'a port capability is 12 random bytes');
console.log('  ok  every consumer spells what it spelled');

console.log('hex-encoding: ok');
