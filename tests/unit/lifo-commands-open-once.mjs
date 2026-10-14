#!/usr/bin/env bun
// tee, dd and the byte readers under cat open each file operand once, as
// their GNU tools do: what they read or write is the file the open found,
// whatever the name names after (another command renaming it, and a new
// file taking its name). They stored a path and an offset and resolved the
// path again for every chunk, so after such a rename the rest of the input
// went to, or came from, the new file.

import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, cwd: '/home/user' });
const failed = [];
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed.push(name);
    console.log(`  ✗ ${name}: ${error?.message ?? error}`);
  }
};
const run = async (script) => {
  const r = await ws.exec(script, { timeout: 20_000 });
  return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
};
const read = (path) => ws.fs.readFile(path, 'utf8');

// The producer writes a line, waits until the writer has written it, moves
// the file aside, puts a new file in its place, and writes a second line.
const PRODUCER = `{ echo one; i=0; while [ ! -s out.txt ] && [ $i -lt 200000 ]; do i=$((i+1)); done; mv out.txt moved.txt; echo replacement > out.txt; echo two; }`;

try {
  await check('tee writes the file it opened, though its name was given to another', async () => {
    assert.deepEqual(await run(`rm -f out.txt moved.txt; ${PRODUCER} | tee out.txt > /dev/null`), { code: 0, stdout: '', stderr: '' });
    assert.equal(await read('/home/user/moved.txt'), 'one\ntwo\n', 'both lines are in the file tee opened');
    assert.equal(await read('/home/user/out.txt'), 'replacement\n', 'the new file is untouched');
  });

  await check('tee -a appends to the file it opened', async () => {
    assert.deepEqual(await run(`rm -f out.txt moved.txt; ${PRODUCER} | tee -a out.txt > /dev/null`), { code: 0, stdout: '', stderr: '' });
    assert.equal(await read('/home/user/moved.txt'), 'one\ntwo\n');
    assert.equal(await read('/home/user/out.txt'), 'replacement\n');
  });

  await check('dd of= writes the file it opened', async () => {
    assert.deepEqual(await run(`rm -f out.txt moved.txt; ${PRODUCER} | dd of=out.txt status=none`), { code: 0, stdout: '', stderr: '' });
    assert.equal(await read('/home/user/moved.txt'), 'one\ntwo\n');
    assert.equal(await read('/home/user/out.txt'), 'replacement\n');
  });

  // Four pipe-fulls: cat is held at its second write until the reader drains
  // the pipe, which it does only after the file has been replaced.
  const SIZE = 4 * 65536;
  await ws.fs.writeFile('/home/user/big.bin', new Uint8Array(SIZE).fill(0x61));
  await check('cat reads the file it opened to its end, though its name was given to another', async () => {
    const r = await run('cat big.bin | { dd bs=1 count=1 of=/dev/null status=none; mv big.bin old.bin; printf new > big.bin; wc -c; }');
    assert.deepEqual(r, { code: 0, stdout: `${SIZE - 1}\n`, stderr: '' });
  });

  await check('dd if= reads the file it opened', async () => {
    await ws.fs.writeFile('/home/user/big.bin', new Uint8Array(SIZE).fill(0x62));
    const r = await run('dd if=big.bin bs=65536 status=none | { dd bs=1 count=1 of=/dev/null status=none; mv big.bin old2.bin; printf new > big.bin; wc -c; }');
    assert.deepEqual(r, { code: 0, stdout: `${SIZE - 1}\n`, stderr: '' });
  });

  await check('a FILE tee cannot write is reported once, and the rest still get the input', async () => {
    await run('mkdir -p ro && chmod 555 ro');
    const r = await run('printf "a\\nb\\n" | tee ro/x.txt kept.txt; echo "rc=$?"');
    assert.equal(r.stdout, 'a\nb\nrc=1\n');
    assert.equal((r.stderr.match(/tee: ro\/x\.txt:/g) ?? []).length, 1, r.stderr);
    assert.equal(await read('/home/user/kept.txt'), 'a\nb\n');
  });
} finally {
  await ws.close();
}
assert.deepEqual(failed, [], 'every command opens its operand once');
console.log('lifo-commands-open-once: ok');
