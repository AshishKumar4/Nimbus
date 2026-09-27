#!/usr/bin/env bun
// An endless device (/dev/zero) read by the workspace shell's commands: a
// reader that stops on its own (head -c N) or a pipe whose reader closes it
// (cat | head) streams it; a copy nothing can end (cat into a file) is refused
// by the device's own whole-read answer instead of writing until the store is
// full (shell/compat/r3/new/dev-null-mount on real infrastructure).
//
// The store is capped at 1 MiB, so the pre-fix copy ends (ENOSPC) instead of
// running for the 10 GB a session holds: it wrote megabytes of zeros and
// failed for the wrong reason.

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { testBox } from './lib/test-box.mjs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { registerUnixCommands } from '../../packages/core/src/shell/unix-commands.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx, undefined, { storageLimit: 1024 * 1024, storageKernelReserve: 0 });
const root = rawVfs.as(CRED_KERNEL);
root.mkdir('tmp', { mode: 0o777 });
root.chown('tmp', 1000, 1000);
const box = await testBox({ harness, vfs: rawVfs });
registerUnixCommands(box.commands.registry, rawVfs);
const sh = (line) => box.shell.execute(line, {});

// The probe's command: nothing reads the file, so nothing could end the copy.
let r = await sh('cat /dev/zero > /tmp/zeros; echo RC=$?');
assert.equal(r.stdout, 'RC=1\n', `cat of an endless device into a file fails: ${JSON.stringify(r)}`);
assert.match(r.stderr, /^cat: \/dev\/zero: .*without end/, 'and says why');
assert.equal(root.stat('tmp/zeros').size, 0, 'having written nothing');

// A bounded reader, into a file or a pipe.
r = await sh('head -c 65536 /dev/zero > /tmp/h; wc -c < /tmp/h; head -c 65536 /dev/zero | wc -c');
assert.equal(r.stdout, '65536\n65536\n', JSON.stringify(r));

// Into a pipe the reader ends the copy, directly or through a group.
r = await sh('cat /dev/zero | head -c 100000 | wc -c; { cat /dev/zero; } | head -c 7 | wc -c');
assert.equal(r.stdout, '100000\n7\n', JSON.stringify(r));
assert.equal(r.stderr, '', 'silently, as SIGPIPE ends it');

// An empty device is read whole, as before.
r = await sh('cat /dev/null; echo RC=$?');
assert.equal(r.stdout, 'RC=0\n', JSON.stringify(r));

console.log('shell-endless-device: ok');
