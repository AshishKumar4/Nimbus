#!/usr/bin/env bun
// Experiment (D1 measurement, not for landing): why a node one-shot's loop runs
// ~200x slower than a Loader worker's (ticket-node-oneshot-slow-loops.md).
// The same 2e6-round loop, run three times each way, round-robin.
import { mintSession, deleteSession, Terminal } from '../../_driver.mjs';
import { out, heredoc } from './_d1-lib.mjs';

const N = 2e6;
const IMUL = `let h=0;for(let i=0;i<${N};i++)h=Math.imul(h^i,16777619);console.log(h)`;
const PLAIN = `let h=0;for(let i=0;i<${N};i++)h=(h^i)*31|0;console.log(h)`;
const EMPTY = `let i=0;for(;i<${N};i++);console.log(i)`;
const IN_FN = `function f(){let h=0;for(let i=0;i<${N};i++)h=Math.imul(h^i,16777619);return h}console.log(f())`;
const ARMS = {
  'node -e imul': `node -e "${IMUL}"`,
  'node -e plain': `node -e "${PLAIN}"`,
  'node -e empty': `node -e "${EMPTY}"`,
  'node -e in function': `node -e "${IN_FN}"`,
  'node file imul': 'node loop.js',
  'node file in function': 'node loop-fn.js',
  'node -e print': 'node -e "console.log(1)"',
  'node file print': 'node print.js',
};

const sid = await mintSession();
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  for (const line of [heredoc('loop.js', IMUL + '\n'), heredoc('loop-fn.js', IN_FN + '\n'), heredoc('print.js', 'console.log(1)\n')]) {
    const r = await t.run(line, 60_000);
    if (r.exitCode !== 0) throw new Error(`setup failed: ${r.output.slice(-300)}`);
  }
  const arms = Object.entries(ARMS);
  for (let i = 0; i < 3; i++) {
    for (let k = 0; k < arms.length; k++) {
      const [arm, line] = arms[(k + i) % arms.length];
      const started = Date.now();
      const r = await t.run(line, 600_000);
      out({ kind: 'loop', arm, i, ms: Date.now() - started, exit: r.exitCode, tail: r.output.slice(-120) });
    }
  }
} catch (error) {
  out({ kind: 'error', error: String(error?.message ?? error).slice(0, 2000) });
  process.exitCode = 1;
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
