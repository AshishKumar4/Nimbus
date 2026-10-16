// npm package tarballs for install tests: a gzipped ustar archive of the
// given files, in the given order, its SRI, and a decoder for the
// write-batch wave an install streams to the session.

import { gzipSync } from 'node:zlib';
import { decodeWriteBatchStream } from '../../../packages/platform/src/w7-frame.ts';
import { ustarArchive } from './ustar.mjs';

/**
 * A gzipped tarball of `files`: path inside the archive (e.g.
 * `package/index.js`) → text, as an object or as [path, text] pairs, entries
 * in the order given. Pairs can name one path twice, as real tarballs do.
 */
export function packageTarball(files) {
  const entries = Array.isArray(files) ? files : Object.entries(files);
  return new Uint8Array(gzipSync(ustarArchive(entries.map(([name, text]) => ({ name, data: new TextEncoder().encode(text) })))));
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
