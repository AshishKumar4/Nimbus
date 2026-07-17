#!/usr/bin/env bun
// npm-tar-entry-canonical — the tar parser must canonicalize entry paths.
// npm tarballs legitimately carry entries like "./dist/index.js"
// (agent-base, http-proxy-agent, protobufjs, ...). Left as "./dist/..",
// the noncanonical path survives into the VFS write and the w7-frame
// writer rejects it, failing the WHOLE shared install wave and dropping
// the completion markers of every shard-mate — which is why pi's own
// dist/cli.js never landed and `pi: command not found` followed a
// "successful" install.

import assert from 'node:assert/strict';
import { canonicalTarName, streamTarEntries, parseTarHeader } from '../../packages/worker/src/npm/tarball-stream.ts';

// ── canonicalTarName: collapse ./ and .. ; reject root escapes ──────────
assert.equal(canonicalTarName('dist/index.js'), 'dist/index.js');
assert.equal(canonicalTarName('./dist/index.js'), 'dist/index.js');
assert.equal(canonicalTarName('dist/./cli.js'), 'dist/cli.js');
assert.equal(canonicalTarName('dist/../lib/x.js'), 'lib/x.js'); // interior .. stays in-root
assert.equal(canonicalTarName('package.json'), 'package.json');
assert.equal(canonicalTarName('a//b'), 'a/b');
// Escapes package root → '' (caller skips as no-name).
assert.equal(canonicalTarName('../evil.js'), '');
assert.equal(canonicalTarName('../../etc/passwd'), '');
assert.equal(canonicalTarName('dist/../../escape.js'), '');

// ── streamTarEntries: a "./dist/…" entry yields a canonical name ────────
// Build a minimal ustar archive with two regular-file entries.
function tarHeader(name, size) {
  const buf = new Uint8Array(512);
  const enc = new TextEncoder();
  buf.set(enc.encode(name).slice(0, 100), 0);
  buf.set(enc.encode('0000644\0'), 100); // mode
  buf.set(enc.encode('0000000\0'), 108); // uid
  buf.set(enc.encode('0000000\0'), 116); // gid
  const sizeOctal = size.toString(8).padStart(11, '0') + '\0';
  buf.set(enc.encode(sizeOctal), 124);
  buf.set(enc.encode('00000000000\0'), 136); // mtime
  buf[156] = 48; // typeflag '0' — regular file
  buf.set(enc.encode('ustar\0'), 257);
  buf.set(enc.encode('00'), 263);
  // checksum: spaces during compute, then written octal
  for (let i = 148; i < 156; i++) buf[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);
  return buf;
}
function fileBlock(data) {
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return padded;
}
function buildTar(entries) {
  const enc = new TextEncoder();
  const parts = [];
  for (const [name, content] of entries) {
    const data = enc.encode(content);
    parts.push(tarHeader(name, data.length));
    parts.push(fileBlock(data));
  }
  parts.push(new Uint8Array(1024)); // two zero blocks = end
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// Sanity: parseTarHeader canonicalizes on its own.
{
  const h = parseTarHeader(tarHeader('package/./dist/index.js', 3));
  assert.equal(h.name, 'dist/index.js', 'parseTarHeader strips package/ and collapses ./');
}

const tar = buildTar([
  ['package/./dist/cli.js', 'cli'],
  ['package/package.json', '{"name":"x"}'],
]);
async function* once(b) { yield b; }
const names = [];
for await (const e of streamTarEntries(once(tar))) names.push(e.name);
assert.deepEqual(names.sort(), ['dist/cli.js', 'package.json'], 'entries are canonical, no "./" survives');
for (const n of names) assert.ok(!n.includes('/./') && !n.startsWith('./'), `canonical: ${n}`);

console.log('npm-tar-entry-canonical: ok');
