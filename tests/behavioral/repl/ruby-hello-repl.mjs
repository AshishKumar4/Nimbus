#!/usr/bin/env bun
// repl/ruby-hello-repl — `ruby` with no args drops into REPL, in the shell's
// working directory, over the session filesystem: it reads a file there by
// its relative name and writes one the shell then sees.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('repl/ruby-hello-repl');
console.log(`repl/ruby-hello-repl — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);
await t.run('nimbus install ruby', 240_000);
await t.run('mkdir -p /home/user/rubyrepl && cd /home/user/rubyrepl && echo RUBY_REPL_CWD_OK > here.txt', 10_000);

t.reset();
t.cmd('ruby');
try {
  await t.waitFor((b) => /irb> /.test(b), 30_000, 'ruby repl prompt');
  a.check('ruby no-args drops into REPL with irb> prompt', true,
    JSON.stringify(stripAnsi(t.buf).slice(-200)));
} catch (e) {
  a.check('ruby no-args drops into REPL with irb> prompt', false, `${e.message}`);
  await t.close();
  process.exit(1);
}

t.reset();
t.cmd('puts "hi"');
await t.waitFor((b) => /\bhi\b/m.test(b), 30_000, 'puts "hi" output');
const out1 = stripAnsi(t.buf);
a.check('puts "hi" prints "hi" in REPL', /\bhi\b/m.test(out1),
  JSON.stringify(out1.slice(-200)));

t.reset();
t.cmd('1 + 2');
await t.waitFor((b) => /=>.*3\b/.test(b), 20_000, 'expression value');
const out2 = stripAnsi(t.buf);
a.check('bare expression 1+2 prints "=> 3" (irb convention)',
  /=>.*3\b/.test(out2), JSON.stringify(out2.slice(-200)));

t.reset();
t.cmd('print Dir.pwd, " ", File.read("here.txt")');
await t.waitFor((b) => /RUBY_REPL_CWD_OK|Error|can't enter/.test(b), 30_000, 'cwd read');
const out3 = stripAnsi(t.buf);
a.check('the REPL starts in the shell\'s cwd and reads a file there',
  /\/home\/user\/rubyrepl RUBY_REPL_CWD_OK/.test(out3) && !/can't enter|undefined:/.test(out3), JSON.stringify(out3.slice(-300)));

t.reset();
t.cmd('File.write("from-irb.txt", "IRB_WROTE_THIS")');
await t.waitFor((b) => /=>|Error/.test(b), 30_000, 'write result');

t.reset();
t.cmd('exit');
await t.waitFor((b) => /[$#]\s*$/.test(b.trimEnd().slice(-3)), 15_000, 'shell prompt');

const wrote = await t.run('cat /home/user/rubyrepl/from-irb.txt', 10_000);
a.check('a file the REPL writes is on the session filesystem',
  /IRB_WROTE_THIS/.test(stripAnsi(wrote.output)), JSON.stringify(stripAnsi(wrote.output).slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
