#!/usr/bin/env bun
// ruby/request-context-boundary — the platform fact the whole serving design
// rests on, made citable.
//
// A workerd request context will NOT resume a wasm stack that a different
// request suspended. A JSPI-suspended stack belongs to the request that
// suspended it; when that request ends, the suspension is orphaned and nothing
// can resume it. A Ruby fiber's state, by contrast, lives in the VM's own
// memory and survives.
//
// That is why a Nimbus server cannot simply block in accept, why the runtime
// drives long-running processes with a pump instead, and why Thread is backed
// by a fiber rather than by a suspending host call. Before this probe the
// measurement existed only in agent reports, which meant nobody could check it.
//
// Two servers, identical except for HOW they wait for a connection:
//
//   fiber park  - TCPServer#accept, which yields the fiber and is resumed by
//                 the next request. Serves request after request.
//   JSPI park   - reads the listening descriptor directly, suspending the wasm
//                 stack inside the request that happened to be running. Serves
//                 the FIRST request (the suspension and the resume are the same
//                 context) and then never answers again.
//
// Each runs as its own process, so wedging one cannot affect the other.

import {
  deleteSession, mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi,
  BASE, requestHeaders,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'ruby/request-context-boundary';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const FIBER_PORT = 8471;
const JSPI_PORT = 8472;
// Long enough that a served request cannot be mistaken for a timeout, short
// enough that proving the orphaned case does not cost the kernel's full window.
const CLIENT_TIMEOUT_MS = 8_000;

/** One request, with a bounded wait: {status} or {timedOut:true}. */
async function hit(sid, port, path) {
  const started = Date.now();
  try {
    const r = await fetch(`${BASE}/s/${sid}/port/${port}/${path}`, {
      headers: requestHeaders(),
      signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    });
    return { status: r.status, body: await r.text(), ms: Date.now() - started };
  } catch (e) {
    return { timedOut: e.name === 'TimeoutError', error: e.name, ms: Date.now() - started };
  }
}

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
const pids = [];
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  await t.run('nimbus install ruby', 180_000);
  await t.run('mkdir -p /home/user/rb-ctx && cd /home/user/rb-ctx', 10_000);

  // ── Fiber park: survives the boundary ────────────────────────────────────
  await t.run(heredocCommand('rb_fiber_park.rb', [
    'require "socket"',
    `server = TCPServer.new("0.0.0.0", ${FIBER_PORT})`,
    'n = 0',
    'loop do',
    '  sock = server.accept',           // parks the FIBER
    '  n += 1',
    '  sock.gets("\\r\\n\\r\\n")',
    '  body = "FIBER n=#{n}"',
    '  sock.write("HTTP/1.1 200 OK\\r\\nContent-Length: #{body.bytesize}\\r\\n\\r\\n#{body}")',
    '  sock.close',
    'end',
  ].join('\n')), 10_000);
  {
    const out = stripAnsi((await t.run('ruby rb_fiber_park.rb', 120_000)).output);
    pids.push(Number((out.match(/pid=(\d+)/) || [])[1] || 0));
    const first = await hit(sid, FIBER_PORT, 'one');
    const second = await hit(sid, FIBER_PORT, 'two');
    a.check('a fiber park survives the request boundary: the server keeps serving',
      first.status === 200 && first.body === 'FIBER n=1' &&
      second.status === 200 && second.body === 'FIBER n=2',
      `first=${JSON.stringify(first)} second=${JSON.stringify(second)}`);
  }

  // ── JSPI park: orphaned at the boundary ──────────────────────────────────
  // Reading the listening descriptor directly is accept(2) without the fiber:
  // the wasm stack suspends inside whichever request is running.
  await t.run(heredocCommand('rb_jspi_park.rb', [
    'require "socket"',
    `server = TCPServer.new("0.0.0.0", ${JSPI_PORT})`,
    // The descriptor underneath the listening socket; reading it blocks the
    // wasm stack rather than the fiber.
    `listener = File.open("/dev/nimbus/listen/#{server.__nimbus_virtual_port}", File::RDONLY)`,
    'n = 0',
    'loop do',
    '  id = listener.gets.to_s.strip',   // parks the WASM STACK
    '  break if id.empty?',
    '  sock = TCPSocket.__nimbus_from_connection(id.to_i, "0.0.0.0", ' + JSPI_PORT + ', "127.0.0.1", 0)',
    '  n += 1',
    '  sock.gets("\\r\\n\\r\\n")',
    '  body = "JSPI n=#{n}"',
    '  sock.write("HTTP/1.1 200 OK\\r\\nContent-Length: #{body.bytesize}\\r\\n\\r\\n#{body}")',
    '  sock.close',
    'end',
  ].join('\n')), 10_000);
  {
    const out = stripAnsi((await t.run('ruby rb_jspi_park.rb', 120_000)).output);
    pids.push(Number((out.match(/pid=(\d+)/) || [])[1] || 0));
    const first = await hit(sid, JSPI_PORT, 'one');
    const second = await hit(sid, JSPI_PORT, 'two');
    // The stack suspends during the request that STARTS the process, and that
    // request ends before any connection arrives - so the suspension is
    // orphaned immediately and the server never answers at all. Either
    // observable proves the same thing: no later request can resume it.
    const served = (r) => r.status === 200 && String(r.body).startsWith('JSPI');
    a.check('a JSPI park does not survive the request boundary: the server never answers',
      !served(first) && !served(second),
      `first=${JSON.stringify(first)} second=${JSON.stringify(second)} ` +
      `${JSON.stringify(out.slice(-200))} — if this ever passes, a suspended wasm ` +
      'stack has become resumable across requests and the pump exists for no reason');
  }

  for (const pid of pids) {
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
