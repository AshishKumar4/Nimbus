// The JavaScript REPL a runtime runs with no script at the terminal (core
// runtime/js-repl.ts), checked by what each line prints: a value, a `let`
// that lasts to the next line, top-level `await`, `require('fs')` reading
// and writing the session's files, a continued line, a thrown error, and
// `.exit` back to the shell. A line's echo is never taken for its output:
// pushLine reads what comes between the echo and the next prompt.
//
// A string value prints quoted as the runtime's util.inspect quotes it.

import { mintSession, deleteSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';
import { pushLine } from './_push.mjs';

/** What a string value prints as, in either quotes. */
export const STRING = (text) => new RegExp(`^['"]${text}['"]$`);

/** Probe `runtime`'s REPL, plus `extra` [line, printed] pairs of its own; exits the process. */
export async function probeJsRepl(runtime, extra) {
  if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
  const label = `repl/${runtime}-hello-repl`;
  const a = makeAsserter(label);
  console.log(`${label} — ${process.env.BASE}`);
  const sid = await mintSession();
  const t = new Terminal(sid);
  try {
    await t.connect();
    await t.waitForPrompt(60_000);
    t.reset();
    t.cmd(runtime);
    try {
      await t.waitFor((b) => /> $/.test(stripAnsi(b).replace(/\r/g, '')), 90_000, `${runtime} REPL prompt`);
      a.check(`${runtime} with no script at the terminal drops into its REPL`, true);
    } catch (e) {
      a.check(`${runtime} with no script at the terminal drops into its REPL`, false, e.message);
      return;
    }
    const cases = [
      ['1 + 1', '2'],
      ['let x = 40', 'undefined'],
      ['x + 2', '42'],
      ['const y = await new Promise((resolve) => setTimeout(() => resolve(7), 50))', 'undefined'],
      ['y * 6', '42'],
      ["require('fs').writeFileSync('/home/user/repl.txt', 'from the repl')", 'undefined'],
      ["require('fs').readFileSync('/home/user/repl.txt', 'utf8')", STRING('from the repl')],
      ['[1, 2,', ''],
      ['3].length', '3'],
      ["throw new TypeError('boom')", 'Uncaught TypeError: boom'],
      ...extra,
    ];
    for (const [line, expected] of cases) {
      let printed;
      try {
        printed = (await pushLine(t, line, { prompt: /(?:>|\.\.\.)\s*$/, timeoutMs: 60_000 })).replace(/\r/g, '').trim();
      } catch (e) {
        printed = `(no prompt: ${e.message}) ${JSON.stringify(stripAnsi(t.buf).slice(-200))}`;
      }
      a.check(`${line} prints ${expected}`, expected instanceof RegExp ? expected.test(printed) : printed === expected, JSON.stringify(printed));
    }
    t.reset();
    t.cmd('.exit');
    try {
      await t.waitFor((b) => /user@nimbus:.*\$\s*$/.test(stripAnsi(b)), 30_000, 'shell prompt');
      a.check('.exit returns to the shell', true);
    } catch (e) {
      a.check('.exit returns to the shell', false, e.message);
    }
    const file = await t.run('cat /home/user/repl.txt', 10_000);
    a.check('a file the REPL wrote is on the session filesystem', /from the repl/.test(stripAnsi(file.output)),
      JSON.stringify(stripAnsi(file.output).slice(-200)));
  } finally {
    await t.close();
    await deleteSession(sid).catch(() => {});
    const sum = a.summary();
    process.exit(sum.fail > 0 ? 1 : 0);
  }
}
