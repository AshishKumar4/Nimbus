// Common-path launch and GET costs on the built worker, in real workerd.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { startLocalProbe } from './workerd-probe.mjs';
const count = Number(process.env.NIMBUS_COST_SAMPLES || 30);
const address = Object.values(networkInterfaces()).flat().find((a) => a && !a.internal && a.family === 'IPv4')?.address;
assert.ok(address, 'a non-loopback address is needed for guest outbound GETs');
const fixture = createServer((_, res) => { res.setHeader('content-type', 'text/plain'); res.end('x'.repeat(4096)); });
await new Promise((r) => fixture.listen(0, address, r));
const url = `http://${address}:${fixture.address().port}/cfg`;
const probe = await startLocalProbe({ runtimes: [] });
process.env.BASE = probe.base; process.env.NIMBUS_PROBE_TOKEN = probe.token;
const { mintSession, deleteSession, Terminal } = await import('../../behavioral/_driver.mjs');
let sid, terminal;
const quantiles = (values) => { values.sort((a, b) => a - b); return { n: values.length, p50: values[Math.ceil(values.length * .50) - 1], p95: values[Math.ceil(values.length * .95) - 1] }; };
try {
  sid = await mintSession(); terminal = new Terminal(sid); await terminal.connect(); await terminal.waitForPrompt(60000);
  const launches = [];
  for (let i = 0; i < count + 3; i++) {
    const start = performance.now();
    const { output } = await terminal.run('node -e "console.log(17)"', 60000);
    assert.match(output, /17/);
    if (i >= 3) launches.push(performance.now() - start);
  }
  const child = `(async () => { const t = performance.now(); const r = await fetch(${JSON.stringify(url)}); const b = await r.text(); if (b.length !== 4096) throw new Error('short body'); console.log('GET_MS ' + (performance.now() - t)); })()`;
  const parent = `const {spawn} = require('child_process'); (async () => { for (let i=0;i<${count + 3};i++) await new Promise((ok,bad) => { const c=spawn('node',['-e',${JSON.stringify(child)}]); c.stdout.on('data',d=>process.stdout.write(d)); c.stderr.on('data',d=>process.stderr.write(d)); c.on('close',code=>code===0?ok():bad(new Error('child '+code))); }); })()`;
  const encoded = Buffer.from(parent).toString('base64');
  await terminal.run(`node -e "require('fs').writeFileSync('/tmp/sync-stdin-cost.js', Buffer.from('${encoded}','base64'))"`, 60000);
  const { output } = await terminal.run('node /tmp/sync-stdin-cost.js', 240000);
  const gets = [...output.matchAll(/GET_MS (\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  assert.equal(gets.length, count + 3, output.slice(-2000));
  console.log('SYNC_STDIN_COST ' + JSON.stringify({ label: process.env.NIMBUS_COST_LABEL, engine: 'local-workerd', bodyBytes: 4096, noStdinLaunchMs: quantiles(launches), stoppableGetMs: quantiles(gets.slice(3)) }));
} finally {
  terminal?.close(); if (sid) await deleteSession(sid); await probe.stop(); await new Promise((r) => fixture.close(r));
}
