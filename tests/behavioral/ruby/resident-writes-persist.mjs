#!/usr/bin/env bun
// ruby/resident-writes-persist — a running Ruby server's writes reach the
// session filesystem WHILE IT IS STILL RUNNING.
//
// This is the property that let the exit-time filesystem diff be deleted.
// Under that model a wasm process snapshotted its filesystem once at spawn and
// handed back a diff only when it exited, so a server — which never exits —
// persisted nothing at all: every file it wrote was lost when the session
// ended. Write-through replaces it, and the claim it has to earn is exactly
// this one, so the probe never kills the server before checking.
//
// The shell reading the file is a DIFFERENT process against the same session
// VFS, so a pass means the bytes really landed there and are not merely
// sitting in the writer's own cache.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi, fetchPort } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'ruby/resident-writes-persist';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install ruby', 180_000);
await t.run('mkdir -p /home/user/resident && cd /home/user/resident', 10_000);

// A plain TCPServer, so nothing depends on a gem being installable. Each
// request appends a line to a log AND writes a per-request file, then answers
// with what it wrote. The server loops forever — it is never asked to exit.
const SERVER = `
require 'socket'
server = TCPServer.new('0.0.0.0', 8131)
count = 0
loop do
  conn = server.accept
  begin
    req = conn.gets.to_s
    count += 1
    File.open('served.log', 'a') { |f| f.puts("request #{count} #{req.split(' ')[1]}") }
    File.write("reply-#{count}.txt", "resident-write-#{count}\\n")
    body = "served #{count}"
    conn.print("HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nContent-Length: #{body.bytesize}\\r\\nConnection: close\\r\\n\\r\\n")
    conn.print(body)
  ensure
    conn.close rescue nil
  end
end
`.trim();

await t.run(heredocCommand('server.rb', SERVER), 10_000);

let pid = 0;
{
  const { output } = await t.run('ruby server.rb', 60_000);
  const stripped = stripAnsi(output);
  const m = stripped.match(/pid=(\d+)/);
  pid = m ? Number(m[1]) : 0;
  a.check('ruby TCPServer starts as a long-running virtual-socket process',
    pid > 0, JSON.stringify(stripped.slice(-800)));
}

{
  const r = await fetchPort(sid, 8131, 'first');
  a.check('port route reaches the resident Ruby server',
    r.status === 200 && /served 1/.test(r.body),
    `status=${r.status} body=${JSON.stringify(r.body.slice(0, 200))}`);
}
{
  const r = await fetchPort(sid, 8131, 'second');
  a.check('the resident server keeps serving across requests',
    r.status === 200 && /served 2/.test(r.body),
    `status=${r.status} body=${JSON.stringify(r.body.slice(0, 200))}`);
}

// THE GATE. The server is still running and has never exited, so anything on
// disk here got there by write-through and nothing else.
{
  const { output } = await t.run('cat reply-1.txt reply-2.txt', 20_000);
  const stripped = stripAnsi(output);
  a.check('files a STILL-RUNNING server wrote are readable by another process',
    /resident-write-1/.test(stripped) && /resident-write-2/.test(stripped),
    JSON.stringify(stripped.slice(-600)));
}
{
  const { output } = await t.run('cat served.log', 20_000);
  const stripped = stripAnsi(output);
  a.check('appends from a still-running server are durable in order',
    /request 1 \/first/.test(stripped) && /request 2 \/second/.test(stripped),
    JSON.stringify(stripped.slice(-600)));
}

if (pid > 0) await t.run(`kill ${pid}`, 10_000).catch(() => {});
await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
