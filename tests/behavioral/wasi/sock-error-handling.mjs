#!/usr/bin/env bun
// wasi/sock-error-handling — Stream-B B7 — errno propagation.
//
// Spec: connect() to an unreachable host should propagate a meaningful
// errno (ECONNREFUSED=14, EHOSTUNREACH=23, or EIO=29 depending on the
// failure mode). Per Nimbus's shim design, connect() returns sync per
// CF docs ("returns Socket immediately"), so path_open succeeds; the
// failure surfaces on the first sock_send when socket.opened rejects.
//
// Fixture: open /dev/tcp/nonexistent.invalid/1234 (".invalid" TLD is
// guaranteed unresolvable per RFC 6761), then sock_send 1 byte.
// Prints '1' if EITHER path_open returns nonzero OR sock_send returns
// nonzero (any error is fine — we're validating error PROPAGATION,
// not the specific errno).
//
// Note: ".invalid" guarantees DNS failure. Other unreachable choices
// would be CF-blocked addresses (e.g. 10.x ranges), but those are
// runtime-policy-rejected with a different error path. ".invalid" is
// the cleanest "user-side bad input" check.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeStreamBFixtureCmd } from './_fixtures-stream-b.mjs';

const sid = await mintSession();
console.log(`[wasi/sock-error-handling] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/sb && cd /home/user/sb', 10_000);
await t.run(writeStreamBFixtureCmd('sock-error-handling', 'se.wasm'), 30_000);

// DNS resolution + connect timeout typically <30s; 60s budget.
const r = await t.run('wasm-runner se.wasm', 60_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-8).join('\n');
const lines = tail.split(/\r?\n/).map(s => s.trim());
const ok = lines.some(s => s === '1');

await t.close();

console.log(JSON.stringify({ probe: 'wasi/sock-error-handling', sid, base: BASE, tail, ok }, null, 2));

const checks = [['connect to .invalid TLD propagates errno (nonzero)', ok]];
let pass = 0;
for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi/sock-error-handling] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
