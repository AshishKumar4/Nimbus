#!/usr/bin/env bun
// A node program is not done until the host has made its last write: one
// that fails after the program's own code has run still reaches the
// program, as Node's stream error does, and still decides its status.
//
// The output is a file on a mount that refuses each write a while after it
// is made, as a remote store does: the program has long run out of code by
// then.
//
// Red before: the realm ended when the program's code did; the failure came
// after, reached nothing, and the program ended with 0.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { syscallError } from '../../packages/core/src/vfs/vfs-error.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

/** A mount with no synchronous face, holding files open; each write is refused 50 ms after it is made. */
class Refusing extends MemoryVFS {
  sync = undefined;
  openFile(path) {
    return {
      path: () => path,
      stat: () => this.stat(path),
      read: (offset, length) => this.readRange(path, offset, length),
      write: () => new Promise((_, reject) => setTimeout(() => reject(syscallError('EIO', 'write', path)), 50)),
      truncate: () => {},
      close: () => {},
    };
  }
}

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
ws.filesystem.vfs.mount('/slow', new Refusing({ uid: 1000, gid: 1000 }));
try {
  const unhandled = await ws.exec(`node -e 'process.stdout.write("x\\n")' > /slow/out; echo "status=$?"`, { cwd: '/home/user' });
  assert.equal(unhandled.stdout, 'status=1\n', `a write refused after the code ran fails the program: ${unhandled.stderr}`);
  assert.match(unhandled.stderr, /EIO: i\/o error, write/, 'with Node\'s report of it');
  const handled = await ws.exec(`node -e 'process.stdout.on("error", (e) => { console.error("handled", e.code); process.exitCode = 4 }); process.stdout.write("x\\n")' > /slow/out; echo "status=$?"`, { cwd: '/home/user' });
  assert.deepEqual({ stdout: handled.stdout, stderr: handled.stderr }, { stdout: 'status=4\n', stderr: 'handled EIO\n' }, 'and its handler hears of it, and decides');
  console.log('  ✓ a write refused after the program\'s code ran reaches the program, handled or not');
} finally {
  await ws.close();
}
console.log('lifo-node-output-settles: ok');
