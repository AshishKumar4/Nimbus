#!/usr/bin/env bun
// repl-r7/regression/no-this-in-facet-fn — guard against recurring
// `references \`this\`` regression in facet-bound functions.
//
// History (recurring, 3 times now):
//   5edb0da REPL-A2 hotfix:   scrub `this` from replStepFacetFn comments
//   4d96369 REPL-A2 hotfix2:  scrub `this` from new comment in replStepFacetFn
//   f08e3bd REPL-R7:          re-introduced `this` (in two new comments)
//   <next>   REPL-R7-scrub:    this commit — third scrub.
//
// Root cause pattern: src/loaders/loader-pool.ts serializes a worker
// function via fn.toString() and the workerd runtime rejects any
// resulting source containing the bare word \bthis\b (no late `this`
// binding in remote isolates).
//
// Reviewers reintroducing `this` in COMMENTS within facet-bound fn
// bodies do not realize the comment text is preserved by toString.
//
// This probe drives the canonical Python-REPL paste path that fails
// LOUDLY when `this` sneaks back in:
//   send "python\rexit(0)\r" as ONE WS frame
//   wait for shell prompt
// Pre-bug: REPL writes "[python-repl] init dispatch failed: Function
// \"replStepFacetFn\" references `this`, ..." and hangs.
// Post-fix: REPL boots, pasteQueue-drains exit(0), exits clean.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('repl-r7/regression/no-this-in-facet-fn');
console.log(`repl-r7/regression/no-this-in-facet-fn — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);
await t.run('nimbus install python', 300_000);

t.reset();
t.send('python\rexit(0)\r');

let failed = false;
let lastTail = '';
try {
  await t.waitFor(
    (b) => /\$\s*$/.test(b.trimEnd().slice(-3)) && />>>/.test(b),
    30_000,
    'shell prompt after exit(0)',
  );
} catch (e) {
  failed = true;
  lastTail = stripAnsi(t.buf).slice(-500);
}
const tailNow = stripAnsi(t.buf).slice(-800);

a.check('REPL paste-exits cleanly (no hang)',
  !failed,
  `failed=${failed} tail=${JSON.stringify(lastTail)}`);

// CRITICAL assertion: the regression signature must NOT appear.
a.check('No "init dispatch failed" message in REPL output',
  !/init dispatch failed/.test(tailNow),
  `tail=${JSON.stringify(tailNow)}`);

a.check('No "references `this`" error in REPL output',
  !/references `this`/.test(tailNow),
  `tail=${JSON.stringify(tailNow)}`);

if (!failed) {
  // exit(0) → shell $? === 0.
  const r = await t.run('echo "EXIT=$?"', 10_000);
  const m = /EXIT=(\d+)/.exec(stripAnsi(r.output));
  a.check('REPL exit(0) → shell $? === 0',
    m && parseInt(m[1], 10) === 0,
    `got=${m ? m[1] : 'no-match'}`);
}

await t.close();

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
