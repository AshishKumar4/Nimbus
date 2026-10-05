// The same per-call question for a node facet: an asynchronous stat crosses
// to the session (the supervisor bridge), a synchronous one is answered from
// the facet's resident namespace. Compare with probe-wasi-syscall-cost.mjs.
import { mintSession, deleteSession, Terminal, stripAnsi } from '../../tests/behavioral/_driver.mjs';

const sid = await mintSession();
const t = new Terminal(sid);
const step = async (label, cmd, timeout = 600_000) => {
  const started = Date.now();
  const r = await t.run(cmd, timeout);
  console.log(JSON.stringify({ label, wallMs: Date.now() - started, out: stripAnsi(r.output).replace(/\s+$/, '').slice(-300) }));
};
const bench = `
const fs = require('fs');
(async () => {
  fs.writeFileSync('probe.txt', 'x');
  await fs.promises.stat('probe.txt');
  let t = performance.now();
  for (let i = 0; i < 500; i++) await fs.promises.stat('probe.txt');
  const asyncUs = (performance.now() - t) * 1000 / 500;
  t = performance.now();
  for (let i = 0; i < 20000; i++) fs.statSync('probe.txt');
  const syncUs = (performance.now() - t) * 1000 / 20000;
  console.log('async_stat_us', asyncUs.toFixed(1), 'sync_stat_us', syncUs.toFixed(2));
})();`;
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  await step('write bench', `cat > bench.js <<'EOF'\n${bench}\nEOF`);
  for (let i = 1; i <= 2; i++) await step(`node bench #${i}`, 'node bench.js');
  await step('install python', 'nimbus install python 2>&1 | tail -1', 600_000);
  for (let i = 1; i <= 2; i++) {
    await step(`python stat x200 #${i}`, `python3 -c "import os,time\nopen('p.txt','w').write('x')\nt=time.perf_counter()\nfor _ in range(200): os.stat('p.txt')\nprint('per_call_us', round((time.perf_counter()-t)*1e6/200,1))"`);
  }
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
