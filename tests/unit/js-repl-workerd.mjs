// @serial
// @tier slow — drives a local workerd
// `node` and `bun` with no script at the terminal run their REPL, and a line
// typed there is evaluated where a Worker runs a program: compiled through
// the runtime-code service (core runtime/js-repl.ts), never refused as code
// generated at request time. For each: `1 + 1`, a `let` that lasts to the
// next line, top-level `await`, `require('fs')` reading the session's files,
// a continued line, a thrown error, and `.exit` back to the shell. And with
// no script and stdin not the terminal, stdin is the program, as in Node:
// `echo code | node` runs it, never a REPL.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.
import assert from 'node:assert/strict';
import { startLocalProbe } from './lib/workerd-probe.mjs';

/** What a string value prints as, in either quotes (the runtime's util.inspect). */
const STRING = (text) => new RegExp(`^['"]${text}['"]$`);

const probe = await startLocalProbe();
try {
  process.env.BASE = probe.base;
  process.env.NIMBUS_PROBE_TOKEN = probe.token;
  const { mintSession, deleteSession, Terminal, stripAnsi } = await import('../behavioral/_driver.mjs');
  const { pushLine } = await import('../behavioral/repl/_push.mjs');
  const sid = await mintSession();
  const t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(60_000);
  try {
    for (const [runtime, extra] of [['node', ['typeof process.versions.node', STRING('string')]], ['bun', ['typeof Bun.file', STRING('function')]]]) {
      t.reset();
      t.cmd(runtime);
      await t.waitFor((b) => /Type "\.help" for more information\.\s*\n?> $/.test(stripAnsi(b).replace(/\r/g, '')), 90_000, `${runtime} REPL prompt`);
      const push = (line) => pushLine(t, line, { prompt: /(?:>|\.\.\.)\s*$/, timeoutMs: 60_000 });
      const cases = [
        ['1 + 1', '2'],
        ['let x = 40', 'undefined'],
        ['x + 2', '42'],
        ['const y = await new Promise((resolve) => setTimeout(() => resolve(7), 50))', 'undefined'],
        ['y * 6', '42'],
        ["require('fs').writeFileSync('/home/user/repl.txt', 'from the repl'); require('fs').readFileSync('/home/user/repl.txt', 'utf8')", STRING('from the repl')],
        ['[1, 2,', ''],
        ['3].length', '3'],
        ["throw new TypeError('boom')", 'Uncaught TypeError: boom'],
        extra,
      ];
      for (const [line, expected] of cases) {
        const printed = (await push(line)).replace(/\r/g, '').trim();
        if (expected instanceof RegExp) assert.match(printed, expected, `${runtime}: ${line}`);
        else assert.equal(printed, expected, `${runtime}: ${line}`);
      }
      t.reset();
      t.cmd('.exit');
      await t.waitFor((b) => /user@nimbus:.*\$\s*$/.test(stripAnsi(b)), 30_000, `${runtime}: .exit returns to the shell`);
      console.log(`  ok   ${runtime}`);
    }
    for (const runtime of ['node', 'bun']) {
      const piped = await t.run(`echo 'console.log(6 * 7)' | ${runtime}; echo "STATUS=$?"`, 120_000);
      const text = stripAnsi(piped.output).replace(/\r/g, '');
      assert.match(text, /^42$/m, `${runtime}: piped stdin is the program\n${text}`);
      assert.match(text, /STATUS=0/, text);
      assert.doesNotMatch(text, /^> /m, `${runtime}: no REPL prompt for piped stdin`);
    }
  } finally {
    await t.close();
    await deleteSession(sid).catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('js-repl-workerd: node and bun REPLs evaluate through the runtime-code path');
