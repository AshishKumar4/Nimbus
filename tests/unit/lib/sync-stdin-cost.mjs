// Common-path launch and GET costs on the built worker, in real workerd.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { startLocalProbe } from './workerd-probe.mjs';
const count = Number(process.env.NIMBUS_COST_SAMPLES || 30);
const address = Object.values(networkInterfaces()).flat().find((a) => a && !a.internal && a.family === 'IPv4')?.address;
assert.ok(address, 'a non-loopback address is needed for guest outbound GETs');
const fixture = createServer((_, res) => { res.setHeader('content-type', 'text/plain'); res.end('x'.repeat(4096)); });
await new Promise((r) => fixture.listen(0, address, () => r(undefined)));
const url = `http://${address}:${/** @type {import('node:net').AddressInfo} */ (fixture.address()).port}/cfg`;
const probe = await startLocalProbe({ runtimes: [] });
process.env.BASE = probe.base; process.env.NIMBUS_PROBE_TOKEN = probe.token;
const { mintSession, deleteSession, Terminal } = await import('../../behavioral/_driver.mjs');
let sid, terminal;
const quantiles = (values) => { values.sort((a, b) => a - b); return { n: values.length, p50: values[Math.ceil(values.length * .50) - 1], p95: values[Math.ceil(values.length * .95) - 1] }; };
try {
  sid = await mintSession(); terminal = new Terminal(sid); await terminal.connect(); await terminal.waitForPrompt(60000);
  const clean = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
  const measureLaunches = async () => {
    const launches = [];
    for (let i = 0; i < count + 3; i++) {
      const start = performance.now();
      const { output } = await terminal.run('node -e "console.log(17)"', 60000);
      assert.match(clean(output), /\n17\n/, 'the launch must actually print, not just echo its command');
      if (i >= 3) launches.push(performance.now() - start);
    }
    return quantiles(launches);
  };
  let polled;
  if (process.env.NIMBUS_COST_COMPARE_POLLING === '1') {
    // Reproduce the former driver on the SAME workerd, not another startup.
    const eventWait = terminal.waitFor;
    terminal.waitFor = async function(predicate, ms, label) {
      const start = Date.now();
      while (Date.now() - start < ms) {
        if (predicate(clean(this.buf))) return Date.now() - start;
        if (this.closed) throw new Error('terminal closed');
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('polled wait timed out: ' + label);
    };
    polled = await measureLaunches();
    terminal.waitFor = eventWait;
  }
  const launches = await measureLaunches();
  const child = `(async () => { const t = performance.now(); const r = await fetch(${JSON.stringify(url)}); const h = performance.now(); const b = await r.text(); const done = performance.now(); if (b.length !== 4096) throw new Error('short body'); console.log('GET_MS ' + (done - t) + ' HEADERS_MS ' + (h - t) + ' BODY_MS ' + (done - h)); })()`;
  const parent = `const {spawn} = require('child_process'); (async () => { for (let i=0;i<${count + 3};i++) await new Promise((ok,bad) => { const c=spawn('node',['-e',${JSON.stringify(child)}]); c.stdout.on('data',d=>process.stdout.write(d)); c.stderr.on('data',d=>process.stderr.write(d)); c.on('close',code=>code===0?ok():bad(new Error('child '+code))); }); })()`;
  const encoded = Buffer.from(parent).toString('base64');
  await terminal.run(`node -e "require('fs').writeFileSync('/tmp/sync-stdin-cost.js', Buffer.from('${encoded}','base64'))"`, 60000);
  const { output } = await terminal.run('node /tmp/sync-stdin-cost.js', 240000);
  const gets = [...output.matchAll(/GET_MS (\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  assert.equal(gets.length, count + 3, output.slice(-2000));
  const headers = [...output.matchAll(/HEADERS_MS (\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const bodies = [...output.matchAll(/BODY_MS (\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  console.log('SYNC_STDIN_COST ' + JSON.stringify({ label: process.env.NIMBUS_COST_LABEL, engine: 'local-workerd', bodyBytes: 4096, noStdinPolledLaunchMs: polled, noStdinLaunchMs: launches, stoppableGetMs: quantiles(gets.slice(3)), getHeadersMs: quantiles(headers.slice(3)), getBodyMs: quantiles(bodies.slice(3)) }));
} finally {
  terminal?.close(); if (sid) await deleteSession(sid); await probe.stop(); await new Promise((r) => fixture.close(r));
}
