import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mock } from 'bun:test';
const actualSpawn = spawn;
const groups = [];
let attempts = 0;
mock.module('node:child_process', () => ({ spawnSync, spawn(command, args, options) {
  let code;
  if (args[0] === 'r2') code = '';
  else if (++attempts === 1) {
    // The failed leader exits but a child still holds its pipes open, as a
    // failed wrangler bind can leave workerd beneath it.
    code = 'require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore","inherit","inherit"]});console.error("Address already in use");setTimeout(()=>process.exit(1),100)';
  } else {
    const port = Number(args[args.indexOf('--port') + 1]);
    code = `require("node:http").createServer((q,s)=>s.end("ready")).listen(${port},"127.0.0.1",()=>console.log("Ready on http://127.0.0.1:${port}"))`;
  }
  const child = actualSpawn('node', ['-e', code], options);
  if (args[0] !== 'r2') groups.push(child.pid);
  return child;
} }));
const { startLocalProbe } = await import('./lib/workerd-probe.mjs');
let probe;
try {
  probe = await startLocalProbe({ runtimes: [], bootTimeoutMs: 10_000 });
  assert.equal(attempts, 2, 'the occupied port was retried');
  await probe.stop();
  for (const pid of groups) {
    assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' }, 'every process group the probe started was ended, including the failed retry');
  }
} finally {
  await probe?.stop();
  for (const pid of groups) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
}
console.log('workerd-probe-owned-processes: a failed leader and its surviving child are cleaned before retry/stop');
