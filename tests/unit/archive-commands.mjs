#!/usr/bin/env bun
// gzip, gunzip and unzip. gzip -d and gunzip are one pipeline, and -f and -q
// mean what they mean to GNU gzip 1.14 (whose answers, recorded 2026-10-05,
// are the expectations below): an output that exists is not overwritten
// without -f (a warning, exit 2, which -q does not silence), a name without
// .gz is skipped with a warning (exit 2) that -q silences (exit 0). Both used
// to overwrite whatever was there and exit 1 on a suffix. unzip -p writes an
// entry's bytes as they are, and losslessly to a sink that takes text alone.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import unzip from '../../packages/core/src/substrate/lifo/commands/archive/unzip.ts';
import { createZip } from '../../packages/core/src/substrate/lifo/utils/archive.ts';
import { encodeLossless } from '../../packages/core/src/substrate/lifo/utils/bytes-io.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
try {
  const run = (line) => ws.exec(`cd /home/user && ${line}`);
  const text = async (path) => new TextDecoder().decode(await ws.fs.readFile(`/home/user/${path}`));

  assert.equal((await run('echo a > f && gzip -k f && echo y > f && gzip f; echo "exit $?"')).stdout, 'exit 2\n');
  assert.equal((await run('gzip f')).stderr, 'gzip: f.gz already exists;\tnot overwritten\n');
  assert.equal((await run('gzip -q f; echo "exit $?"')).stdout, 'exit 2\n', '-q does not silence an existing output');
  assert.equal((await run('gzip -f f; echo "exit $?"')).stdout, 'exit 0\n');
  assert.equal((await run('gunzip -k f.gz && cat f')).stdout, 'y\n', '-f wrote the new contents');

  const suffix = await run('echo z > g.txt && gzip -d g.txt; echo "exit $?"');
  assert.equal(suffix.stdout, 'exit 2\n');
  assert.equal(suffix.stderr, 'gzip: g.txt: unknown suffix -- ignored\n');
  const quiet = await run('gzip -dq g.txt; echo "exit $?"');
  assert.deepEqual([quiet.stdout, quiet.stderr], ['exit 0\n', '']);

  assert.equal((await run('echo c > h && gzip -k h && echo x > h && gunzip h.gz; echo "exit $?"')).stdout, 'exit 2\n');
  assert.equal(await text('h'), 'x\n', 'gunzip left the existing h alone');
  assert.equal((await run('gunzip -f h.gz; echo "exit $?"')).stdout, 'exit 0\n');
  assert.equal(await text('h'), 'c\n');

  // unzip -p: a non-UTF-8 entry, to a sink that takes only text.
  const bytes = new Uint8Array([0x61, 0xff, 0xfe, 0x62]);
  await ws.fs.writeFile('/home/user/z.zip', createZip([{ path: 'bin', data: bytes, isDirectory: false }]));
  let out = '';
  const view = ws.filesystem.view({ pid: 900, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } });
  const status = await unzip({
    pid: 900, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, args: ['-p', 'z.zip'], env: {}, cwd: '/home/user', vfs: view,
    stdout: { write: (chunk) => { out += chunk; } }, stderr: { write: () => {} }, signal: new AbortController().signal,
    setUmask() {}, runAs: async () => ({ status: 1, signal: null }),
  });
  assert.equal(status, 0);
  assert.deepEqual([...encodeLossless(out)], [...bytes], 'the text decodes back to the entry\'s bytes');
} finally {
  await ws.close();
}
console.log('archive-commands: ok');
