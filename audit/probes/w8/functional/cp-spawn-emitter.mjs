#!/usr/bin/env bun
// W8 functional: child_process.spawn returns a ChildProcess emitter that
// satisfies the Node-documented surface for husky/concurrently/cross-spawn.

import { ok, eq, includes, summary, group } from '../_tap.mjs';
import { makeShimHost, makeMockSupervisor } from '../_shim-host.mjs';

await group('cp-spawn-emitter', async () => {
  const sup = makeMockSupervisor();
  const host = await makeShimHost(sup);
  const cp = host.childProcessMod;

  // Shape: keys
  ok('exec exists', typeof cp.exec === 'function');
  ok('execSync exists', typeof cp.execSync === 'function');
  ok('execFile exists', typeof cp.execFile === 'function');
  ok('execFileSync exists', typeof cp.execFileSync === 'function');
  ok('spawn exists', typeof cp.spawn === 'function');
  ok('spawnSync exists', typeof cp.spawnSync === 'function');
  ok('fork exists', typeof cp.fork === 'function');
  ok('ChildProcess exists', cp.ChildProcess !== undefined);

  // Spawn returns synchronously
  const child = cp.spawn('echo', ['hello', 'world']);
  ok('spawn returns object', typeof child === 'object' && child !== null);
  ok('child.kill is function', typeof child.kill === 'function');
  ok('child.stdin is non-null', child.stdin != null);
  ok('child.stdout is non-null', child.stdout != null);
  ok('child.stderr is non-null', child.stderr != null);
  ok('child.stdio is array', Array.isArray(child.stdio));
  eq('child.stdio length 3', child.stdio.length, 3);

  // Wait for spawn to settle
  const dataChunks = [];
  child.stdout.on('data', (d) => dataChunks.push(String(d)));
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });

  await host.drainPending();
  await host.pause(50);
  await host.drainPending();
  await host.pause(50);
  await host.drainPending();

  ok('cpSpawn was called', sup.calls.some(c => c.method === 'cpSpawn'));
  ok('child.pid is set', typeof child.pid === 'number' && child.pid > 0);
  includes('stdout received "hello world"', dataChunks.join(''), 'hello world');
  ok('exit fired', exited !== null);
  eq('exit code 0', exited?.code, 0);
});

summary('cp-spawn-emitter');
