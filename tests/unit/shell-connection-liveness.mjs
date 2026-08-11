#!/usr/bin/env bun
// shell-connection-liveness — the session shell must be able to tell a
// live session from a dead one.
//
// A supervisor DO reset drops the shell WebSocket SERVER-side without
// closing it: ctx.getWebSockets() comes back empty while the browser
// still reports readyState === OPEN and fires neither 'close' nor
// 'error'. ws.onclose — and the reconnect hanging off it — never runs,
// so the user sits at a terminal that looks alive and answers nothing.
// Measured at 85s and counting, 3/3 runs, on a deployed Worker.
//
// This exercises the shipped `Conn` module out of public/s/index.html
// against a fake socket and a fake clock. The behaviours that matter:
//
//   - the probe must be one the ACTOR answers. `ping` is answered by the
//     runtime's configured auto-response WITHOUT waking the actor
//     (ws-hibernation-config.ts), so it would pong on exactly the dead
//     socket we are hunting.
//   - silence alone is never a verdict. Only a FRESH answer on the
//     independent HTTP channel separates "this socket is dead" from
//     "this session is slow".
//   - a session the server has disowned must be said out loud, not
//     retried forever in silence.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = join(HERE, '../../packages/worker/public/s/index.html');

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

// ── Extract the module from the shipped asset ──────────────────────────
const html = readFileSync(SHELL, 'utf8');
const START = '    const Conn = (function () {';
const END = '\n    })();';
const startIdx = html.indexOf(START);
if (startIdx < 0) {
  console.error('FATAL: connection-liveness module not found in public/s/index.html');
  process.exit(1);
}
const endIdx = html.indexOf(END, startIdx);
if (endIdx < 0) {
  console.error('FATAL: connection-liveness module has no terminator');
  process.exit(1);
}
const moduleSource = html.slice(startIdx, endIdx + END.length);

/** A fresh WebSocket is CONNECTING (0) until its open event fires. */
function makeSocket() {
  return {
    readyState: 0,
    sent: [],
    closed: false,
    send(frame) {
      if (this.readyState !== 1) throw new Error('socket not open');
      this.sent.push(JSON.parse(frame));
    },
    close() { this.closed = true; this.readyState = 3; },
  };
}

/**
 * Instantiate the module with every collaborator stubbed. The wrapper
 * reproduces the page's own shape — `ws` is an outer binding and
 * `connect()` a hoisted declaration that reassigns it — so the module
 * source stays byte-identical to what ships.
 */
function instantiate() {
  const h = {
    now: 1_000_000,
    socket: makeSocket(),
    written: [],
    status: [],
    events: [],
    statsPolls: 0,
    connects: 0,
    tick: null,
    makeSocket,
  };

  const factory = new Function(
    'h', 'term', 'setStatus', 'refreshStats', 'WebSocket',
    'postNimbusEvent', 'clearNimbusDisconnectError', 'Date', 'setInterval',
    `
    let ws = h.socket;
    // Mirrors the page: connect() installs a fresh socket, whose onopen
    // hands back to Conn.onOpen(). h.deadEnd models a reconnect that
    // never opens.
    function connect() {
      h.connects++;
      ws = h.socket = h.makeSocket();
      if (!h.deadEnd) { ws.readyState = 1; Conn.onOpen(); }
    }
    ${moduleSource}
    h.attach = (s) => { ws = h.socket = s; };
    h.liveWs = () => ws;
    return Conn;
    `,
  );

  h.Conn = factory(
    h,
    { write: (s) => h.written.push(s) },
    (cls, label) => h.status.push({ cls, label }),
    () => { h.statsPolls++; },
    { OPEN: 1, CLOSED: 3 },
    (type, payload) => h.events.push({ type, ...payload }),
    () => {},
    { now: () => h.now },
    (fn) => { h.tick = fn; },
  );

  /** Advance the fake clock and run every tick that falls in the window. */
  h.advance = (ms) => {
    for (let step = 0; step < ms; step += 5_000) {
      h.now += Math.min(5_000, ms - step);
      h.tick();
    }
  };
  h.text = () => h.written.join('');
  return h;
}

/** Bring a fresh instance up to a healthy, connected steady state. */
function connected() {
  const s = instantiate();
  s.socket.readyState = 1;
  s.Conn.onOpen();
  s.Conn.noteHttp(true, 200);
  return s;
}

// ── The probe must be one the actor answers ────────────────────────────
{
  const s = connected();
  s.advance(5_000);
  const frames = s.socket.sent;
  check('the shell probes the socket once it goes quiet', frames.length > 0);

  const raw = JSON.stringify(frames);
  check('the probe is NOT `ping` — the runtime auto-responds to that without waking the actor',
    !raw.includes('"ping"') && !frames.some((f) => f === 'ping'),
    raw);
  check('the probe is a frame the actor must handle to answer',
    frames.every((f) => f.type === 'fs-watch-unsubscribe'),
    raw);
  check('the probe carries a subId — omitting it would drop every real subscription',
    frames.every((f) => typeof f.subId === 'string' && f.subId.length > 0),
    raw);
  check('the probe carries a correlatable reqId',
    frames.every((f) => typeof f.reqId === 'string' && f.reqId.length > 0),
    raw);
  check('the shell claims its own probe replies so they never reach shell dispatch',
    s.Conn.tryHandleProbeResult({ type: 'fs-watch-unsubscribe-result', ok: true, removed: 0, reqId: frames[0].reqId }) === true &&
    s.Conn.tryHandleProbeResult({ type: 'fs-watch-unsubscribe-result', ok: true, removed: 1, reqId: 7 }) === false);
}

// ── A socket that answers is left alone ────────────────────────────────
{
  const s = connected();
  for (let i = 0; i < 12; i++) {
    s.advance(5_000);
    s.Conn.noteInbound();       // the actor replies to every probe
    s.Conn.noteHttp(true, 200);
  }
  check('a socket whose probes are answered is never torn down',
    s.socket.closed === false);
  check('a healthy session never reconnects behind the user',
    s.connects === 0);
  check('a healthy session says nothing in the terminal',
    s.text() === '', JSON.stringify(s.text()));
}

// ── THE REGRESSION: silent socket + live HTTP = a dead socket ──────────
{
  const s = connected();
  const dead = s.socket;
  // The socket goes silent, exactly as it does after a DO reset: no
  // close, no error, readyState stays OPEN. HTTP keeps answering,
  // because a fresh request instantiates the DO again.
  for (let i = 0; i < 4; i++) {
    s.advance(5_000);
    s.Conn.noteHttp(true, 200);
  }
  check('a socket silent while HTTP still answers is closed',
    dead.closed === true);
  check('the reconnect is started immediately, not left to a close event that may be 60s away',
    s.connects === 1, `connects=${s.connects}`);
  check('the dead socket is abandoned so its late close event cannot fire a second reconnect',
    s.liveWs() !== dead);
  check('the user is told the connection was lost',
    /connection lost/i.test(s.text()), JSON.stringify(s.text()));
  check('the outage notice does not claim the session is gone',
    !/no longer exists/i.test(s.text()), JSON.stringify(s.text()));

  // The reconnect goes down the existing attach path, whose onopen hands
  // back to Conn — no second recovery mechanism.
  check('recovery is announced once the socket is back',
    /reconnected/i.test(s.text()), JSON.stringify(s.text()));
  // What happened to in-flight work is not knowable from here: the socket
  // came back, and whether it came back to the same instance is the server's
  // to answer — which it does, on the socket it just accepted. The client
  // guessing produced a "may have been interrupted" that was true of every
  // reconnect and useful in none.
  check('recovery does not guess at what happened to in-flight work',
    !/interrupted/i.test(s.text()), JSON.stringify(s.text()));
  check('a recovered session is not treated as gone', s.Conn.isGone() === false);
}

// ── Slow is not dead: both channels quiet produces no verdict ──────────
{
  const s = connected();
  // Nothing answers — neither the socket nor HTTP. A wedged socket and a
  // session too busy to serve a poll look identical from the client, so
  // the client must not guess.
  s.advance(60_000);
  check('a socket is NOT declared dead when HTTP is silent too — that cannot be distinguished from slow',
    s.socket.closed === false && s.connects === 0);
  check('the silence is still reported rather than hidden',
    /no response from the session/i.test(s.text()), JSON.stringify(s.text()));
  check('the report is an observation, not a verdict',
    !/no longer exists/i.test(s.text()) && !/connection lost/i.test(s.text()),
    JSON.stringify(s.text()));
  // The header is the at-a-glance channel; it must not read "Connected"
  // while the terminal is saying the session has gone quiet.
  const last = s.status[s.status.length - 1];
  check('the header stops claiming a healthy connection while the session is unresponsive',
    last && /not responding/i.test(last.label || ''), JSON.stringify(s.status));

  // ...and it goes back to normal the moment the session speaks again.
  s.Conn.noteInbound();
  check('the header returns to connected as soon as a frame arrives',
    s.status[s.status.length - 1].cls === 'connected');
  s.advance(10_000);
  check('a session that came back is not still called unresponsive',
    s.socket.closed === false && s.connects === 0);
}

// ── A session the server disowns is said plainly, and retries stop ─────
for (const [status, code] of [[404, 'E_SESSION_404'], [410, 'E_SESSION_404'], [401, 'E_TOKEN_INVALID'], [403, 'E_TOKEN_INVALID']]) {
  const s = connected();
  s.Conn.noteHttp(false, status);
  check(`HTTP ${status} is reported to the embedder as ${code}`,
    s.events.some((e) => e.type === 'nimbus:error' && e.code === code),
    JSON.stringify(s.events));
  check(`HTTP ${status} is spelled out in the terminal, not left silent`,
    /this session (no longer exists|refused the connection)/i.test(s.text()),
    JSON.stringify(s.text()));
  check(`HTTP ${status} stops the reconnect loop`, s.Conn.isGone() === true);
  check(`HTTP ${status} shows a terminal status, not a spinner`,
    s.status.some((x) => x.cls === 'disconnected' && /gone/i.test(x.label || '')),
    JSON.stringify(s.status));
}

// A 5xx or a network error says nothing about the session's existence.
for (const status of [500, 502, 0]) {
  const s = connected();
  s.Conn.noteHttp(false, status);
  check(`HTTP ${status} does NOT declare the session gone — it is indistinguishable from slow`,
    s.Conn.isGone() === false);
}

// ── A reconnect that never opens must not go quiet ─────────────────────
{
  const s = connected();
  s.deadEnd = true;   // every reconnect attempt stays unopened
  for (let i = 0; i < 4; i++) { s.advance(5_000); s.Conn.noteHttp(true, 200); }
  check('an outage that will not clear is still announced', /connection lost/i.test(s.text()));
  check('the outage is announced once, not re-announced on every tick',
    (s.text().match(/connection lost/gi) || []).length === 1, JSON.stringify(s.text()));
  check('a reconnect already in flight is not re-dialled on every tick',
    s.connects === 1, `connects=${s.connects}`);
  s.advance(120_000);
  check('a reconnect that never opens keeps reporting, rather than spinning silently',
    /still reconnecting/i.test(s.text()), JSON.stringify(s.text()));
  check('the report carries how long it has been down',
    /still reconnecting — \d+s/.test(s.text()), JSON.stringify(s.text()));
  check('a stalled reconnect is never mistaken for a session that is gone',
    s.Conn.isGone() === false);
}

// ── Typing into a socket that is not open must not look accepted ───────
{
  const s = connected();
  s.socket.readyState = 3;
  s.Conn.noteInput();
  check('typing while disconnected tells the user their input is going nowhere',
    /not reaching the session/i.test(s.text()), JSON.stringify(s.text()));
}

console.log(`\nshell-connection-liveness: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
