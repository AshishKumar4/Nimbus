// npm package tarballs for install tests: a gzipped ustar archive of the
// given files, in the given order, its SRI, and a decoder for the
// write-batch wave an install streams to the session.

import { gzipSync } from 'node:zlib';
import { decodeWriteBatchStream } from '../../../packages/platform/src/w7-frame.ts';

function octal(value, width) {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function tarFile(name, text) {
  const data = new TextEncoder().encode(text);
  const header = new Uint8Array(512);
  const write = (offset, value, width) => {
    header.set(new TextEncoder().encode(value).subarray(0, width), offset);
  };
  write(0, name, 100);
  write(100, octal(0o644, 8), 8);
  write(108, octal(0, 8), 8);
  write(116, octal(0, 8), 8);
  write(124, octal(data.length, 12), 12);
  write(136, octal(0, 12), 12);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  write(257, 'ustar\0', 6);
  write(263, '00', 2);
  write(148, octal(header.reduce((sum, byte) => sum + byte, 0), 8), 8);
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return [header, padded];
}

/**
 * A gzipped tarball of `files`: path inside the archive (e.g.
 * `package/index.js`) → text, as an object or as [path, text] pairs, entries
 * in the order given. Pairs can name one path twice, as real tarballs do.
 */
export function packageTarball(files) {
  const entries = Array.isArray(files) ? files : Object.entries(files);
  const parts = [
    ...entries.flatMap(([name, text]) => tarFile(name, text)),
    new Uint8Array(1024),
  ];
  const tar = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    tar.set(part, offset);
    offset += part.length;
  }
  return new Uint8Array(gzipSync(tar));
}

/** The registry `dist.integrity` of `bytes`. */
export async function sriOf(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', bytes));
  let bin = '';
  for (const byte of digest) bin += String.fromCharCode(byte);
  return `sha512-${btoa(bin)}`;
}

/** The paths a write-batch wave creates and its file-chunk count, retentions released. */
export async function decodeWave(stream) {
  const decoded = await decodeWriteBatchStream(stream);
  const paths = [];
  let chunks = 0;
  for await (const record of decoded.records) {
    if (record.type === 'directory' || record.type === 'file-begin') {
      paths.push(record.inode.path);
    } else if (record.type === 'file-chunk') {
      chunks++;
      record.retention.release();
    }
  }
  return { paths, chunks };
}
