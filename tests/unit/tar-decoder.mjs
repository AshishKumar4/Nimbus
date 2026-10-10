#!/usr/bin/env bun
// tar-decoder — one tar decoder (tarball-stream.ts) under npm's, the shell's
// and clang's extraction policies.
//
//   - a header's path joins its USTAR prefix field, decodes as UTF-8, and is
//     canonical; mode, mtime and whether it is a directory come with it;
//   - npm's entries are regular files under the size cap, and a skipped
//     entry that carries bytes is reported once, with its reason;
//   - the shell's entries are every directory and file (its policy for any
//     other type: the entry's bytes as a file), with mode and mtime, and an
//     entry outside the archive's root (absolute, or escaping by `..`) is
//     extracted under it or left out, as GNU tar does;
//   - only a POSIX ustar header has a name prefix (GNU's keeps times there),
//     a leading U+FEFF is part of a name, and an entry that claims more bytes
//     than the archive holds is never buffered;
//   - the decoder's private names stay its own beside W7's, as the npm
//     facet concatenates their preambles.
import assert from 'node:assert/strict';
import {
  MAX_FILE_BYTES, parseTarHeader, streamTarEntries, streamTarRecords, tarBytes,
} from '../../packages/core/src/_shared/tarball-stream.ts';
import { createTar, parseTar } from '../../packages/core/src/substrate/lifo/utils/archive.ts';
import { TAR_STREAM_PREAMBLE, W7_FRAME_PREAMBLE } from '../../packages/worker/src/loaders/generated-workers.ts';

const enc = new TextEncoder();

/** One USTAR header block. */
function header({ name, prefix = '', size = 0, type = '0', mode = 0o644, mtime = 0, magic = 'ustar\0', version = '00', raw = null }) {
  const block = new Uint8Array(512);
  const put = (text, at, length) => block.set(enc.encode(text).slice(0, length), at);
  const octal = (value, at, length) => put(value.toString(8).padStart(length - 1, '0') + '\0', at, length);
  if (raw) block.set(raw.slice(0, 100), 0);
  else put(name, 0, 100);
  octal(mode, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(mtime, 136, 12);
  block[156] = type.charCodeAt(0);
  put(magic, 257, 6);
  put(version, 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i];
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return block;
}

/** An archive of `entries`, each a header's fields and its bytes. */
function archive(entries) {
  const parts = [];
  for (const { data = new Uint8Array(0), ...fields } of entries) {
    parts.push(header({ size: data.length, ...fields }));
    if (data.length > 0) {
      const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
      padded.set(data);
      parts.push(padded);
    }
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const deep = `${'d'.repeat(70)}/${'e'.repeat(70)}`; // 141 bytes: over a name's 100, within a prefix's 155

// ── the header ──
{
  const h = parseTarHeader(header({ name: 'é/ü.txt', prefix: deep, size: 5, mode: 0o755, mtime: 1_700_000_000 }));
  assert.deepEqual(h, { name: `${deep}/é/ü.txt`, size: 5, typeFlag: 48, mode: 0o755, mtime: 1_700_000_000, directory: false });
  assert.equal(parseTarHeader(header({ name: 'dir/', type: '0' })).directory, true, 'a name ending in / is a directory');
  assert.equal(parseTarHeader(header({ name: 'dir', type: '5' })).directory, true);
  assert.equal(parseTarHeader(header({ name: '/etc/passwd' })).name, 'etc/passwd');
  assert.equal(parseTarHeader(header({ name: '../escape' })).name, '');
  assert.equal(parseTarHeader(new Uint8Array(512)), null, 'a zero block ends the archive');
  // GNU's header ("ustar  \0") keeps atime and ctime where ustar's prefix is.
  const gnu = header({ name: 'f.txt', magic: 'ustar ', version: ' \0', prefix: '14567012345\0' + '14567012346' });
  assert.equal(parseTarHeader(gnu).name, 'f.txt');
  assert.equal(parseTarHeader(header({ name: '\uFEFFindex.js', prefix: 'package/lib' })).name, 'package/lib/\uFEFFindex.js');
  console.log('  [1] a header: prefix, UTF-8, canonical path, mode, mtime, directory');
}

// ── npm's policy ──
{
  const tar = archive([
    { name: 'package/', type: '5' },
    { name: 'package/link', type: '2' },
    { name: 'package/PaxHeaders/x', type: 'x', data: enc.encode('30 path=package/long\n') },
    { name: '../evil.js', data: enc.encode('x') },
    { name: 'package/a.js', data: enc.encode('a') },
    { name: 'package/empty' },
    { name: 'é.js', prefix: 'package', data: enc.encode('é') },
  ]);
  const skips = [];
  const seen = [];
  for await (const { name, data } of streamTarEntries(tarBytes(tar), (...skip) => skips.push(skip))) seen.push([name, new TextDecoder().decode(data)]);
  assert.deepEqual(seen, [['package/a.js', 'a'], ['package/empty', ''], ['package/é.js', 'é']]);
  assert.deepEqual(skips, [['package/PaxHeaders/x', 21, 'non-regular'], ['', 1, 'no-name']], 'reported once each, only the skips that carry bytes');

  // Over the cap: reported, its bytes never held.
  const big = header({ name: 'package/big.wasm', size: MAX_FILE_BYTES + 1 });
  async function* stream() {
    yield big;
    const zeros = new Uint8Array(1 << 20);
    for (let left = MAX_FILE_BYTES + 1; left > 0; left -= zeros.length) yield zeros.subarray(0, Math.min(zeros.length, left));
    yield new Uint8Array((512 - ((MAX_FILE_BYTES + 1) % 512)) % 512);
    yield archive([{ name: 'package/after.js', data: enc.encode('after') }]);
  }
  const bigSkips = [];
  const after = [];
  for await (const { name } of streamTarEntries(stream(), (...skip) => bigSkips.push(skip))) after.push(name);
  assert.deepEqual(bigSkips, [['package/big.wasm', MAX_FILE_BYTES + 1, 'too-large']]);
  assert.deepEqual(after, ['package/after.js']);
  console.log('  [2] npm: regular files under the cap; each skip with bytes reported with its reason');
}

// ── the shell's policy ──
{
  const tar = archive([
    { name: 'top', type: '5', mode: 0o750, mtime: 1_600_000_000 },
    { name: 'x.sh', prefix: `top/${'p'.repeat(120)}`, mode: 0o755, mtime: 1_600_000_001, data: enc.encode('#!/bin/sh\n') },
    { name: '/abs/f', data: enc.encode('abs') },
    { name: '../../escape', data: enc.encode('no') },
    { name: 'top/link', type: '2' },
    { name: 'ñ.txt', data: enc.encode('ñ') },
  ]);
  const entries = await parseTar(tar);
  assert.deepEqual(entries.map(({ path, type, mode, mtime, data }) => [path, type, mode.toString(8), mtime, new TextDecoder().decode(data)]), [
    ['top', 'directory', '750', 1_600_000_000_000, ''],
    [`top/${'p'.repeat(120)}/x.sh`, 'file', '755', 1_600_000_001_000, '#!/bin/sh\n'],
    ['abs/f', 'file', '644', 0, 'abs'],
    ['top/link', 'file', '644', 0, ''],
    ['ñ.txt', 'file', '644', 0, 'ñ'],
  ]);

  // What the shell's own tar -c writes, it reads back.
  const written = [
    { path: 'd', data: new Uint8Array(0), type: 'directory', mode: 0o755, mtime: 1_500_000_000_000 },
    { path: 'd/f.txt', data: enc.encode('leaf'), type: 'file', mode: 0o600, mtime: 1_500_000_001_000 },
  ];
  assert.deepEqual(await parseTar(createTar(written)), written);
  // A header that claims more than the archive holds (8 GiB in 512 bytes): never buffered.
  const claims = archive([{ name: 'ok', data: enc.encode('ok') }]);
  const lying = new Uint8Array(claims.length + 512);
  lying.set(header({ name: 'huge', size: 0o77777777777 }), 0);
  lying.set(claims, 512);
  assert.deepEqual((await parseTar(lying.subarray(0, 512))).map((entry) => entry.path), []);
  const escaping = new Uint8Array(1024);
  escaping.set(header({ name: '../../outside', size: 0o77777777777 }), 0);
  assert.deepEqual(await parseTar(escaping), [], 'an entry it leaves out is never buffered');
  console.log('  [3] shell: directories and files with mode and mtime, long and UTF-8 paths, inside the archive root');
}

// ── the walker reads only what its policy asks for ──
{
  const tar = archive([{ name: 'a', data: enc.encode('aa') }, { name: 'b', data: enc.encode('bb') }]);
  const records = [];
  for await (const { header: h, data } of streamTarRecords(tarBytes(tar), (h) => h.name === 'b')) records.push([h.name, data && new TextDecoder().decode(data)]);
  assert.deepEqual(records, [['a', null], ['b', 'bb']]);
  console.log('  [4] streamTarRecords: every entry, its bytes only when asked for');
}

// ── the generated preamble beside W7's, as the npm facet concatenates them ──
{
  const facet = new Function(`${TAR_STREAM_PREAMBLE}\n${W7_FRAME_PREAMBLE}\nreturn { streamTarEntries, tarBytes, privateNames: [typeof PATH_DECODER, typeof tarField, typeof UTF8] };`)();
  assert.deepEqual(facet.privateNames, ['undefined', 'undefined', 'undefined'], 'no preamble\'s private names reach the module scope');
  // A link record whose name is not UTF-8: skipped by npm's policy, not a failed package.
  const tar = archive([
    { name: '', raw: Uint8Array.of(0x70, 0x2f, 0xe9), type: '2' },
    { name: 'package/a.js', data: enc.encode('a') },
  ]);
  const names = [];
  for await (const { name } of facet.streamTarEntries(facet.tarBytes(tar))) names.push(name);
  assert.deepEqual(names, ['package/a.js']);
  console.log('  [5] the decoder\'s preamble keeps its names its own beside W7\'s');
}

console.log('tar-decoder OK');
