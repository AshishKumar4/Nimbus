#!/usr/bin/env bun
// Each committed write names the exec that made it (Kinu ask 69):
// VfsWriteEvent.execId is the execId the process table holds for the writing
// process when the write commits, which every process an exec starts
// inherits. It is null for a write no process made (a host's), and
// undefined for a process's write with no exec name (its exec named none).
// Here, over a core-only workspace:
// - two execs, under one credential, write at once with their awaits
//   interleaved: each event names its own exec (redirections, mkdir, mv,
//   rm, and a durable coreutils command, setfacl);
// - an exec's children (a subshell, a pipeline, a background job) name it;
// - interleaved appends to one file make separate events, each its own exec's;
// - a host lease's write is null; an exec with no execId is undefined;
// - a mount that does not report its own writes names the exec too, even
//   when the process is killed and reaped while the mount's write is pending.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The events observed while `body` runs, as `{ type, path, execId }`. */
async function observed(body) {
  const events = [];
  const stop = ws.filesystem.vfs.observeWrites((event) => {
    events.push({ type: event.type, path: event.path, ...(event.oldPath === undefined ? {} : { oldPath: event.oldPath }), execId: event.execId });
  }, { wants: () => false });
  try {
    await body();
  } finally {
    stop();
  }
  return events;
}
/** `events` under `dir`, by path: the exec ids each path's events named. */
function byPath(events, dir) {
  const out = {};
  for (const event of events) {
    for (const path of [event.path, event.oldPath]) {
      if (path === undefined || !path.startsWith(dir)) continue;
      (out[path] ??= new Set()).add(event.execId);
    }
  }
  return Object.fromEntries(Object.entries(out).map(([path, ids]) => [path, [...ids]]));
}

const failures = [];
const check = async (name, body) => {
  try {
    await body();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
};

await ws.exec('mkdir -p /home/user/a /home/user/b /home/user/shared /home/user/kids /home/user/plain');

await check('two execs at once, each its own', async () => {
  const line = (dir) => [
    `echo one > ${dir}/f`, 'sleep 0.05', `mkdir ${dir}/d`, 'sleep 0.05',
    `echo two >> ${dir}/f`, `mv ${dir}/f ${dir}/g`, 'sleep 0.05', `rm ${dir}/g`, `setfacl -d -m u::rwx,g::rwx,o::r-x ${dir}/d`,
  ].join('; ');
  const events = await observed(async () => {
    const [a, b] = await Promise.all([
      ws.exec(line('/home/user/a'), { execId: 'exec-a' }),
      ws.exec(line('/home/user/b'), { execId: 'exec-b' }),
    ]);
    assert.deepEqual([a.exitCode, b.exitCode], [0, 0], `${a.stderr}${b.stderr}`);
  });
  const seen = { ...byPath(events, '/home/user/a'), ...byPath(events, '/home/user/b') };
  assert.ok(Object.keys(seen).length >= 6, `events seen: ${JSON.stringify(seen)}`);
  for (const [path, ids] of Object.entries(seen)) {
    assert.deepEqual(ids, [path.startsWith('/home/user/a') ? 'exec-a' : 'exec-b'], `${path}: ${JSON.stringify(ids)}`);
  }
});

await check('an exec\'s children', async () => {
  let ran;
  const events = await observed(async () => {
    ran = await ws.exec([
      '( echo x > /home/user/kids/sub )',
      'echo y | tee /home/user/kids/pipe > /dev/null',
      '(sleep 0.05; echo z > /home/user/kids/bg) &',
      'wait',
    ].join('; '), { execId: 'exec-kids' });
    assert.equal(ran.exitCode, 0, ran.stderr);
  });
  assert.deepEqual(byPath(events, '/home/user/kids/'), {
    '/home/user/kids/sub': ['exec-kids'], '/home/user/kids/pipe': ['exec-kids'], '/home/user/kids/bg': ['exec-kids'],
  }, `stderr: ${ran.stderr}; all: ${JSON.stringify(events.filter((event) => event.path.includes('kids')))}`);
});

await check('appends interleaved on one file', async () => {
  const appends = (tag) => Array.from({ length: 4 }, () => `echo ${tag} >> /home/user/shared/log; sleep 0.02`).join('; ');
  const events = await observed(async () => {
    await Promise.all([ws.exec(appends('a'), { execId: 'append-a' }), ws.exec(appends('b'), { execId: 'append-b' })]);
  });
  const ids = events.filter((event) => event.path === '/home/user/shared/log').map((event) => event.execId);
  assert.ok(ids.includes('append-a') && ids.includes('append-b'), `each exec's appends are its own events: ${JSON.stringify(ids)}`);
  assert.ok(ids.every((id) => id === 'append-a' || id === 'append-b'), JSON.stringify(ids));
});

await check('a host lease\'s write, and an exec with no name', async () => {
  const events = await observed(async () => {
    const lease = ws.filesystem.openHost(CRED_SESSION_USER);
    try {
      await lease.fs.writeFile('/home/user/plain/host', 'h');
    } finally {
      await lease.dispose();
    }
    const ran = await ws.exec('echo p > /home/user/plain/unnamed');
    assert.equal(ran.exitCode, 0, ran.stderr);
  });
  const host = events.find((event) => event.path === '/home/user/plain/host');
  const unnamed = events.find((event) => event.path === '/home/user/plain/unnamed');
  assert.ok(host !== undefined && unnamed !== undefined, JSON.stringify(events));
  assert.equal(host.execId, null, 'no process made it');
  assert.ok('execId' in unnamed && unnamed.execId === undefined, `a process's, its exec named none: ${JSON.stringify(unnamed)}`);
});

await check('a mount that does not report its own writes', async () => {
  // A memory filesystem behind an awaited face, as a remote backend is, whose calls can be held after they are
  // made (the write committed, its answer pending), so a kill and a reap can come while one is.
  const backing = new MemoryVFS();
  let gate = null;
  let reached = () => {};
  const slow = new Proxy(backing, {
    get(target, key) {
      if (key === 'sync') return undefined;
      const value = target[key];
      if (typeof value !== 'function') return value;
      return async (...args) => {
        const done = value.apply(target, args);
        // A mkdir made, its answer held.
        if (gate !== null && key === 'mkdir') {
          reached();
          await gate;
        }
        return done;
      };
    },
    has(target, key) { return key !== 'sync' && key in target; },
  });
  ws.filesystem.vfs.mount('/home/user/m', slow);
  try {
    const plain = await observed(async () => {
      const ran = await ws.exec('echo m > /home/user/m/plain', { execId: 'exec-mount' });
      assert.equal(ran.exitCode, 0, ran.stderr);
    });
    assert.deepEqual(byPath(plain, '/home/user/m/'), { '/home/user/m/plain': ['exec-mount'] });

    // A process of its own, no work held for it, writing through its own binding: once it has ended, a reap may forget it.
    const { pid } = ws.processes.spawn('mkdir', ['mkdir', '/home/user/m/late'], '/home/user', { cred: CRED_SESSION_USER, execId: 'exec-late' });
    const bridge = ws.filesystem.bind({ pid, cred: CRED_SESSION_USER });
    let open;
    gate = new Promise((resolve) => { open = resolve; });
    const committed = new Promise((resolve) => { reached = resolve; });
    let kept;
    const late = await observed(async () => {
      const making = bridge.mkdir('/home/user/m/late', { recursive: false, mode: 0o755 });
      // Made on the mount, its answer held: the process ends and is reaped now.
      await committed;
      ws.processes.exit(pid, 0);
      await sleep(20);
      await ws.processes.reap(0);
      kept = ws.processes.get(pid) !== undefined;
      open();
      await making.catch(() => {});
      await sleep(20);
    });
    const ids = byPath(late, '/home/user/m/')['/home/user/m/late'];
    assert.deepEqual([kept, ids], [true, ['exec-late']], `its entry kept by its write in flight, still its exec's: ${JSON.stringify(late)}`);
    await ws.processes.reap(0);
    assert.equal(ws.processes.get(pid), undefined, 'and reaped once it has landed');
  } finally {
    gate = null;
    ws.filesystem.vfs.unmount('/home/user/m');
  }
});

assert.deepEqual(failures, []);
console.log('write-attribution-by-exec: each committed write names the exec that made it');
process.exit(0);
