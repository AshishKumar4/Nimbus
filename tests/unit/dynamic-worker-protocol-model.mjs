#!/usr/bin/env bun
// The Dynamic Worker ledger's deadlock protocol, checked exhaustively at a
// small scope, wired to production (lib/ledger-protocol-model.mjs): the real
// ledger, the real process table and its work and await accounting, and the
// guests' news tracker from the very text the shims embed (child-news.ts);
// only who could still make progress is the model's own. Every interleaving
// of reports, news (delivered out of order, waking its guest or not), child
// exits, admissions and refusals, up to the order of moves only one guest can
// see.
//
// What must hold, in every run:
//   - never a refusal while any process holding a worker can still make
//     progress;
//   - always a refusal when all of them are truly stuck: every run ends with
//     every process done.
//
// Scope: every family of one guest holder, or two side by side, with up to
// two children each of three kinds (a child queued for a worker, a builtin
// running in the session, `sh -c 'node x'`). Two holders one under the
// other: dynamic-worker-protocol-model-nested and -nested-2; three holders:
// dynamic-worker-protocol-model-three and -three-fork; other shells (a
// builtin first, npm's script wrapper, a background job):
// dynamic-worker-protocol-model-shells.
//
// The checker's teeth, each a mutant of production, each caught:
//   - the guest's tracker (child-news.ts's text, mutated as text)
//     acknowledging the highest number it received rather than the
//     contiguous run: a refusal while a holder had news still to apply;
//   - the process table counting an await as a process's only work while it
//     has other work too (a shell's builtin running): a refusal while that
//     shell would go on (dynamic-worker-protocol-model-shells);
//   - the process table dropping a shell's await of its program: a family
//     truly stuck that never refuses.

import assert from 'node:assert/strict';
import { CHILD_NEWS_SOURCE } from '../../packages/worker/src/runtime/child-news.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { PRODUCTION, checkFamilies, childSets, describe, explore, guestNewsFrom } from './lib/ledger-protocol-model.mjs';

// The guest the model runs is the one the session talks to: the shims embed
// child-news.ts's text, and their news and reports go through it.
const shims = generateShimsCode();
assert.ok(shims.includes(`const __nimbusChildNews = (${CHILD_NEWS_SOURCE})(`), 'the shims embed the guest news tracker the model checks');
assert.ok(shims.includes('globalThis.__nimbusApplyNews = (numbers) => __nimbusChildNews.apply(numbers);'), 'and apply news through it');
assert.ok(shims.includes('__nimbusChildNews.say(blocked);'), 'and report through it');

// One holder, or two side by side here; two nested in
// dynamic-worker-protocol-model-nested and -nested-2 (the time a file may take).
const cases = [];
for (const a of childSets(2)) {
  cases.push([{ parent: 'R', children: a }]);
  for (const b of childSets(2)) cases.push([{ parent: 'R', children: a }, { parent: 'R', children: b }]);
}

await checkFamilies(cases);

// ── the checker's teeth: mutants of production ──────────────────────────────
const CONTIGUOUS = 'while (ahead.delete(frontier + 1)) frontier++;';
assert.ok(CHILD_NEWS_SOURCE.includes(CONTIGUOUS), "the guest's contiguous frontier is where the mutant expects it");
const mutants = {
  "the guest's tracker acknowledges the highest number, not the contiguous run": {
    production: {
      ...PRODUCTION,
      createChildNews: guestNewsFrom(CHILD_NEWS_SOURCE.replace(CONTIGUOUS, 'for (const n of ahead) if (n > frontier) frontier = n; ahead.clear();')),
    },
    family: [{ parent: 'R', children: ['q'] }, { parent: 0, children: ['q'] }, { parent: 0, children: ['q'] }],
    focus: 10,
    expect: /refused .* while a holder could still make progress/,
  },
  "the process table drops a shell's await of its program": {
    production: {
      ...PRODUCTION,
      patchProcesses(processes) { processes.beginAwait = () => () => {}; },
    },
    family: [{ parent: 'R', children: ['s'] }],
    focus: null,
    expect: /ended stuck with no refusal/,
  },
};
for (const [name, mutant] of Object.entries(mutants)) {
  const { found } = await explore(mutant.production, mutant.family, { focus: mutant.focus, maxStates: 500_000 });
  assert.ok(found.length > 0, `the model catches a mutant where ${name}`);
  assert.match(found[0].violation, mutant.expect, `${name}: ${found[0].violation}`);
  console.log(`  caught: ${name} (${found[0].violation}; ${describe(found[0].path)})`);
}

console.log('ok - dynamic-worker-protocol-model (no refusal while a holder can progress, and one whenever all are stuck, over every interleaving; production mutants caught)');
