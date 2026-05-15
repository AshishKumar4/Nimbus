#!/usr/bin/env bun
// winwin-w2/install-warm-still-works — idempotent re-install branch
// (manifest.json already on disk) unchanged by W2.
//
// W2 only touches the blob-fetch loop (post-manifest-write). The
// pre-loop idempotency check at package-manager.ts:227-234 is NOT
// reached by parallel code. This probe confirms it still works:
//   1. First `nimbus install python` → installs.
//   2. Second `nimbus install python` → hits idempotent branch.
//   3. Output of the second call contains "already installed".

import { mintSession, Terminal, makeAsserter, stripAnsi, BASE } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('winwin-w2/install-warm-still-works');
console.log(`winwin-w2/install-warm-still-works — ${BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// First install.
const { output: o1 } = await t.run('nimbus install python', 180_000);
const s1 = stripAnsi(o1);
a.check('first install reports installation', /installed at/.test(s1),
  `tail=${JSON.stringify(s1.slice(-200))}`);

// Second install (warm idempotent).
const { output: o2 } = await t.run('nimbus install python', 30_000);
const s2 = stripAnsi(o2);
a.check('second install hits idempotent branch (already installed)',
  /already installed/.test(s2),
  `tail=${JSON.stringify(s2.slice(-200))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
