#!/usr/bin/env bun
// ruby/language-surface — the same Ruby, whichever shape the process takes.
//
// Nimbus runs a Ruby invocation as one of two process shapes: a one-liner is
// answered from a pooled VM, a script gets a process that can outlive the
// command. That choice is about lifetime and nothing else. It used to decide
// the LANGUAGE too - green threads and the socket classes were installed only
// on the resident path, so `ruby -e 'Thread.new{}'` raised NotImplementedError
// while the identical line in a script file worked. A program should get
// threads because it is Ruby, not because of how it was launched.
//
// So this probe runs one program three ways and demands the same answer.

import {
  deleteSession, mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'ruby/language-surface';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

// A thread handing a value to another thread through a queue, under both of
// Ruby's names for that queue. Nothing here works without green threads.
const PROGRAM = [
  'q = Thread::Queue.new',
  'got = Thread.new { q.pop }',
  'q.push(41 + 1)',
  'puts "SURFACE value=#{got.value} top=#{Queue.name} ns=#{Thread::Queue.name} ' +
    'mutex=#{Thread::Mutex.name} socket=#{$LOADED_FEATURES.include?("socket.rb")}"',
].join('; ');

const EXPECTED = 'SURFACE value=42 top=NimbusQueue ns=NimbusQueue mutex=NimbusMutex socket=true';

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  await t.run('nimbus install ruby', 180_000);
  await t.run('mkdir -p /home/user/rb-surface && cd /home/user/rb-surface', 10_000);

  const shapes = [
    ['as a one-liner', `ruby -e '${PROGRAM}'`],
    ['as a one-liner that also asked for sockets', `ruby -r socket -e '${PROGRAM}'`],
  ];
  await t.run(heredocCommand('surface.rb', PROGRAM.split('; ').join('\n')), 10_000);
  shapes.push(['as a script file', 'ruby surface.rb']);

  for (const [how, cmd] of shapes) {
    const out = stripAnsi((await t.run(cmd, 180_000)).output);
    a.check(`threads, queues and sockets are there ${how}`,
      out.includes(EXPECTED),
      `cmd=${cmd} output=${JSON.stringify(out.slice(-500))}`);
  }

  {
    // A one-liner has no process to hold a port open. That is a real limit, so
    // it has to be stated as one rather than surfacing as a missing library.
    const out = stripAnsi((await t.run(`ruby -e 'require "socket"; TCPServer.new(9411)'`, 120_000)).output);
    a.check('binding a port from a one-liner explains why it cannot',
      /SocketError/.test(out) && /outlives the command/.test(out) &&
      !/cannot load such file/.test(out),
      JSON.stringify(out.slice(-500)));
  }

  {
    // The exit code travels on a stderr side channel. A server parks rather
    // than exiting, which leaves that channel readable by whoever prints next.
    await t.run(heredocCommand('surface_server.rb', [
      'require "socket"',
      'server = TCPServer.new("0.0.0.0", 9412)',
      'loop do',
      '  conn = server.accept',
      '  conn.gets("\\r\\n\\r\\n")',
      '  conn.write("HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nok")',
      '  conn.close',
      'end',
    ].join('\n')), 10_000);
    const out = stripAnsi((await t.run('ruby surface_server.rb', 60_000)).output);
    const pid = Number((out.match(/pid=(\d+)/) || [])[1] || 0);
    a.check('a parked server does not print the runtime exit marker',
      /port=9412/.test(out) && !/__NIMBUS_RUBY_EXIT/.test(out),
      JSON.stringify(out.slice(-400)));
    if (pid > 0) await t.run(`kill ${pid}`, 10_000).catch(() => {});
  }
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
