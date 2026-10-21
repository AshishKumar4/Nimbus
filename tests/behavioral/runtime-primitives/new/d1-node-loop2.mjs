#!/usr/bin/env bun
// Experiment (D1 measurement, not for landing): which part of a node one-shot's
// Math.imul loop is slow (ticket-node-oneshot-slow-loops.md). 2e6 rounds each:
// the loop as it was, with Math.imul read once, with another global read per
// round, and a Loader worker's burn after its module replaced Math.random.
import { mintSession, deleteSession, Terminal } from '../../_driver.mjs';
import { out } from './_d1-lib.mjs';

const N = 2e6;
const IMUL = `let h=0;for(let i=0;i<${N};i++)h=Math.imul(h^i,16777619);console.log(h)`;
const ARMS = {
  'esm -e': `node --input-type=module -e "${IMUL}"`,
  'use strict': `node -e "'use strict';${IMUL}"`,
  'globalThis.Math per round': `node -e "let h=0;for(let i=0;i<${N};i++)h=globalThis.Math.imul(h^i,16777619);console.log(h)"`,
  'local M per round': `node -e "const M=Math;let h=0;for(let i=0;i<${N};i++)h=M.imul(h^i,16777619);console.log(h)"`,
  'esm file': 'node loop.mjs',
  'cjs file': 'node loop.cjs',
  'imul': `node -e "let h=0;for(let i=0;i<${N};i++)h=Math.imul(h^i,16777619);console.log(h)"`,
  'imul read once': `node -e "const imul=Math.imul;let h=0;for(let i=0;i<${N};i++)h=imul(h^i,16777619);console.log(h)"`,
  'global JSON per round': `node -e "let h=0;for(let i=0;i<${N};i++)h=(h^i)*31+(JSON?1:0)|0;console.log(h)"`,
  'Math.abs per round': `node -e "let h=0;for(let i=0;i<${N};i++)h=(h^i)*31+Math.abs(1)|0;console.log(h)"`,
  'plain': `node -e "let h=0;for(let i=0;i<${N};i++)h=(h^i)*31|0;console.log(h)"`,
  'print': 'node -e "console.log(1)"',
};
const sid = await mintSession();
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  for (const [name, body] of [['loop.mjs', IMUL], ['loop.cjs', IMUL]]) await t.run(`cat > ${name} <<'EOF'\n${body}\nEOF`, 30_000);
  const facts = await t.run(`node -e "console.log(JSON.stringify({ desc: Object.getOwnPropertyDescriptor(globalThis, 'Math'), frozen: Object.isFrozen(Math), random: Math.random.name, own: Object.getOwnPropertyNames(Math).length, globals: Object.getOwnPropertyNames(globalThis).length, accessors: Object.getOwnPropertyNames(globalThis).filter((k) => { const d = Object.getOwnPropertyDescriptor(globalThis, k); return d && d.get; }).length }))"`, 60_000);
  out({ kind: 'facts', tail: facts.output.slice(-600) });
  const arms = Object.entries(ARMS);
  for (let i = 0; i < 3; i++) {
    for (let k = 0; k < arms.length; k++) {
      const [arm, line] = arms[(k + i) % arms.length];
      const started = Date.now();
      const r = await t.run(line, 600_000);
      out({ kind: 'loop', arm, i, ms: Date.now() - started, exit: r.exitCode });
    }
  }
} catch (error) {
  out({ kind: 'error', error: String(error?.message ?? error).slice(0, 2000) });
  process.exitCode = 1;
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
