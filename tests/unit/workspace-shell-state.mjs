import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
let ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
const name = 'approval';
const run = (command) => ws.exec(command, { shellId: name });
const read = () => ws.shellState(name);
const digest = (state) => new Bun.CryptoHasher('sha256').update(JSON.stringify(state)).digest('hex');
try {
  assert.equal(await read(), null, 'reading an unused name does not create it');
  assert.equal(harness.sql.exec('SELECT id FROM vfs_shells WHERE id = ?', name).length, 0);
  for (const invalid of ['', '../invalid']) await assert.rejects(() => ws.shellState(invalid));

  await run("export A='\ud800'");
  const first = await read();
  assert.equal(first.env.A, '\ud800');
  assert.equal(Object.hasOwn(first.env, '$'), false, 'a call pid is not saved shell state');
  const firstDigest = digest(first);
  await run("export A='\ud801'");
  const second = await read();
  assert.equal(second.env.A, '\ud801');
  assert.notEqual(digest(second), firstDigest, 'the approval digest distinguishes lone surrogates before UTF-8 encoding');
  assert.equal(first.env.A, '\ud800', 'an earlier snapshot does not change');

  for (const command of ['true', 'false', 'missing-state-command']) {
    await run(command);
    assert.deepEqual(await read(), second, `exit status from ${command} does not become shell state`);
  }
  let previous = second;
  for (const command of ["export '0=zero'", "export 'A-B=hyphen'", "export MULTILINE='first\nsecond'", 'cd /tmp']) {
    assert.equal((await run(command)).exitCode, 0);
    const current = await read();
    assert.notEqual(digest(current), digest(previous), 'every saved name, value and cwd contributes to the state');
    previous = current;
  }
  assert.equal(previous.env['0'], 'zero');
  assert.equal(previous.env['A-B'], 'hyphen');
  assert.equal(previous.env.MULTILINE, 'first\nsecond');
  assert.equal(previous.cwd, '/tmp');
  assert.equal(await ws.shellState('another'), null, 'the snapshot is scoped to its name');

  await ws.close();
  ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
  assert.deepEqual(await read(), previous, 'the same saved row survives a workspace reopen');

  let enter;
  const entered = new Promise((resolve) => { enter = resolve; });
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const writing = ws.withNamedShell(name, {}, async (named) => {
    const shell = named.open(321);
    await shell.execute("export QUEUED='\udfff'");
    enter();
    await released;
  });
  await entered;
  const reading = read();
  let completed = false;
  reading.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false, 'a read waits for the preceding owner to save');
  release();
  await writing;
  const queued = await reading;
  assert.equal(queued.env.QUEUED, '\udfff');
  assert.equal(Object.hasOwn(queued.env, '$'), false);
} finally {
  await ws.close();
  harness.db.close();
}
console.log('workspace-shell-state: ok');
