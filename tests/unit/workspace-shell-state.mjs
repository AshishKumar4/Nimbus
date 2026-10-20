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

  const protoEnv = Object.fromEntries([['__proto__', 'saved\ud800'], ['constructor', 'saved-constructor'], ['toString', 'saved-toString']]);
  await ws.withNamedShell('proto-seed', { start: { cwd: '/tmp', env: protoEnv }, persist: false }, async () => {});
  const stored = JSON.parse(harness.sql.exec('SELECT env FROM vfs_shells WHERE id = ?', 'proto-seed')[0].env);
  assert.equal(Object.hasOwn(stored, '__proto__'), true, 'the saved JSON contains the own prototype-named variable');
  const seeded = await ws.shellState('proto-seed');
  for (const [key, value] of Object.entries(protoEnv)) {
    assert.equal(Object.hasOwn(seeded.env, key), true, `the exact reader keeps ${key}`);
    assert.equal(seeded.env[key], value);
  }

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
  const edited = await read();
  edited.env.A = 'changed by caller';
  assert.deepEqual(await read(), second, 'a caller cannot mutate the saved row through its snapshot');

  for (const command of ['true', 'false', 'missing-state-command']) {
    await run(command);
    assert.deepEqual(await read(), second, `exit status from ${command} does not become shell state`);
  }
  let previous = second;
  for (const command of ["export '0=zero'", "export 'A-B=hyphen'", "export MULTILINE='first\nsecond'",
    "export '__proto__=written\ud801'", 'export constructor=written-constructor', 'export toString=written-toString', 'cd /tmp']) {
    assert.equal((await run(command)).exitCode, 0);
    const current = await read();
    assert.notEqual(digest(current), digest(previous), 'every saved name, value and cwd contributes to the state');
    previous = current;
  }
  assert.equal(previous.env['0'], 'zero');
  assert.equal(previous.env['A-B'], 'hyphen');
  assert.equal(previous.env.MULTILINE, 'first\nsecond');
  assert.equal(Object.hasOwn(previous.env, '__proto__'), true, 'the public named exec writer keeps prototype-named variables');
  assert.equal(previous.env.__proto__, 'written\ud801');
  assert.equal(previous.env.constructor, 'written-constructor');
  assert.equal(previous.env.toString, 'written-toString');
  assert.equal(previous.cwd, '/tmp');
  assert.equal(await ws.shellState('another'), null, 'the snapshot is scoped to its name');

  await ws.close();
  ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
  assert.deepEqual(await read(), previous, 'the same saved row survives a workspace reopen');

  let enter;
  let failEnter;
  const entered = new Promise((resolve, reject) => { enter = resolve; failEnter = reject; });
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  ws.registry.register('state-rendezvous', async () => {
    enter();
    await released;
    return 0;
  });
  const writing = run("export QUEUED='\udfff'; state-rendezvous");
  writing.catch(failEnter);
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

  // A variable's attributes and arrays come back as the call left them (ticket-lifo-named-shell-attributes).
  const attrs = (command) => ws.exec(command, { shellId: 'attributes' });
  for (const command of ['x=1', 'export y=2', 'declare p', 'readonly r=1', 'a=(1 [5]="x y")', 'export n', 'z=3; unset z']) {
    assert.equal((await attrs(command)).exitCode, 0, command);
  }
  const printed = await attrs('declare -p x y p r a n; declare -p z');
  assert.equal(printed.stdout, [
    'declare -- x="1"', 'declare -x y="2"', 'declare -- p', 'declare -r r="1"', 'declare -a a=([0]="1" [5]="x y")', 'declare -x n', '',
  ].join('\n'));
  const refused = await attrs('r=2');
  assert.equal(refused.exitCode, 1, 'a readonly name stays readonly');
  assert.match(refused.stderr, /r: readonly variable/);
  assert.equal((await attrs('echo "$PIPESTATUS ${#PIPESTATUS[@]}"')).stdout, ' 0\n', 'a call starts with no statuses, as with no $?: the last call\'s are its own');
  const attributed = await ws.shellState('attributes');
  assert.deepEqual(attributed.vars.arrays.a, [[0, '1'], [5, 'x y']]);
  assert.equal(Object.hasOwn(attributed.vars.arrays, 'PIPESTATUS'), false, 'PIPESTATUS, as $?, is not shell state');
  assert.deepEqual(attributed.vars.readonly, ['r']);

  // A saved binding of a workspace name (HOME here) is the saved one: an unexported array, a declared-unset name.
  const bindings = (command, options = {}) => ws.exec(command, { shellId: 'bindings', ...options });
  assert.equal((await bindings('export -n HOME; HOME=(one two); declare -n 2>/dev/null; unset USER; declare USER')).exitCode, 0);
  const restored = await bindings('declare -p HOME USER');
  assert.equal(restored.stdout, 'declare -a HOME=([0]="one" [1]="two")\ndeclare -- USER\n');
  const settled = await ws.shellState('bindings');
  await bindings('true');
  assert.equal(digest(await ws.shellState('bindings')), digest(settled), 'a call that changes nothing leaves its saved bindings as they were');
  // An array named PWD stays the array (exported, as PWD was); an index past 2^53 round-trips.
  await bindings('PWD=(p w); big[9007199254740992]=x');
  assert.equal((await bindings('declare -p PWD; echo "${big[9007199254740992]}"')).stdout, 'declare -ax PWD=([0]="p" [1]="w")\nx\n');
  const pwdArray = await ws.shellState('bindings');
  assert.equal((await bindings('true', { cwd: '/tmp' })).exitCode, 0);
  assert.equal(digest(await ws.shellState('bindings')), digest(pwdArray), 'a call\'s own cwd leaves the saved PWD array as it was');
  // A readonly PWD keeps its value; cd moves the shell and fails, as bash's does.
  const readonlyPwd = await bindings('readonly PWD; cd /usr; echo "st=$? ${PWD[*]}"; pwd');
  assert.equal(readonlyPwd.stdout, 'st=1 p w\n/usr\n');
  assert.equal(readonlyPwd.stderr, 'PWD: readonly variable\n');
  // A call's env binds a name for the call alone, an array's too.
  await bindings('arr=(saved)');
  assert.equal((await bindings('echo "$arr ${#arr[@]}"', { env: { arr: 'call' } })).stdout, 'call 1\n');
  assert.equal((await bindings('declare -p arr')).stdout, 'declare -a arr=([0]="saved")\n', 'the saved array is back after the call');

  // A state whose every variable is an exported scalar is saved without `vars`, and digests as before them.
  const runPlain = (command) => ws.exec(command, { shellId: 'plain' });
  await runPlain('export B=1');
  const plain = await ws.shellState('plain');
  assert.equal(Object.hasOwn(plain, 'vars'), false, 'a default state has no vars key');
  assert.deepEqual(Object.keys(plain), ['cwd', 'env']);
  const plainDigest = digest(plain);
  for (const command of ['true', 'echo hi | cat', 'false']) await runPlain(command);
  assert.equal(digest(await ws.shellState('plain')), plainDigest, 'calls that change nothing keep the digest');
  await runPlain('local_only=1');
  const changed = await ws.shellState('plain');
  assert.notEqual(digest(changed), plainDigest, 'an unexported variable is state, and changes the digest');
  assert.deepEqual(changed.vars.exported.includes('local_only'), false);

  // A table from before `vars`: its rows read as today's, and the column is added once.
  await ws.close();
  harness.sql.exec('DROP TABLE vfs_shells');
  harness.sql.exec('CREATE TABLE vfs_shells (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, env TEXT NOT NULL)');
  harness.sql.exec('INSERT INTO vfs_shells (id, cwd, env) VALUES (?, ?, ?)', 'old', '/tmp', JSON.stringify({ OLD: 'v', HOME: '/home/user' }));
  ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
  const old = await ws.shellState('old');
  assert.deepEqual(Object.keys(old), ['cwd', 'env'], 'an old row has no vars');
  assert.deepEqual({ cwd: old.cwd, env: { ...old.env } }, { cwd: '/tmp', env: { OLD: 'v', HOME: '/home/user' } });
  assert.equal(digest(old), digest({ cwd: '/tmp', env: { OLD: 'v', HOME: '/home/user' } }), 'an old row digests as it did');
  assert.equal([...harness.sql.exec('PRAGMA table_info(vfs_shells)')].filter((column) => column.name === 'vars').length, 1);
  assert.equal((await ws.exec('declare -p OLD', { shellId: 'old' })).stdout, 'declare -x OLD="v"\n', 'an old row\'s variables are exported, as before');
} finally {
  await ws.close();
  harness.db.close();
}
console.log('workspace-shell-state: ok');
