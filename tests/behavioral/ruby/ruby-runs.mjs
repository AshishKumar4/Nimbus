#!/usr/bin/env bun
// ruby/ruby-runs - the Ruby interpreter actually boots and runs.
//
// install-ruby.mjs proves the runtime image lands in the VFS, and `ruby -v`
// answers from a hardcoded fast path that never touches the wasm - so neither
// of them notices a VM that cannot start. This probe boots it.
//
// It exists because the VM stopped booting entirely while both of those kept
// passing: every entry into the Ruby instance has to run under a
// WebAssembly.promising suspender, because the WASI imports it is given
// include WebAssembly.Suspending ones, and V8 traps ANY call into a suspending
// import off an unpromised stack. `ruby-init` / `ruby-init-loadpath` were
// called bare, so the interpreter answered every program with
// "trying to suspend without WebAssembly.promising".
//
// Public contract:
//   1. a one-liner evaluates and prints
//   2. a script file runs to completion and exits
//   3. a socket server binds a port and /s/<sid>/port/<n>/ serves it - the
//      shape that parks the guest, which is what suspension is for

import { fetchPort, heredocCommand, makeAsserter, mintSession, stripAnsi, Terminal } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'ruby/ruby-runs';
const a = makeAsserter(label);
console.log(`${label} - ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);

const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

const install = await t.run('nimbus install ruby', 300_000);
a.check('ruby runtime installs from the runtime catalog',
  /installed at|already installed/.test(stripAnsi(install.output))
    && !/catalog cannot be fetched|command not found/.test(stripAnsi(install.output)),
  JSON.stringify(stripAnsi(install.output).slice(-500)));

// 1. The one-liner. Arithmetic rather than a literal so the answer cannot come
//    from an echo of the command itself.
{
  const r = await t.run(`ruby -e 'puts 123 + 456'`, 180_000);
  const out = stripAnsi(r.output);
  a.check('ruby -e evaluates and prints (VM boots)',
    /(^|\n)\s*579\s*(\r|\n)/.test(out) && !/failed at request time|trying to suspend/.test(out),
    JSON.stringify(out.slice(-500)));
}

// 2. A script file. Different process shape - resident rather than pooled -
//    over the same VM boot.
{
  await t.run(heredocCommand('/home/user/hello.rb', 'puts "RUBY_SCRIPT_OK:" + (6 * 7).to_s\n'), 15_000);
  const r = await t.run('ruby /home/user/hello.rb', 180_000);
  const out = stripAnsi(r.output);
  a.check('a ruby script runs to completion and exits',
    /RUBY_SCRIPT_OK:42/.test(out) && !/failed at request time|trying to suspend/.test(out),
    JSON.stringify(out.slice(-500)));
}

// 3. The server. Accept parks the guest stack, so this is the case that
//    actually needs the suspender rather than merely tolerating it.
{
  const server = `require 'socket'

server = TCPServer.new('0.0.0.0', 3098)
loop do
  conn = server.accept
  conn.gets
  body = 'RUBY_HTTP_OK'
  conn.write("HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nContent-Length: #{body.bytesize}\\r\\n\\r\\n#{body}")
  conn.close
end
`;
  await t.run(heredocCommand('/home/user/rb-http.rb', server), 15_000);
  const started = await t.run('ruby /home/user/rb-http.rb', 180_000);
  const cleanStart = stripAnsi(started.output);
  a.check('ruby server starts as a long-running process on port 3098',
    /\[started \(long-running\): pid=\d+ cmd="ruby \/home\/user\/rb-http\.rb" port=3098\]/.test(cleanStart),
    JSON.stringify(cleanStart.slice(-500)));

  const r = await fetchPort(sid, 3098, 'hello');
  a.check('port proxy returns the Ruby server response',
    r.status === 200 && r.body === 'RUBY_HTTP_OK',
    `status=${r.status} body=${JSON.stringify(r.body)} elapsed=${r.elapsed}ms`);
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
