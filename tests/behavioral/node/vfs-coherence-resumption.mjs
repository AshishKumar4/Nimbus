#!/usr/bin/env bun
// node/vfs-coherence-resumption — the owner's invariant, live.
//
//   "Any process shall have the view of the latest coherent global file system
//    state... the process, whether using sync or async apis, shall view the
//    same file system view."
//
// A facet resumes coherently when the thing that woke it was a supervisor
// reply, because the cache-invalidation delta rides on that reply. Three
// resumptions used to arrive with no reply behind them — a facet-local timer,
// an outbound fetch response, and an inbound socket frame — and on each of
// them a synchronous read served whatever the process was holding when it
// last heard from the authority.
//
// The unit suite proves each barrier against the real SqliteVFS in-process.
// This proves it on workerd, where the facet is a genuinely separate isolate
// and the peer write genuinely does not reach it.
//
// The peer is `POST /api/write-file`, which writes straight to the session's
// filesystem from OUTSIDE the session. That is the sharpest possible witness:
// there is no shell, no process, and no message of any kind between the writer
// and the parked facet, so nothing but the barrier can inform it. Detecting
// this anomaly at all requires comparing two clocks out of band, which is
// exactly why it went unnoticed.

import {
  mintSession, Terminal, makeAsserter, stripAnsi, sleep, requestHeaders, BASE,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('node/vfs-coherence-resumption');
console.log(`node/vfs-coherence-resumption — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

/** Write as a peer, with no communication edge to any running process. */
async function peerWrite(path, content) {
  const r = await fetch(`${BASE}/s/${sid}/api/write-file`, {
    method: 'POST',
    headers: requestHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ path, content }),
  });
  if (!r.ok) throw new Error(`peer write failed: ${r.status} ${await r.text().catch(() => '')}`);
}

const read = async (path) =>
  stripAnsi((await t.run(`cat ${path}`, 20_000)).output).replace(/\r/g, '');

// ── 1. the timer resumption ─────────────────────────────────────────────
{
  const path = '/home/user/coh-timer.txt';
  const result = '/home/user/coh-timer-result.txt';
  await peerWrite(path, 'BEFORE');
  const program = [
    'const fs=require("fs");',
    `fs.readFileSync("${path}","utf8");`,
    'setTimeout(()=>{',
    `fs.writeFileSync("${result}","TIMER_SAW["+fs.readFileSync("${path}","utf8")+"]");`,
    '},2500);',
  ].join('');
  const running = t.run(`node -e '${program}'`, 40_000);
  await sleep(900);
  await peerWrite(path, 'PEER_WROTE');
  await running;
  const out = await read(result);
  a.check(
    'a sync read inside a timer callback sees a peer write that landed during the sleep',
    /TIMER_SAW\[PEER_WROTE\]/.test(out),
    `tail: ${JSON.stringify(out.slice(-400))}`,
  );
  a.check(
    'the timer callback was served, not refused — a miss here is an unhandleable EAGAIN',
    !/EAGAIN/.test(out),
    `tail: ${JSON.stringify(out.slice(-400))}`,
  );
}

// ── 2. a synchronous write reaches the authority before the process exits ──
// A resident process that only wrote synchronously used to write back nothing
// until it exited, so a peer reading the same path got the pre-write bytes for
// the whole life of the process. The writer stays alive on a long timer while
// a separate process reads the same path.
{
  const path = '/home/user/coh-writeback.txt';
  const program = [
    'const fs=require("fs");',
    `fs.writeFileSync("${path}","WRITTEN_SYNCHRONOUSLY");`,
    'setTimeout(()=>{},8000);',
  ].join('');
  await t.run(`node -e '${program}' &`, 20_000);
  await sleep(2000);
  const seen = await read(path);
  a.check(
    'another process reads a synchronous write while the writing process is still running',
    /WRITTEN_SYNCHRONOUSLY/.test(seen),
    `tail: ${JSON.stringify(seen.slice(-300))}`,
  );
}

// ── 3. the outbound-fetch resumption ────────────────────────────────────
// The response is what encodes "the write happened", so the barrier has to be
// at least as late as the response — which is why it cannot ride concurrently
// with the request, however much cheaper that would be.
{
  const path = '/home/user/coh-fetch.txt';
  const result = '/home/user/coh-fetch-result.txt';
  await peerWrite(path, 'BEFORE');
  const program = [
    'const fs=require("fs");',
    `fs.readFileSync("${path}","utf8");`,
    'setTimeout(()=>{(async()=>{',
    'await fetch("https://cloudflare-dns.com/dns-query?name=example.com",',
    '{headers:{accept:"application/dns-json"}}).catch(()=>{});',
    `fs.writeFileSync("${result}","FETCH_SAW["+fs.readFileSync("${path}","utf8")+"]");`,
    '})();},1500);',
  ].join('');
  const running = t.run(`node -e '${program}'`, 40_000);
  await sleep(1100);
  await peerWrite(path, 'PEER_WROTE');
  await running;
  const out = await read(result);
  a.check(
    'a sync read after an outbound fetch sees a peer write that landed during it',
    /FETCH_SAW\[PEER_WROTE\]/.test(out),
    `tail: ${JSON.stringify(out.slice(-400))}`,
  );
}

// ── 4. the socket is relayed ────────────────────────────────────────────
// A facet does not open its own sockets any more: an inbound frame has to
// arrive as a supervisor reply, or it is a resumption no barrier can ride on.
{
  const program = [
    'const ws=new WebSocket("wss://echo.websocket.org/");',
    'console.log("WS_RELAYED["+ws.constructor.name+"]");',
    'ws.onopen=()=>{console.log("WS_OPEN");ws.send("ping");};',
    'ws.onmessage=(e)=>{console.log("WS_MESSAGE");ws.close();};',
    'ws.onerror=(e)=>{console.log("WS_ERROR["+(e&&e.message)+"]");};',
    'setTimeout(()=>{},6000);',
  ].join('');
  const out = stripAnsi((await t.run(`node -e '${program}'`, 45_000)).output).replace(/\r/g, '');
  a.check(
    'the global WebSocket is the supervisor-relayed one, not the platform socket',
    /WS_RELAYED\[NimbusWebSocket\]/.test(out),
    `tail: ${JSON.stringify(out.slice(-500))}`,
  );
  a.check(
    'a relayed socket either connects or reports why — it never silently does nothing',
    /WS_OPEN|WS_ERROR/.test(out),
    `tail: ${JSON.stringify(out.slice(-500))}`,
  );
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
