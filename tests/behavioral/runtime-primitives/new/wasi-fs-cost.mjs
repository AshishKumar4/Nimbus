// What a filesystem call costs a guest, timed by the client and the guest:
// python's os.stat loop and a clang compile that reads headers (WASI guests),
// and node one-shots (node's resident store), so the WASI fast path is judged
// on the first two and shown not to move the third. Prints one JSON line per
// step; asserts only that each step ran.
import { mintSession, deleteSession, Terminal, stripAnsi, makeAsserter } from '../../_driver.mjs';

const a = makeAsserter('wasi-fs-cost');
const sid = await mintSession();
const t = new Terminal(sid);
const results = {};
const step = async (label, cmd, timeout = 900_000) => {
  const started = Date.now();
  const r = await t.run(cmd, timeout);
  const out = stripAnsi(r.output).replace(/\s+$/, '');
  const wallMs = Date.now() - started;
  results[label] = { wallMs, out: out.slice(-300) };
  console.log(JSON.stringify({ label, wallMs, out: out.slice(-300) }));
  return { ...r, output: out };
};
const hello = '#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <math.h>\nint main(void) { printf("%f\\n", sqrt(2.0)); return 0; }\n';
const nodeReads = "const fs=require('fs');const t=performance.now();let n=0;for(const f of fs.readdirSync('.'))if(fs.statSync(f).isFile())n+=fs.readFileSync(f).length;console.log('bytes',n,'ms',(performance.now()-t).toFixed(1));";
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  await step('install python', 'nimbus install python 2>&1 | tail -1', 900_000);
  await step('install clang', 'nimbus install clang 2>&1 | tail -1', 900_000);
  // Timed by the client: a facet's clock does not move between I/Os, so a
  // loop of calls answered locally reads as free from inside. The per-call
  // cost is the difference between N stats and none, over N.
  await step('python write p.txt', `python3 -c "open('p.txt','w').write('x')"`);
  for (const n of [0, 2000, 20000]) {
    const { output: out } = await step(`python stat x${n}`, `python3 -c "import os\nfor _ in range(${n}): os.stat('p.txt')\nprint('done', ${n})"`, 1_800_000);
    a.check(`python ran ${n} stats`, out.includes(`done ${n}`), out.slice(-200));
  }
  const perCall = (n) => ((results[`python stat x${n}`].wallMs - results['python stat x0'].wallMs) * 1000) / n;
  console.log(JSON.stringify({ pythonStatPerCallUs: { x2000: Math.round(perCall(2000)), x20000: Math.round(perCall(20000)) } }));
  await step('write hello.c', `cat > hello.c <<'EOF'\n${hello}EOF`);
  for (let i = 1; i <= 3; i++) {
    const result = await step(`clang hello.c #${i}`, 'clang hello.c -o hello.wasm -lm');
    a.check(`clang hello.c #${i} compiled`, result.exitCode === 0, result.output.slice(-200));
  }
  const { output: ran } = await step('run hello', './hello.wasm');
  a.check('the compiled program ran', /1\.414214/.test(ran), ran.slice(-200));
  for (let i = 1; i <= 3; i++) await step(`node -e #${i}`, "node -e 'console.log(1)'");
  await step('write node reads', `cat > reads.js <<'EOF'\n${nodeReads}\nEOF`);
  for (let i = 1; i <= 3; i++) await step(`node reads #${i}`, 'node reads.js');
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
console.log(JSON.stringify({ summary: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.wallMs])) }));
const { fail } = a.summary();
process.exit(fail > 0 ? 1 : 0);
