#!/usr/bin/env bun
// process-redeclare/wild-nuxt-progress — drives legacy `nuxi@latest init`
// against prod and asserts the `Identifier 'process' has already been
// declared` text is ABSENT from output (the gate this wave is fixing).
//
// nuxi.mjs has the exact shape that triggers the bug per the plan:
//   - `import process from 'node:process'` at line 5
//   - TLA at lines 31 (`await new Promise(...)`) and 47 (`await import(...)`)
//   - Top-level ESM imports
//
// Per plan §1.2, the create-nuxt@latest CLI has a separate
// `undefined.includes` next-layer bug; that's NOT this wave. We use
// legacy `nuxi` here because it cleanly reproduces the canonical bug.
//
// Post-fix the facet should at least pre-compile cleanly; next-layer
// errors (e.g. nuxi's own runtime feature-detect failures) are
// accepted — this probe ONLY asserts the `process` redeclare gate
// is passed.

import { Terminal, mintSession, sleep, makeAsserter, BASE } from '../../_driver.mjs';

const sid = await mintSession();
console.log(`[process-redeclare/wild-nuxt-progress] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

const A = makeAsserter('process-redeclare/wild-nuxt-progress');

await t.run('mkdir -p /home/user/nuxi-wild && cd /home/user/nuxi-wild', 10_000);
const r = await t.run(
  'npx --yes nuxi@latest init mvp --packageManager npm --no-install --no-git',
  360_000,
);
const out = r.output;

A.check(
  'wild-nuxi: NO "Identifier \'process\' has already been declared" in nuxi invocation',
  !/Identifier ['"]process['"] has already been declared/.test(out),
  `tail: ${out.slice(-600)}`,
);
A.check(
  'wild-nuxi: NO "facet error: Identifier" pre-compile crash at the supervisor layer',
  !/facet error: Identifier/.test(out),
  `tail: ${out.slice(-600)}`,
);

await t.close();
const s = A.summary();
process.exit(s.fail === 0 ? 0 : 1);
