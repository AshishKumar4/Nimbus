#!/usr/bin/env bun
// A mutation the session refused is the filesystem answering the call, and a
// program that catches it has handled it; one whose outcome is unknown is a
// durability failure whatever the program caught, and surfaces when the
// process's writes are drained. Which is which is one policy, the syscall
// verdicts (vfs-error.ts SYSCALL_VERDICTS), for the process's filesystem
// client and the write ledger alike.
//
// Red before: the ledger kept its own list, which lacked EXDEV, ENOTSUP,
// ENXIO and E2BIG, so a caught cross-device rename (a move between mounts,
// which `mv` and npm fall back from) failed the process's drain as though its
// bytes were lost.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SHIMS_STORE_PRELUDE, declareNamespace } from './lib/shims-namespace.mjs';
import { waveSupervisor } from './lib/wave-supervisor.mjs';

/** A node process whose session refuses its rename of /home/user/app with `code`. */
function processRefusing(code) {
  const supervisor = waveSupervisor({
    async writeFile() {},
    async mkdir() {},
    async rename(from, to) {
      throw Object.assign(new Error(`${code}: refused, rename '${from}' -> '${to}'`), { code });
    },
  });
  const factory = new Function(
    '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    `"use strict";${VFS_WRITE_LEDGER_SOURCE}\n${SHIMS_STORE_PRELUDE + generateShimsCode()}
;return { fs: builtins.fs, drain: () => __nimbusDrainVfsMutations() };`,
  );
  const metadata = {
    'home/user': { type: 'directory', size: 0, mode: 0o40755, uid: 1000, gid: 1000 },
    'home/user/app': { type: 'directory', size: 0, mode: 0o40755, uid: 1000, gid: 1000 },
  };
  declareNamespace({ metadata, manifest: { 'home/user': ['app'], 'home/user/app': [] } });
  return factory(
    {}, {}, supervisor, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
  );
}

for (const code of ['EXDEV', 'ENOTSUP', 'ENXIO', 'E2BIG', 'ENOENT']) {
  const { fs, drain } = processRefusing(code);
  await assert.rejects(fs.promises.rename('/home/user/app', '/home/user/moved'), (error) => error.code === code, `${code}: the caller hears the refusal`);
  await drain();
  console.log(`  ${code}: a caught refusal is the call's answer, not a lost write`);
}

{
  const { fs, drain } = processRefusing('EIO');
  await assert.rejects(fs.promises.rename('/home/user/app', '/home/user/moved'), (error) => error.code === 'EIO');
  await assert.rejects(drain(), (error) => error.code === 'EIO', 'an unknown outcome surfaces at the drain, caught or not');
  console.log('  EIO: a caught failure of unknown outcome still surfaces');
}

console.log('node-caught-refusal-durability: ok');
