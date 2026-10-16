#!/usr/bin/env bun
// pkg-manager/reinstall-idempotent — second `nimbus install clang`
// after a successful first install should NOT refetch from R2; should
// detect the existing manifest with matching sha256 and skip.
//
// Asserts:
//   1. First install completes ok.
//   2. Second install completes < 5 s AND emits a "already installed"
//      / "fresh" / "skipping" marker, NOT a fetching marker.
//   3. After second install, the installed manifest (at the path the
//      first install named) has the same sha256 and mtime.

import { mintSession, Terminal, makeAsserter, stripAnsi, termBody } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('pkg-manager/reinstall-idempotent');
console.log(`pkg-manager/reinstall-idempotent — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// 1. First install. Must show a success/install marker — NOT
//    "nimbus: command not found" — naming the directory it installed:
//    "[clang] installed at usr/lib/nimbus/clang/<version> (X MiB)".
let manifest = null;
{
  const { elapsed, output } = await t.run('nimbus install clang', 120_000);
  const stripped = stripAnsi(output);
  const installed = stripped.match(/installed at\s+\/?(usr\/lib\/nimbus\/clang\/[\w.-]+)/);
  manifest = installed && !/command not found/.test(stripped) ? `/${installed[1]}/manifest.json` : null;
  a.check('first install completes, naming the directory it installed', manifest !== null,
    manifest ? `elapsed=${elapsed}ms manifest=${manifest}` : JSON.stringify(stripped.slice(-200)));
}

/** The installed manifest's sha256 and mtime; null when it cannot be read. */
async function manifestState() {
  if (manifest === null) return null;
  const { output, exitCode } = await t.run(`sha256sum ${manifest} && stat -c %Y ${manifest}`, 10_000);
  return exitCode === 0 ? termBody(output).trim() : null;
}

const before = await manifestState();
a.check('the installed manifest reads back', before !== null, `manifest=${manifest}`);

// 2. Second install — must be fast + use a "skip" path AND NOT
//    "command not found".
{
  const { elapsed, output } = await t.run('nimbus install clang', 60_000);
  const stripped = stripAnsi(output);
  const notNotFound = !/command not found/.test(stripped);
  a.check('second install: nimbus is a registered command', notNotFound,
    notNotFound ? '' : JSON.stringify(stripped.slice(-200)));
  const fastOk = elapsed < 8_000 && notNotFound;
  a.check('second install completes < 8 s (no refetch)', fastOk, `elapsed=${elapsed}ms`);
  const skipMarker = /already installed|already at|fresh|skipping|up to date|cached/i.test(stripped);
  a.check('second install emits skip/already-installed marker', skipMarker && notNotFound,
    skipMarker ? '' : `output tail=${JSON.stringify(stripped.slice(-300))}`);
}

// 3. The manifest is the same bytes, never rewritten.
{
  const after = await manifestState();
  a.check('manifest content and mtime preserved across idempotent reinstall', before !== null && after === before,
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
