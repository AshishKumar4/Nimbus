// @serial
// @tier slow — drives a local workerd
// `node` and `bun` with no script at the terminal run their REPL, and a line
// typed there is evaluated where a Worker runs a program: compiled through
// the runtime-code service (core runtime/js-repl.ts), never refused as code
// generated at request time. For each: `1 + 1`, a `let` that lasts to the
// next line, top-level `await`, `require('fs')` reading the session's files,
// a continued line, a thrown error, and `.exit` back to the shell; a
// rejection and a timer's exception no one handles, after which the REPL
// goes on with `_error`; Ctrl-C, which the terminal hands it as input,
// abandoning a pending block and keeping the session; `.break` mid-block;
// `import('./dep.mjs')` from the working directory, interpreted in the
// launch that first runs the line and natively (from the staged `gen/`
// module) in the next. And with no script and stdin not the terminal, stdin
// is the program, as in Node: `echo code | node` runs it, never a REPL.
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
      const settle = () => new Promise((resolve) => setTimeout(resolve, 1_000));
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
      const check = async (line, expected) => {
        const printed = (await push(line)).replace(/\r/g, '').trim();
        if (expected instanceof RegExp) assert.match(printed, expected, `${runtime}: ${line}`);
        else assert.equal(printed, expected, `${runtime}: ${line}`);
      };
      for (const [line, expected] of cases) await check(line, expected);
      // What no line awaits: reported, and the REPL goes on.
      // (Its report and the line's value may come in either order.)
      await push("void Promise.reject(new Error('rejected'))");
      await settle();
      await check('_error.message', STRING('rejected'));
      await check("setTimeout(() => { throw new Error('timer') }, 10); 2", '2');
      await settle();
      await check('_error.message', STRING('timer'));
      // Ctrl-C abandons a pending block; the session's bindings stay.
      t.reset();
      t.cmd('[');
      await t.waitFor((b) => /\.\.\. $/.test(stripAnsi(b).replace(/\r/g, '')), 30_000, `${runtime}: pending block`);
      t.reset();
      t.send('\x03');
      await t.waitFor((b) => /> $/.test(stripAnsi(b).replace(/\r/g, '')), 30_000, `${runtime}: prompt after Ctrl-C`);
      await check('x + 2', '42');
      // .break abandons one too.
      t.reset();
      t.cmd('[');
      await t.waitFor((b) => /\.\.\. $/.test(stripAnsi(b).replace(/\r/g, '')), 30_000, `${runtime}: pending block`);
      await check('.break', '');
      await check('2 + 2', '4');
      t.reset();
      t.cmd('.exit');
      await t.waitFor((b) => /user@nimbus:.*\$\s*$/.test(stripAnsi(b)), 30_000, `${runtime}: .exit returns to the shell`);
      console.log(`  ok   ${runtime}`);
    }
    // import() from the working directory: interpreted in the launch that
    // first runs the line, then from the module it staged for the next.
    await t.run("printf 'export const v = 42;\\n' > /home/user/dep.mjs && cd /home/user", 30_000);
    const IMPORT_LINE = "[(await import('./dep.mjs')).v, new Error().stack.includes('/gen/')]";
    for (const ran of ['false', 'true']) {
      t.reset();
      t.cmd('node');
      await t.waitFor((b) => /Type "\.help" for more information\.\s*\n?> $/.test(stripAnsi(b).replace(/\r/g, '')), 90_000, 'node REPL prompt');
      const printed = (await pushLine(t, IMPORT_LINE, { prompt: /(?:>|\.\.\.)\s*$/, timeoutMs: 60_000 })).replace(/\r/g, '').trim();
      // (The runtime's util.inspect may break the array over lines.)
      assert.equal(printed.replace(/\s+/g, ''), `[42,${ran}]`, `import() from the working directory, ${ran === 'true' ? 'staged' : 'interpreted'}`);
      t.reset();
      t.cmd('.exit');
      await t.waitFor((b) => /user@nimbus:.*\$\s*$/.test(stripAnsi(b)), 30_000, '.exit returns to the shell');
    }
    console.log('  ok   import() interpreted, then staged');
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
