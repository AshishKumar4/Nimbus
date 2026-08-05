#!/usr/bin/env bun
// wasm/pthread-parity — a real threaded C program runs correctly in a session.
//
// The binary is a stock wasi-sdk `wasm32-wasip1-threads` build (plus the futex
// shim every Nimbus threads build links). It exercises the four things a
// pthread implementation has to get right and that a fake one gets wrong:
//
//   mutex        two threads race 2000 guarded increments each. A mutex that
//                does not exclude loses increments; counter != 4000.
//   condvar      producer/consumer over one slot with cond_wait/broadcast. A
//                condvar that never blocks spins forever or drops items;
//                condvar != 5050.
//   join         both threads' return values are summed. A join that returns
//                before the thread finished, or loses the value, gives != 4000.
//   TLS          each thread writes its own __thread slot, yields to its peer,
//                and re-reads it. Shared globals masquerading as TLS give
//                tls=0, and the main thread's own slot would be clobbered.
//
// Asserting on the exact line rather than "ran without error" is the point:
// every one of these fails QUIETLY with a plausible-looking exit code 0.

import { mintSession, Terminal, sleep, stripAnsi, deleteSession, BASE } from '../_driver.mjs';
import { PTHREAD_PARITY_WASM_B64, PTHREAD_PARITY_EXPECTED } from './_pthread-fixture.mjs';

const sid = await mintSession();
console.log(`[wasm/pthread-parity] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
let out = '';
let rejected = '';
try {
  await t.connect();
  await sleep(2_000);
  await t.waitForPrompt(60_000);
  await t.run('mkdir -p /home/user/pth && cd /home/user/pth', 15_000);

  // The base64 is ~20 KB, past what one shell line carries comfortably, so it
  // lands in chunks and is decoded once.
  const CHUNK = 3_000;
  await t.run('rm -f p.b64 p.wasm', 15_000);
  for (let i = 0; i < PTHREAD_PARITY_WASM_B64.length; i += CHUNK) {
    const part = PTHREAD_PARITY_WASM_B64.slice(i, i + CHUNK);
    await t.run(
      `node -e "require('fs').appendFileSync('p.b64','${part}')"`,
      30_000,
    );
  }
  await t.run(
    `node -e "const fs=require('fs');const b=Buffer.from(fs.readFileSync('p.b64','utf8'),'base64');fs.writeFileSync('p.wasm',b);console.log('WASM_BYTES='+b.length)"`,
    30_000,
  );

  const run = await t.run('wasm-runner p.wasm', 60_000);
  out = stripAnsi(run.output);

  // The same binary WITHOUT the futex shim must be refused rather than run:
  // its libc futex would execute memory.atomic.wait32 and trap on the first
  // contended lock. Truncating the shim's import name in place is the cheapest
  // faithful way to produce that binary from this one.
  await t.run(
    `node -e "const fs=require('fs');const b=fs.readFileSync('p.wasm');const i=b.indexOf('nimbus_threads');if(i<0)throw new Error('shim import not found');b.write('nimbus_threadX',i);fs.writeFileSync('stock.wasm',b);console.log('PATCHED')"`,
    30_000,
  );
  const stock = await t.run('wasm-runner stock.wasm', 60_000);
  rejected = stripAnsi(stock.output);
} finally {
  await t.close();
  await deleteSession(sid);
}

const tail = out.split(/\r?\n/).slice(-8).join('\n');
const line = (out.match(/PTHREAD [^\r\n]*/) || [''])[0].trim();

const checks = [
  ['the threaded binary produced its result line', /PTHREAD /.test(out)],
  [`every pthread primitive was correct: "${PTHREAD_PARITY_EXPECTED}"`,
    line === PTHREAD_PARITY_EXPECTED],
  ['mutual exclusion lost no increments', /counter=4000\b/.test(line)],
  ['pthread_join returned both thread values', /joined=4000\b/.test(line)],
  ['the condition variable delivered every item', /condvar=5050\b/.test(line)],
  ['thread-local storage survived a context switch', /\btls=1\b/.test(line)],
  ['the main thread\'s TLS slot was not clobbered', /mainTls=0\b/.test(line)],
  ['no trap or wasm-runner error', !/wasi trap|deadlock|Atomics\.wait/i.test(out)],
  ['a build without the futex shim is refused at load',
    /not linked against the Nimbus futex shim/.test(rejected)],
  ['the refusal names the build remedy',
    /nimbus-threads\.c/.test(rejected) && /--shared-memory/.test(rejected)],
];

console.log(JSON.stringify({ probe: 'wasm/pthread-parity', sid, base: BASE, line, tail }, null, 2));

let pass = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) pass++;
}
const verdict = pass === checks.length ? 'passing' : 'failing';
console.log(`[wasm/pthread-parity] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'passing' ? 0 : 1);
