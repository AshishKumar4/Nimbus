#!/usr/bin/env bun
// wasi/sock-error-handling — WASI socket and polling support B7 — errno propagation.
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

import { openWasiProbe, tailLines, trimmedLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/sock-error-handling', { dir: '/home/user/sb', fixture: 'sock-error-handling', as: 'se.wasm' });
const { t } = probe;
try {
  // DNS resolution + connect timeout typically <30s; 60s budget.
  const r = await t.run('wasm-runner se.wasm', 60_000);
  const tail = tailLines(r.output, 8);
  const lines = trimmedLines(tail);
  const ok = lines.some(s => s === '1');

  probe.report([['connect to .invalid TLD propagates errno (nonzero)', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
