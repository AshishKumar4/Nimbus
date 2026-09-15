#!/usr/bin/env bun
// runtime-primitives/node-e-large-tree — does `node -e` start in a large
// installed tree?
//
// A one-shot `node -e …` assembles a filesystem bundle before it starts: the
// reachable require closure plus every installed package's main entry, the
// ESM→CJS transform, the manifest. That build is proportional to the tree,
// and it used to run in one Durable Object turn against a wall-clock deadline
// scaled by the package count — so a tree large enough, or a cold enough
// cache, failed every `node -e` in it with "assembling the filesystem bundle
// for `node -e …` exceeded N ms" before the program ran a line. The resident
// launch path pages the same build across turns; the exec path now shares it.
//
// So this asserts on a real tree, through the surface a user has: clone got
// (752 packages at the time of writing), install it, and run a `node -e`
// that reads the project's package.json.
//
//   1. the cold run — the first after the install, when nothing is cached —
//      prints the package name and exits 0, with no bundle-deadline failure,
//      inside a bound generous enough for a cold build on a slow colo;
//   2. the warm run does the same, faster.
//
// Every step is bounded. A step that does not come back is a FAIL with the
// elapsed time, never a hang. The install is the expensive part and is not
// the subject: an install that does not complete is reported as its own
// failure, and the runs are then skipped rather than measured against a
// tree that is not there.

import { mintSession, Terminal, stripAnsi, deleteSession, makeAsserter, BASE } from '../_driver.mjs';
import { run } from './_run.mjs';

const REPO = 'https://github.com/sindresorhus/got';
const DIR = '/home/user/got';
const COLD_BOUND_MS = 120_000;
const WARM_BOUND_MS = 30_000;
const DEADLINE_FAILURE = /assembling the filesystem bundle/;
const NODE_E = 'node -e "console.log(\'NAME=\' + require(\'./package.json\').name)"';

function withDeadline(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: label }), ms)),
  ]);
}

/** The install's own exit, and its summary line, from the full transcript. */
function readInstall(output) {
  const exit = output.match(/__INSTALL_EXIT__(\d+)/)?.[1];
  const packages = output.match(/(?:added|Done!)\s+(\d+) packages/)?.[1];
  return { exit: exit === undefined ? null : Number(exit), packages: packages === undefined ? null : Number(packages) };
}

if (!BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('runtime-primitives/node-e-large-tree');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);

try {
  await t.connect();
  await t.waitForPrompt(15_000);

  const clone = await run(t, `git clone --depth 1 ${REPO} ${DIR} && cd ${DIR} && echo __CLONE_DONE__`, 300_000);
  a.check('clone completes', clone.ok && /__CLONE_DONE__/.test(clone.output),
    clone.error ?? clone.output.slice(-300));

  // No pipeline in front of the sentinel: `npm install | tail` reports tail's
  // exit, not npm's.
  const install = await run(t, 'npm install; echo __INSTALL_EXIT__$?', 900_000);
  const installed = readInstall(install.output);
  a.check('npm install completes with exit 0', install.ok && installed.exit === 0,
    `exit=${installed.exit} ${install.error ?? install.output.slice(-400)}`);
  a.check('the tree is large (hundreds of packages)', installed.packages !== null && installed.packages >= 500,
    `packages=${installed.packages}`);
  console.log(`  installed ${installed.packages} packages in ${install.elapsed} ms`);

  if (install.ok && installed.exit === 0) {
    const cold = await run(t, NODE_E, COLD_BOUND_MS);
    a.check('cold node -e prints the package name', cold.ok && /NAME=got/.test(cold.output),
      cold.error ?? cold.output.slice(-400));
    a.check('cold node -e exits 0', /code=0/.test(cold.output),
      cold.output.slice(-300));
    a.check('cold node -e hits no bundle deadline', !DEADLINE_FAILURE.test(cold.output),
      cold.output.slice(-400));
    a.check(`cold node -e returns within ${COLD_BOUND_MS} ms`, cold.ok && cold.elapsed < COLD_BOUND_MS,
      `${cold.elapsed} ms`);
    console.log(`  cold: ${cold.elapsed} ms`);

    const warm = await run(t, NODE_E, WARM_BOUND_MS);
    a.check('warm node -e prints the package name', warm.ok && /NAME=got/.test(warm.output),
      warm.error ?? warm.output.slice(-400));
    a.check('warm node -e hits no bundle deadline', !DEADLINE_FAILURE.test(warm.output),
      warm.output.slice(-400));
    a.check(`warm node -e returns within ${WARM_BOUND_MS} ms`, warm.ok && warm.elapsed < WARM_BOUND_MS,
      `${warm.elapsed} ms`);
    console.log(`  warm: ${warm.elapsed} ms`);
  } else {
    a.check('node -e runs skipped: the tree was not installed', false, 'see the install failure above');
  }
} finally {
  await withDeadline(t.close(), 5_000, 'terminal close');
  const cleanup = await withDeadline(deleteSession(sid), 15_000, 'session delete');
  if (cleanup?.timedOut) console.log(`  (cleanup: ${cleanup.timedOut} timed out)`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
