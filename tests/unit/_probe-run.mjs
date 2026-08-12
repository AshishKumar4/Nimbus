#!/usr/bin/env bun
/** scratch: run a script through the real registry. `bun tests/unit/_probe-run.mjs file.sh [args]` */
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
// The Workers runtime has these; this bun host does not.
if (typeof globalThis.DecompressionStream === 'undefined') {
  globalThis.DecompressionStream = class { constructor(f) {
    const t = f === 'gzip' ? zlib.createGunzip() : zlib.createInflate();
    ({ readable: this.readable, writable: this.writable } = require('node:stream').Duplex.toWeb(t));
  } };
  globalThis.CompressionStream = class { constructor(f) {
    const t = f === 'gzip' ? zlib.createGzip() : zlib.createDeflate();
    ({ readable: this.readable, writable: this.writable } = require('node:stream').Duplex.toWeb(t));
  } };
}
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { Sandbox } from '../../packages/worker/src/substrate/lifo/sandbox/Sandbox.ts';
import { SqliteVFS, SqliteVFSProvider } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { registerUnixCommands } from '../../packages/worker/src/shell/unix-commands.ts';
import { registerShellEntrypointCommands } from '../../packages/worker/src/shell/shell-entrypoints.ts';
import { installPathExecResolver } from '../../packages/worker/src/shell/exec-dispatch.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const root = rawVfs.as(CRED_KERNEL);
root.mkdir('home', { mode: 0o755 });
root.mkdir('home/user', { mode: 0o755 });
root.chown('home/user', 1000, 1000);
root.mkdir('tmp', { mode: 0o777 });
root.chown('tmp', 1000, 1000);

const box = await Sandbox.create({ persist: false });
box.kernel.vfs.mount('/home', new SqliteVFSProvider(rawVfs, 'home'));
box.kernel.vfs.mount('/tmp', new SqliteVFSProvider(rawVfs, 'tmp'));
installPathExecResolver(box.commands.registry, root, () => box.shell.getCwd?.() ?? '/home/user');
registerUnixCommands(box.commands.registry, rawVfs);
registerShellEntrypointCommands(
  box.commands.registry,
  { execute: (cmd, options) => box.shell.execute(cmd, options) },
  box.kernel.vfs,
);

const file = process.argv[2];
const script = file === '-c' ? process.argv[3] : readFileSync(file, 'utf8');
const args = (file === '-c' ? process.argv.slice(4) : process.argv.slice(3)).join(' ');
root.writeFile('tmp/probe.sh', script, { mode: 0o755 });
const t0 = Date.now();
const r = await box.shell.execute(`bash /tmp/probe.sh ${args}`, {});
console.log('--- stdout ---\n' + (r.stdout ?? ''));
console.log('--- stderr ---\n' + (r.stderr ?? ''));
console.log(`--- exit ${r.exitCode} in ${Date.now() - t0}ms ---`);
box.destroy();
