#!/usr/bin/env bun
// clang/warm-process-isolation — `clang` and `wasm-ld` run on the warm
// workers an earlier `clang` of the session ran on, and each compile and
// link is its own: two programs built back to back each print their own
// line, a compile-only run (`clang -c`) leaves its worker warm too, and a
// compile killed mid-run leaves the next one working. Reuse is read from the
// session's facet-call record, not timed.

import { mintSession, Terminal, makeAsserter, deleteSession, stripAnsi, heredocCommand } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'clang/warm-process-isolation';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

const run = async (command, ms = 180_000) => {
  const { output, exitCode } = await t.run(command, ms);
  return { text: stripAnsi(output), exitCode };
};
/** The session's facet calls of `tool` (clang, wasm-ld) since `since`. */
const callsOf = async (tool, since) => {
  const calls = await t.facetCalls();
  return typeof calls === 'string' ? calls : calls.filter((call) => call.tag === `clang-runner-${tool}` && call.at >= since);
};
const source = (word) => `#include <stdio.h>\nint main(void) { puts("${word}"); return 0; }\n`;

try {
  await run('nimbus install clang');
  await run(heredocCommand('/tmp/one.c', source('ONE')), 10_000);
  await run(heredocCommand('/tmp/two.c', source('TWO')), 10_000);
  // The first build of the session is cold; it leaves both tools' workers warm.
  await run('clang /tmp/one.c -o /tmp/one');

  const since = Date.now();
  const two = await run('clang /tmp/two.c -o /tmp/two && /tmp/two && /tmp/one');
  const clangCalls = await callsOf('clang', since);
  const ldCalls = await callsOf('wasm-ld', since);
  a.check('the next build runs clang and wasm-ld on warm workers',
    Array.isArray(clangCalls) && clangCalls.length > 0 && clangCalls.every((call) => call.cold === false)
      && Array.isArray(ldCalls) && ldCalls.length > 0 && ldCalls.every((call) => call.cold === false),
    JSON.stringify({ clangCalls, ldCalls }));
  a.check('each build is its own program', /TWO\s+ONE/.test(two.text) && two.exitCode === 0, two.text.slice(-300));

  // ── A compile-only run gives its worker back too ───────────────────────
  await run('clang -c /tmp/one.c -o /tmp/one.o');
  const compileSince = Date.now();
  const compiled = await run('clang -c /tmp/two.c -o /tmp/two.o && ls /tmp/two.o');
  const compileCalls = await callsOf('clang', compileSince);
  a.check('clang -c runs warm after another clang -c', Array.isArray(compileCalls) && compileCalls.length > 0 && compileCalls.every((call) => call.cold === false) && compiled.exitCode === 0,
    JSON.stringify({ compileCalls, out: compiled.text.slice(-200) }));

  // ── Killed mid-run: the next build works ───────────────────────────────
  await run(heredocCommand('/tmp/slow.c', 'int main(void) { return 0; }\n'), 10_000);
  await run('timeout 0.3 clang /tmp/slow.c -o /tmp/slow');
  const after = await run('clang /tmp/one.c -o /tmp/again && /tmp/again');
  a.check('a build after one killed mid-run works', /ONE/.test(after.text) && after.exitCode === 0, after.text.slice(-300));
} catch (error) {
  a.check('the scenario ran', false, error instanceof Error ? error.message : String(error));
} finally {
  await t.close();
  await deleteSession(sid);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
