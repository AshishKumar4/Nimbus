/**
 * git/pack/index-file.ts — the git index (Documentation/gitformat-index.txt),
 * version 2, as a fresh checkout writes it: one stage-0 entry per path,
 * sorted by path bytes, each carrying the stat the session reports for the
 * file, so `git status` finds every entry clean without reading a byte.
 */

import { createHash } from 'node:crypto';

import { OID_BYTES } from './format.js';

/** What the session's stat says of a checked-out path (the wave writer's receipt). */
export interface IndexStat {
  ctimeMs: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  uid: number;
  gid: number;
  size: number;
}

const ZERO_STAT: IndexStat = { ctimeMs: 0, mtimeMs: 0, dev: 0, ino: 0, uid: 0, gid: 0, size: 0 };
const ENTRY_FIXED_BYTES = 62;
const encoder = new TextEncoder();

/**
 * One entry, padded: 62 fixed bytes, the path, then 1-8 NULs so the entry's
 * length is a multiple of 8. `stat` is null for a gitlink, whose stat git
 * never compares.
 */
export function encodeIndexEntry(path: string, mode: number, oid: Uint8Array, stat: IndexStat | null): Uint8Array {
  const name = encoder.encode(path);
  const length = Math.ceil((ENTRY_FIXED_BYTES + name.byteLength + 1) / 8) * 8;
  const entry = new Uint8Array(length);
  const view = new DataView(entry.buffer);
  const s = stat ?? ZERO_STAT;
  const u32 = (at: number, value: number): void => view.setUint32(at, Math.floor(value) % 0x100000000);
  u32(0, s.ctimeMs / 1000);
  u32(4, (Math.floor(s.ctimeMs) % 1000) * 1e6);
  u32(8, s.mtimeMs / 1000);
  u32(12, (Math.floor(s.mtimeMs) % 1000) * 1e6);
  u32(16, s.dev);
  u32(20, s.ino);
  u32(24, mode);
  u32(28, s.uid);
  u32(32, s.gid);
  u32(36, s.size);
  entry.set(oid.subarray(0, OID_BYTES), 40);
  view.setUint16(60, Math.min(name.byteLength, 0xfff));
  entry.set(name, ENTRY_FIXED_BYTES);
  return entry;
}

function entryPath(entry: Uint8Array): Uint8Array {
  const length = new DataView(entry.buffer, entry.byteOffset + 60, 2).getUint16(0) & 0xfff;
  if (length < 0xfff) return entry.subarray(ENTRY_FIXED_BYTES, ENTRY_FIXED_BYTES + length);
  const end = entry.indexOf(0, ENTRY_FIXED_BYTES);
  return entry.subarray(ENTRY_FIXED_BYTES, end);
}

function comparePaths(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.byteLength - b.byteLength;
}

/** The index file for `entries` (encodeIndexEntry's), in any order; a repeated path is refused. */
export function encodeIndex(entries: Uint8Array[]): Uint8Array {
  const keyed = entries.map((entry) => ({ entry, path: entryPath(entry) }));
  keyed.sort((a, b) => comparePaths(a.path, b.path));
  let size = 12;
  for (let i = 0; i < keyed.length; i++) {
    if (i > 0 && comparePaths(keyed[i - 1].path, keyed[i].path) === 0) {
      throw new Error('git index: path ' + new TextDecoder().decode(keyed[i].path) + ' appears twice');
    }
    size += keyed[i].entry.byteLength;
  }
  const out = new Uint8Array(size + OID_BYTES);
  const view = new DataView(out.buffer);
  out.set(encoder.encode('DIRC'));
  view.setUint32(4, 2);
  view.setUint32(8, keyed.length);
  let at = 12;
  for (const { entry } of keyed) {
    out.set(entry, at);
    at += entry.byteLength;
  }
  out.set(createHash('sha1').update(out.subarray(0, size)).digest(), size);
  return out;
}

/** Concatenated entries, as a batch stores its share of the index until the last batch lands. */
export function splitIndexEntries(bytes: Uint8Array): Uint8Array[] {
  const entries: Uint8Array[] = [];
  let at = 0;
  while (at < bytes.byteLength) {
    const path = entryPath(bytes.subarray(at));
    const length = Math.ceil((ENTRY_FIXED_BYTES + path.byteLength + 1) / 8) * 8;
    entries.push(bytes.subarray(at, at + length));
    at += length;
  }
  return entries;
}
