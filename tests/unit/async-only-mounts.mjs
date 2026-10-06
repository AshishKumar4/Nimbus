#!/usr/bin/env bun
// Kinu's mounts (Drive, /pc, /sandbox) are asynchronous only: no `.sync`.
// Only a caller that truly cannot wait takes the synchronous face and gets
// the named EAGAIN (node's sync fs in a facet, non-JSPI WASI, host reads).
// Everything that can await does: shell commands (ProcessView), the
// bridge's asynchronous RPCs (supervisor ops, node's fs.promises), readdir
// of a directory holding a mount point, and stat of a mount point. Listing
// `/` never needs a mount's synchronous face.

import assert from 'node:assert/strict';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSupervisorOpHandler } from '../../packages/core/src/workspace/supervisor-op.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { runScript } from './lib/bash-preamble.mjs';
import { asyncOnly } from './lib/async-memory-vfs.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
const shared = new MemoryVFS();
const other = new MemoryVFS();
await shared.writeFile('/notes.md', new TextEncoder().encode('from shared\n'));
await other.mkdir('/w', { recursive: true });
ws.filesystem.vfs.mount('/shared', asyncOnly(shared));
ws.filesystem.vfs.mount('/other', asyncOnly(other));

const run = async (command) => {
  const result = await ws.exec(command);
  assert.equal(result.exitCode, 0, `${command}: ${result.stderr}`);
  return result.stdout;
};

assert.match(await run('ls /'), /\bother\b.*\bshared\b/s, 'ls / lists the mount points');
assert.match(await run('ls -la /'), /^d\S+ .* shared$/m, 'and stats them');
assert.equal(await run('cat /shared/notes.md'), 'from shared\n');
assert.equal(await run('ls /shared'), 'notes.md\n');
assert.equal(await run('cd /shared && pwd && ls'), '/shared\nnotes.md\n');
assert.equal(await run('echo hi > /shared/x && echo more >> /shared/x && cat /shared/x'), 'hi\nmore\n');
assert.equal(await run('mv /shared/notes.md /other/w/n.md && cat /other/w/n.md'), 'from shared\n');
assert.equal(await run('cp /other/w/n.md /shared/c && cat /shared/c'), 'from shared\n');
assert.equal(await run('mkdir -p /shared/d/e && touch /shared/d/e/f && cp -r /shared/d /other/d2 && ls /other/d2/e'), 'f\n');
assert.equal(await run('cp /shared/c /home/user/c && cat /home/user/c'), 'from shared\n', 'a copy onto SQLite');
assert.equal(await run('rm -r /other/d2 && ls /other'), 'w\n');
assert.match(await run('find / -path /proc -prune -o -name c -print'), /^\/home\/user\/c\n\/shared\/c\n$/m);
assert.match(await run('df /shared'), /\/shared$/m);
assert.match(await run('stat -c %s /shared/x'), /^8\n$/);

// The asynchronous RPC face (what node's fs.promises reaches in a facet).
const op = createSupervisorOpHandler({ vfs: ws.vfs, filesystem: ws.filesystem });
assert.equal(new TextDecoder().decode(await op({ op: 'readFileBytes', args: ['/shared/c'], pid: ws.shell.pid ?? 1 })), 'from shared\n');

// writeFileStat commits the write before it reads the stat, so a mount whose
// metadata read fails once the bytes are in answers the write without a stat.
{
  const flaky = new MemoryVFS({ uid: 1000, gid: 1000 });
  let written = false;
  const failingStat = new Proxy(asyncOnly(flaky), {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key === 'writeFile') return async (...args) => { const done = await value(...args); written = true; return done; };
      if ((key === 'stat' || key === 'lstat') && written) return async () => { throw Object.assign(new Error('EIO: metadata read failed'), { code: 'EIO' }); };
      return value;
    },
  });
  ws.filesystem.vfs.mount('/flaky', failingStat);
  const answer = await op({ op: 'writeFileStat', args: ['/flaky/f.txt', 'saved'], pid: ws.shell.pid ?? 1 });
  assert.equal(typeof answer.revision, 'number', 'the write is answered');
  assert.equal('stat' in answer, false, 'without the stat it could not read');
  assert.equal(new TextDecoder().decode(await flaky.readFile('/f.txt')), 'saved');
}

// A caller that cannot wait still gets the named refusal.
const sync = ws.filesystem.bind({ pid: 4321, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } }).synchronous;
assert.throws(() => sync.readFile('/shared/c'), (error) => error.code === 'EAGAIN' && /\/shared is an asynchronous mount/.test(error.message));

// A path beneath a root (a WASI preopen) is walked on the mount by the same
// rules as the synchronous walk.
{
  const box = new MemoryVFS({ uid: 1000, gid: 1000 });
  await box.mkdir('/d/sub', { recursive: true });
  await box.writeFile('/d/f', new TextEncoder().encode('f'));
  await box.symlink('sub/../f', '/d/rel');
  await box.symlink('/etc/passwd', '/d/abs');
  await box.mkdir('/d/shut');
  await box.chmod('/d/shut', 0o600);
  await box.writeFile('/d/shut/x', new Uint8Array(1));
  ws.filesystem.vfs.mount('/box', asyncOnly(box));
  const fs = ws.filesystem.bind({ pid: 4242, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } });
  const beneath = (path) => ({ root: '/box/d', path, beneath: true });
  assert.equal((await fs.stat(beneath('rel'))).size, 1, 'a relative link is followed');
  assert.equal((await fs.stat(beneath('rel'), { followSymlinks: false })).type, 'symlink');
  const code = (promise) => promise.then(() => 'ok', (error) => error.code);
  assert.equal(await code(fs.stat(beneath('../d/f'))), 'ENOTCAPABLE', '.. at the root');
  assert.equal(await code(fs.stat(beneath('abs'))), 'ENOTCAPABLE', 'an absolute link');
  assert.equal(await code(fs.stat(beneath('/f'))), 'ENOTCAPABLE', 'an absolute path');
  assert.equal(await code(fs.stat(beneath('shut/x'))), 'EACCES', 'a directory it may not search');
  assert.equal(await fs.stat(beneath('nope/x')), null, 'a missing component is not there');
  assert.equal(await fs.stat(beneath('nope')), null);
  const dir = await fs.open(beneath('sub'), { read: true, directory: true });
  await fs.writeFile({ directory: dir.id, path: 'g', beneath: true }, 'g');
  assert.equal(new TextDecoder().decode(await box.readFile('/d/sub/g')), 'g', 'relative to a descriptor on the mount');
  await fs.close(dir.id);
  await ws.filesystem.releaseProcess(4242);
}

// A released or killed process's descriptors are gone, whichever face opened
// them: a later read or write is EBADF and nothing reaches the file.
{
  const box = new MemoryVFS();
  ws.filesystem.vfs.mount('/kill', asyncOnly(box));
  const kernel = { uid: 0, gid: 0, groups: [0], umask: 0o022 };
  let pid = 5000;
  for (const end of ['releaseProcess', 'killProcess']) {
    for (const path of ['/kill/f', '/tmp/kill-f']) {
      await box.writeFile('/f', new TextEncoder().encode('orig'));
      await ws.filesystem.bind({ pid: 4999, cred: kernel }).writeFile('/tmp/kill-f', 'orig');
      const fs = ws.filesystem.bind({ pid: ++pid, cred: kernel });
      const fd = await fs.open(path, { read: true, write: true });
      await ws.filesystem[end](pid);
      const code = (run) => Promise.resolve().then(run).then(() => 'ok', (error) => error.code);
      assert.equal(await code(() => fs.write(fd.id, 0, new TextEncoder().encode('LATE'))), 'EBADF', `${end} ${path}: write`);
      assert.equal(await code(() => fs.read(fd.id, 0, 4)), 'EBADF', `${end} ${path}: read`);
      const now = path === '/kill/f' ? await box.readFile('/f') : await ws.filesystem.bind({ pid: 4999, cred: kernel }).readFile(path);
      assert.equal(new TextDecoder().decode(now), 'orig', `${end} ${path}: the file is untouched`);
    }
  }
}

await ws.close();

// bash (wasm, WASI) reads and writes an asynchronous mount wherever it can
// park on JSPI: over the RPC a resident facet uses, and in-process.
for (const remote of [true, false]) {
  const drive = new MemoryVFS({ uid: 1000, gid: 1000 });
  await drive.writeFile('/in.txt', new TextEncoder().encode('drive\n'));
  const r = await runScript('cat /drive/in.txt && echo out > /drive/out.txt && ls /drive', { remote, parking: 'jspi', mounts: { '/drive': asyncOnly(drive) } });
  assert.equal(r.stdout, 'drive\nin.txt\nout.txt\n', `bash (${remote ? 'RPC' : 'in-process'}, JSPI): ${r.stderr}`);
  assert.equal(new TextDecoder().decode(await drive.readFile('/out.txt')), 'out\n');
}
// Without JSPI a WASI call cannot wait: the mount's refusal is its answer.
{
  const drive = new MemoryVFS({ uid: 1000, gid: 1000 });
  await drive.writeFile('/in.txt', new TextEncoder().encode('drive\n'));
  const r = await runScript('cat /drive/in.txt', { parking: 'none', mounts: { '/drive': asyncOnly(drive) } });
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /can't open '\/drive\/in.txt': Resource temporarily unavailable/);
}
console.log('async-only-mounts: ok');
