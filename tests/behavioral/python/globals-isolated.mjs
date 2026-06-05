// python/globals-isolated — separate python -c invocations do not share
// top-level globals even though the Pyodide interpreter stays warm.

import { mintSession, Terminal, stripAnsi, makeAsserter } from '../_driver.mjs';

const label = 'python/globals-isolated';
console.log(`${label} — ${process.env.BASE || 'http://127.0.0.1:8792'}`);
const a = makeAsserter(label);

const sid = await mintSession();
console.log(`SID: ${sid}`);

const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install python', 180_000);

const setOut = await t.run(`python -c 'x=999; print("set")'`, 120_000);
a.check('first python -c sets x and exits normally', /\bset\b/.test(stripAnsi(setOut.output)),
  stripAnsi(setOut.output).slice(-300));

const getOut = await t.run(`python -c 'print(globals().get("x", "missing"))'`, 120_000);
const clean = stripAnsi(getOut.output);
a.check('second python -c does not see previous globals', /\bmissing\b/.test(clean) && !/\b999\b/.test(clean),
  clean.slice(-300));

await t.close();

const s = a.summary();
if (s.fail) {
  throw new Error(`${label}: ${s.fail} failed: ${s.failures.join('; ')}`);
}
