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
//   - an archive that ends inside a member (its data or its padding) is
//     truncated, after the entries before it, as GNU tar ("Unexpected EOF in
//     archive") and node-tar (TAR_BAD_ARCHIVE) find it: the shell gets that
//     member's whole blocks, as GNU tar extracts them; one that ends between
//     members, a short header included, is whole, as both find it;
//   - the decoder's private names stay its own beside W7's, as the npm
//     facet concatenates their preambles.
import assert from 'node:assert/strict';
import {
  MAX_FILE_BYTES, parseTarHeader, streamTarEntries, streamTarRecords, tarBytes, TarTruncatedError,
} from '../../packages/core/src/_shared/tarball-stream.ts';
import { createTar, parseTar } from '../../packages/core/src/substrate/lifo/utils/archive.ts';
import { TAR_STREAM_PREAMBLE, W7_FRAME_PREAMBLE } from '../../packages/worker/src/loaders/generated-workers.ts';
import { ustarArchive, ustarHeader } from './lib/ustar.mjs';

const enc = new TextEncoder();


const deep = `${'d'.repeat(70)}/${'e'.repeat(70)}`; // 141 bytes: over a name's 100, within a prefix's 155

// ── the header ──
{
  const h = parseTarHeader(ustarHeader({ name: 'é/ü.txt', prefix: deep, size: 5, mode: 0o755, mtime: 1_700_000_000 }));
  assert.deepEqual(h, { name: `${deep}/é/ü.txt`, size: 5, typeFlag: 48, mode: 0o755, mtime: 1_700_000_000, directory: false });
  assert.equal(parseTarHeader(ustarHeader({ name: 'dir/', type: '0' })).directory, true, 'a name ending in / is a directory');
  assert.equal(parseTarHeader(ustarHeader({ name: 'dir', type: '5' })).directory, true);
  assert.equal(parseTarHeader(ustarHeader({ name: '/etc/passwd' })).name, 'etc/passwd');
  assert.equal(parseTarHeader(ustarHeader({ name: '../escape' })).name, '');
  assert.equal(parseTarHeader(new Uint8Array(512)), null, 'a zero block ends the archive');
  // GNU's header ("ustar  \0") keeps atime and ctime where ustar's prefix is.
  const gnu = ustarHeader({ name: 'f.txt', magic: 'ustar ', version: ' \0', prefix: '14567012345\0' + '14567012346' });
  assert.equal(parseTarHeader(gnu).name, 'f.txt');
  assert.equal(parseTarHeader(ustarHeader({ name: '\uFEFFindex.js', prefix: 'package/lib' })).name, 'package/lib/\uFEFFindex.js');
  console.log('  [1] a header: prefix, UTF-8, canonical path, mode, mtime, directory');
}

// ── npm's policy ──
{
  const tar = ustarArchive([
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
  const big = ustarHeader({ name: 'package/big.wasm', size: MAX_FILE_BYTES + 1 });
  async function* stream() {
    yield big;
    const zeros = new Uint8Array(1 << 20);
    for (let left = MAX_FILE_BYTES + 1; left > 0; left -= zeros.length) yield zeros.subarray(0, Math.min(zeros.length, left));
    yield new Uint8Array((512 - ((MAX_FILE_BYTES + 1) % 512)) % 512);
    yield ustarArchive([{ name: 'package/after.js', data: enc.encode('after') }]);
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
  const tar = ustarArchive([
    { name: 'top', type: '5', mode: 0o750, mtime: 1_600_000_000 },
    { name: 'x.sh', prefix: `top/${'p'.repeat(120)}`, mode: 0o755, mtime: 1_600_000_001, data: enc.encode('#!/bin/sh\n') },
    { name: '/abs/f', data: enc.encode('abs') },
    { name: '../../escape', data: enc.encode('no') },
    { name: 'top/link', type: '2' },
    { name: 'ñ.txt', data: enc.encode('ñ') },
  ]);
  const { entries, truncated } = await parseTar(tar);
  assert.equal(truncated, false);
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
  assert.deepEqual(await parseTar(createTar(written)), { entries: written, truncated: false });
  // A header that claims more than the archive holds (8 GiB in 512 bytes): never buffered, and the archive is truncated.
  const huge = await parseTar(ustarHeader({ name: 'huge', size: 0o77777777777 }));
  assert.deepEqual([huge.truncated, huge.entries.map(({ path, data }) => [path, data.length])], [true, [['huge', 0]]]);
  const escaping = new Uint8Array(1024);
  escaping.set(ustarHeader({ name: '../../outside', size: 0o77777777777 }), 0);
  assert.deepEqual(await parseTar(escaping), { entries: [], truncated: true }, 'an entry it leaves out is never buffered');
  console.log('  [3] shell: directories and files with mode and mtime, long and UTF-8 paths, inside the archive root');
}

// ── the walker reads only what its policy asks for ──
{
  const tar = ustarArchive([{ name: 'a', data: enc.encode('aa') }, { name: 'b', data: enc.encode('bb') }]);
  const records = [];
  for await (const { header: h, data } of streamTarRecords(tarBytes(tar), (h) => h.name === 'b')) records.push([h.name, data && new TextDecoder().decode(data)]);
  assert.deepEqual(records, [['a', null], ['b', 'bb']]);
  console.log('  [4] streamTarRecords: every entry, its bytes only when asked for');
}

// ── an archive that ends inside a member is truncated; one that ends between members is not ──
{
  const big = new Uint8Array(3000).map((_, i) => i % 251);
  const full = ustarArchive([{ name: 'a.txt', data: enc.encode('first\n') }, { name: 'b.bin', data: big }, { name: 'c.txt', data: enc.encode('third\n') }]);
  /** What streamTarRecords yields of the first `length` bytes, every entry read, and how it ends. */
  const walk = async (length, chunk = length) => {
    const yielded = [];
    const source = async function* () { for (let at = 0; at < length; at += chunk) yield full.subarray(at, Math.min(length, at + chunk)); };
    try {
      for await (const { header: h } of streamTarRecords(source(), () => true)) yielded.push(h.name);
      return { yielded, ended: 'whole' };
    } catch (error) {
      assert.ok(error instanceof TarTruncatedError, String(error));
      return { yielded, ended: [error.header.name, error.received, error.data.length] };
    }
  };
  // Inside b.bin's data, in one chunk and in odd-sized chunks: GNU tar 1.35 and node-tar 7.5 call both truncated.
  assert.deepEqual(await walk(1600), { yielded: ['a.txt'], ended: ['b.bin', 64, 0] });
  assert.deepEqual(await walk(1600, 77), { yielded: ['a.txt'], ended: ['b.bin', 64, 0] });
  assert.deepEqual(await walk(2636), { yielded: ['a.txt'], ended: ['b.bin', 1100, 1024] }, 'its whole blocks are what GNU tar extracts of it');
  // Inside a.txt's padding: its data is all there, and it is still truncated, as both tars find.
  assert.deepEqual(await walk(518), { yielded: [], ended: ['a.txt', 6, 0] });
  // Between members: at a header boundary, and inside the next header. Both tars list a.txt and succeed.
  assert.deepEqual(await walk(1024), { yielded: ['a.txt'], ended: 'whole' });
  assert.deepEqual(await walk(1100), { yielded: ['a.txt'], ended: 'whole' });
  // npm's walk ends the same way: the entries before, then the error.
  const npm = [];
  const failure = await (async () => {
    try { for await (const { name } of streamTarEntries(tarBytes(full.subarray(0, 1600)))) npm.push(name); return null; } catch (error) { return error; }
  })();
  assert.deepEqual([npm, failure instanceof TarTruncatedError], [['a.txt'], true]);
  // The shell's: what came before, and the truncated member's whole blocks.
  const shell = await parseTar(full.subarray(0, 2636));
  assert.deepEqual([shell.truncated, shell.entries.map(({ path, data }) => [path, data.length])], [true, [['a.txt', 6], ['b.bin', 1024]]]);
  assert.deepEqual(shell.entries[1].data, big.subarray(0, 1024));
  console.log('  [5] truncation: inside a member\'s data or padding is an error after the entries before it; between members is not');
}

// ── the generated preamble beside W7's, as the npm facet concatenates them ──
{
  const facet = new Function(`${TAR_STREAM_PREAMBLE}\n${W7_FRAME_PREAMBLE}\nreturn { streamTarEntries, tarBytes, privateNames: [typeof PATH_DECODER, typeof tarField, typeof UTF8] };`)();
  assert.deepEqual(facet.privateNames, ['undefined', 'undefined', 'undefined'], 'no preamble\'s private names reach the module scope');
  // A link record whose name is not UTF-8: skipped by npm's policy, not a failed package.
  const tar = ustarArchive([
    { name: '', raw: Uint8Array.of(0x70, 0x2f, 0xe9), type: '2' },
    { name: 'package/a.js', data: enc.encode('a') },
  ]);
  const names = [];
  for await (const { name } of facet.streamTarEntries(facet.tarBytes(tar))) names.push(name);
  assert.deepEqual(names, ['package/a.js']);
  console.log('  [6] the decoder\'s preamble keeps its names its own beside W7\'s');
}

console.log('tar-decoder OK');
