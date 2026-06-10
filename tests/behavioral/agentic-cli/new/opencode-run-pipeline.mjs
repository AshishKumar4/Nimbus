#!/usr/bin/env bun
// agentic-cli/new/opencode-run-pipeline — opencode's DB-backed pipeline runs
// end-to-end in Nimbus. `opencode run` opens its sqlite DB (VFS-backed sql.js
// shim wired into the ESM facet), boots the in-process server, creates a
// session, resolves the tool registry, and dispatches to model resolution.
//
// Two deterministic, non-hanging proofs:
//   - `opencode models` lists the provider catalog (DB + catalog round-trip).
//   - `opencode run -m bogus/x "hi"` drives the full prompt pipeline and
//     returns opencode's own "Model not found" domain error (cleanly, no
//     hang). A real model (opencode/big-pickle) additionally requires an
//     opencode account login for the outbound LLM stream — that auth/network
//     step is the only part not exercised here.

import {
  deleteSession,
  makeAsserter,
  mintSession,
  stripAnsi,
  Terminal,
} from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('agentic-cli/new/opencode-run-pipeline');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(30_000);

  const install = await t.run('npm install -g opencode-ai', 240_000);
  a.check('opencode-ai installed',
    /linked 1 bin into|added 1 packages/.test(stripAnsi(install.output)),
    JSON.stringify(stripAnsi(install.output).slice(-300)));

  // `opencode models` exercises the sqlite DB + provider catalog end-to-end.
  const models = await t.run('opencode models 2>&1 | head -12; echo MDONE=$?', 150_000);
  const modelsOut = stripAnsi(models.output);
  a.check('opencode models lists the provider/model catalog (DB-backed) and exits 0',
    /opencode\/[a-z0-9.-]+/.test(modelsOut) && /MDONE=0/.test(modelsOut)
      && !/Disallowed operation|DatabaseSync|ENOENT|operation not permitted/.test(modelsOut),
    JSON.stringify(modelsOut.slice(-700)));

  // `opencode run` drives the full prompt pipeline (DB, server, session, tool
  // registry, model resolution). A bogus model yields opencode's own clean
  // "Model not found" domain error — the whole stack ran, no Nimbus crash.
  const run = await t.run('opencode run -m bogusprovider/nope "hi" 2>&1; echo RDONE=$?', 150_000);
  const runOut = stripAnsi(run.output);
  a.check('opencode run drives the pipeline to model resolution and returns a clean domain error',
    /Model not found: bogusprovider\/nope/.test(runOut) && /RDONE=0/.test(runOut)
      && !/Disallowed operation called within global scope|DatabaseSync \(node:sqlite\)|operation not permitted|no such file or directory, stat '\/bin\/sh'/.test(runOut),
    JSON.stringify(runOut.slice(-900)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
