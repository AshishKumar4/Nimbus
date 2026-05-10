#!/usr/bin/env bun
// multi-runtime/python-capture — CAPTURE-ONLY probe.
//
// Python (Pyodide) was scoped OUT of this wave during the
// feasibility check: running Pyodide inside a Nimbus DO requires
// implementing Emscripten's dlopen filesystem shim, dynamic linking
// of CPython native modules, and workarounds for no-sync-fetch /
// no-Atomics.wait. Cloudflare's first-class Python Workers solves
// this at the workerd C++ level — not reproducible inside a JS
// Worker DO without weeks of upstream-style work.
//
// This probe records the CURRENT state of `python` / `python3` shell
// commands on prod (most likely "command not found") so the next
// wave has a clean RED baseline.
//
// CAPTURE-ONLY — exit 0 always.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[python-capture] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(15_000).catch(() => {});

const probes = [];

async function run(cmd, timeoutMs) {
  t.reset();
  t.cmd(cmd);
  let returned = false;
  try {
    await t.waitForNewPrompt(timeoutMs);
    returned = true;
  } catch {
    returned = false;
    try { t.send('\x03'); } catch {}
    await sleep(500);
  }
  return { cmd, output: stripAnsi(t.buf), promptReturned: returned };
}

probes.push(await run('python --version', 15_000));
probes.push(await run('python3 --version', 15_000));
probes.push(await run('python -c "print(42)"', 15_000));
probes.push(await run('python3 -c "import sys; print(sys.version)"', 15_000));

await t.close();

const summary = probes.map((p) => ({
  cmd: p.cmd,
  promptReturned: p.promptReturned,
  commandNotFound: /command not found|not found/i.test(p.output),
  printedSomething: /^\s*\d+\s*$|Python\s+\d/m.test(p.output),
  outputTail: p.output.slice(-300),
}));

console.log(JSON.stringify({ probe: 'python-capture', sid, base: BASE, results: summary }, null, 2));

console.log('[python-capture] EXPECTED-RED — captured for forensic record');
process.exit(0);
