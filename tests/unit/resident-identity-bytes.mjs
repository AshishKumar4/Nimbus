#!/usr/bin/env bun
// A resident's derived owner is `auto:` and the first 24 hex of SHA-256
// over its cwd, a NUL and its argv joined by NULs, as UTF-8 (a lone
// surrogate as U+FFFD): node:crypto, given the same string, is the oracle.
// An identity persists in journal rows and reservations, so not one byte of
// it may move when how it is computed does (audit SHI-13: through the shared
// sha256Hex).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deriveResidentOwner } from '../../packages/worker/src/facets/resident-identity.ts';

for (const [cwd, argv] of [
  ['/home/user', ['node', 'server.js']],
  ['/home/user/app', ['npx', 'vite', '--host', '--port', '5173']],
  ['/home/user', []],
  ['/home/user/café', ['node', 'naïve.js', '🙂']],
  ['/home/user', ['node', 'lone-\uD800-surrogate.js', 'and-\uDFFF']],
]) {
  const expected = `auto:${createHash('sha256').update(`${cwd}\0${argv.join('\0')}`, 'utf8').digest('hex').slice(0, 24)}`;
  assert.equal(await deriveResidentOwner(cwd, argv), expected, `${cwd} ${JSON.stringify(argv)}`);
}
console.log('ok - resident-identity-bytes (derived owners match node:crypto byte for byte, Unicode and lone surrogates included)');
