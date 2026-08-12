#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { WASI_INSTANCE_PREAMBLE_SRC } from '../../packages/core/src/runtime/wasi-instance.ts';
import { makeImportsWithoutJSPI } from './lib/wasi-imports.mjs';

const ESUCCESS = 0;
const EACCES = 2;
const ENOENT = 44;
const O_DIRECTORY = 2;
const RIGHT_FD_READ = 1n << 1n;

const preamblePath = path.join(os.tmpdir(), `wasi-snapshot-permissions-${process.pid}.mjs`);
writeFileSync(
  preamblePath,
  `${WASI_INSTANCE_PREAMBLE_SRC}\nexport { __wasiInitFS, __wasiMakeImports };`,
);

let preamble;
try {
  preamble = await import(pathToFileURL(preamblePath).href);
} finally {
  rmSync(preamblePath, { force: true });
}

const encoder = new TextEncoder();

function host(snapshot) {
  preamble.__wasiInitFS({
    root: 'home/user',
    preopens: [{ wasiPath: '/', vfsPath: 'home/user' }],
    files: snapshot.files ?? {},
    dirs: snapshot.dirs ?? ['home/user'],
    modes: snapshot.modes,
  });

  const memory = new WebAssembly.Memory({ initial: 2 });
  const wasi = makeImportsWithoutJSPI(preamble, {
    argv: ['probe'],
    env: {},
    getMemory: () => memory,
  }).wasiImport;
  const bytes = () => new Uint8Array(memory.buffer);
  const view = () => new DataView(memory.buffer);
  let bump = 4096;
  const alloc = (length) => {
    const pointer = bump;
    bump += (length + 7) & ~7;
    return pointer;
  };
  const putPath = (value) => {
    const encoded = encoder.encode(value);
    const pointer = alloc(encoded.length);
    bytes().set(encoded, pointer);
    return [pointer, encoded.length];
  };

  return { wasi, view, alloc, putPath };
}

{
  const h = host({
    files: { 'home/user/secret.txt': btoa('secret') },
    modes: {
      'home/user': 0o7,
      'home/user/secret.txt': 0o0,
    },
  });
  const [secretPtr, secretLen] = h.putPath('secret.txt');
  const fdOut = h.alloc(4);
  assert.equal(
    h.wasi.path_open(3, 0, secretPtr, secretLen, 0, RIGHT_FD_READ, 0n, 0, fdOut),
    EACCES,
    'a present file without effective read permission must fail path_open with EACCES',
  );

  const [missingPtr, missingLen] = h.putPath('missing.txt');
  assert.equal(
    h.wasi.path_open(3, 0, missingPtr, missingLen, 0, RIGHT_FD_READ, 0n, 0, fdOut),
    ENOENT,
    'an absent file must remain ENOENT rather than becoming a permission denial',
  );

  const [nestedMissingPtr, nestedMissingLen] = h.putPath('absent/child.txt');
  assert.equal(
    h.wasi.path_open(3, 0, nestedMissingPtr, nestedMissingLen, 0, RIGHT_FD_READ, 0n, 0, fdOut),
    ENOENT,
    'a missing ancestor must remain ENOENT when no present ancestor denies traversal',
  );
}

{
  const h = host({
    files: { 'home/user/metadata.txt': btoa('metadata') },
    modes: {
      'home/user': 0o7,
      'home/user/metadata.txt': 0o0,
    },
  });
  const [pathPtr, pathLen] = h.putPath('metadata.txt');
  assert.equal(
    h.wasi.path_filestat_get(3, 0, pathPtr, pathLen, h.alloc(64)),
    ESUCCESS,
    'path_filestat_get needs traversal permission but no read permission on the leaf',
  );
}

{
  const h = host({
    dirs: ['home/user', 'home/user/locked'],
    files: { 'home/user/locked/present.txt': btoa('present') },
    modes: {
      'home/user': 0o7,
      'home/user/locked': 0o6,
      'home/user/locked/present.txt': 0o7,
    },
  });
  const statOut = h.alloc(64);
  const [presentPtr, presentLen] = h.putPath('locked/present.txt');
  assert.equal(
    h.wasi.path_filestat_get(3, 0, presentPtr, presentLen, statOut),
    EACCES,
    'path_filestat_get must reject a present leaf below an untraversable directory',
  );

  const [missingPtr, missingLen] = h.putPath('locked/missing.txt');
  assert.equal(
    h.wasi.path_filestat_get(3, 0, missingPtr, missingLen, statOut),
    EACCES,
    'ancestor traversal denial must take precedence over a missing leaf',
  );
}

{
  const h = host({
    dirs: ['home/user', 'home/user/listable'],
    files: { 'home/user/listable/child.txt': btoa('child') },
    modes: {
      'home/user': 0o7,
      'home/user/listable': 0o1,
      'home/user/listable/child.txt': 0o7,
    },
  });
  const [dirPtr, dirLen] = h.putPath('listable');
  const fdOut = h.alloc(4);
  assert.equal(
    h.wasi.path_open(3, 0, dirPtr, dirLen, O_DIRECTORY, 0n, 0n, 0, fdOut),
    ESUCCESS,
    'opening a traversable directory without read rights should produce a directory fd',
  );
  const dirFd = h.view().getUint32(fdOut, true);
  assert.equal(
    h.wasi.fd_readdir(dirFd, h.alloc(256), 256, 0n, h.alloc(4)),
    EACCES,
    'fd_readdir must require effective read permission on the directory',
  );
}

console.log('wasi snapshot permissions: ok');
