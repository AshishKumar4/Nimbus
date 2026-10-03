#!/usr/bin/env bun
// GNU text utilities read any file, whatever its name and bytes. The lifo
// commands skipped a file as "binary" by its name's MIME type, so an
// extensionless text file (`sed -i s/a/b/ f`) was never edited. What stays is
// GNU's own content rule: diff says "Binary files ... differ" when a file
// holds a NUL byte.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createDefaultRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { readText } from '../../packages/core/src/vfs/vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
const setup = await ws.exec("cd /home/user && printf 'b\\na\\na\\n' > f && printf 'b\\na\\na\\n' > f.png && printf 'x\\0y\\n' > z && printf 'x\\0q\\n' > z2");
assert.equal(setup.exitCode, 0, setup.stderr);

// The workspace shell.
const shell = async (command) => {
  const r = await ws.exec(`cd /home/user && ${command}`);
  assert.doesNotMatch(r.stderr, /binary file, skipping/, command);
  return r.stdout;
};
assert.equal(await shell('sed -i s/a/z/ f && cat f'), 'b\nz\nz\n');
assert.equal(await shell('sed s/b/y/ f.png'), 'y\na\na\n');
assert.equal(await shell("sed s/y/Y/ z | tr '\\0' '@'"), 'x@Y\n', 'a NUL is edited through, not skipped');
assert.equal(await shell('nl f.png'), '     1\tb\n     2\ta\n     3\ta\n');
assert.equal(await shell('rev f'), 'b\nz\nz\n');

// Every lifo text command, as the lifo registry registers it.
const registry = createDefaultRegistry();
const view = ws.filesystem.view({ pid: 900, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } });
async function lifo(name, args) {
  let out = '', err = '';
  const sink = (append) => ({ write: async (chunk) => { append(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)); } });
  const command = await registry.resolve(name);
  const status = await command({
    pid: 900, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, args, env: {}, cwd: '/home/user', vfs: view,
    stdout: sink((s) => { out += s; }), stderr: sink((s) => { err += s; }), signal: new AbortController().signal,
    setUmask() {}, runAs: async () => ({ status: 1, signal: null }),
  });
  assert.doesNotMatch(err, /binary file, skipping/, `lifo ${name}`);
  return { status, out, err };
}
for (const [name, args, want] of [
  ['sed', ['s/b/y/', 'f.png'], 'y\na\na\n'],
  ['nl', ['f.png'], '     1\tb\n     2\ta\n     3\ta\n'],
  ['rev', ['f.png'], 'b\na\na\n'],
  ['grep', ['a', 'f.png'], 'a\na\n'],
  ['wc', ['-l', 'f.png'], null],
  ['uniq', ['f.png'], 'b\na\n'],
  ['cut', ['-f1', 'f.png'], 'b\na\na\n'],
  ['awk', ['{print}', 'f.png'], 'b\na\na\n'],
  ['sort', ['f.png'], 'a\na\nb\n'],
  ['tail', ['-n', '1', 'f.png'], 'a\n'],
]) {
  const r = await lifo(name, args);
  if (want !== null) assert.equal(r.out, want, `lifo ${name}: ${r.err}`);
  else assert.match(r.out, /^\s*3 /, `lifo ${name}: ${r.err}`);
}
// diff: text by name or not, binary by content.
assert.equal((await lifo('diff', ['f.png', 'f'])).status, 1, 'two text files that differ');
assert.match((await lifo('diff', ['f.png', 'f'])).out, /^2,3c2,3\n/);
assert.equal((await lifo('diff', ['z', 'z2'])).out, 'Binary files z and z2 differ\n');

await readText(ws.fs, '/home/user/f');
await ws.close();
console.log('text-commands-read-any-file: ok');
