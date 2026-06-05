#!/usr/bin/env bun
// shell-polish/documented-limit/bash-extensions-out-of-scope —
// Several bash 4+ extensions are NOT supported by lifo-sh's parser
// (which targets a POSIX-leaning subset). Patching them requires
// modifying the @lifo-sh/core/dist bundle (hash-named file; brittle
// across version bumps). They are documented as known-limits rather
// than papered over.
//
// The probe documents the CURRENT observable behaviour for each. If
// lifo-sh upstream adds support, these will start showing the new
// shape — at which point the probe SHOULD be updated to assert the
// new behaviour (NOT widened to accept either shape — that defeats
// the surface lock).
//
// Category: F (forensic) — always exits 0; reports observed state.
// Run this manually to audit current parser support.
//
// Pre-fix observable (prod 1914938):
//   - `arr=(a b c)`            → "unexpected token '('"
//   - `${v^^}` (case-mod)      → empty expansion
//   - `trap 'cmd' EXIT`        → silent (EXIT trap doesn't fire)
//   - `ls /tmp/g/**/*.txt`     → globstar partial (only one level deep)
//
// Each is documented + measured below. If any STARTS WORKING, this
// probe surfaces the change in its forensic output for the operator
// to migrate to an R-tier probe.

import { mintSession, Terminal, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
console.log(`shell-polish/bash-extensions-out-of-scope — forensic`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

async function run(c, to = 10_000) {
  const r = await t.run(c, to);
  return stripAnsi(r.output);
}

function lastLine(out, predicate) {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.reverse().find(predicate) || '';
}

const obs = {};

// 1. arr=(a b c) — array literal.
{
  const out = await run('arr=(a b c); echo ${arr[1]} 2>&1');
  obs.arrayInit = /unexpected token/.test(out) ? 'parse_error' :
                  out.includes('b') ? 'SUPPORTED' : 'unknown';
}

// 2. ${v^^} — uppercase expansion.
{
  const out = await run('v="abc"; echo "[${v^^}]"');
  const last = lastLine(out, (l) => l.startsWith('['));
  obs.upperExpansion = last === '[ABC]' ? 'SUPPORTED' :
                       last === '[abc]' ? 'no_op' :
                       last === '[]' ? 'empty' : last;
}

// 3. ${v,,} — lowercase expansion.
{
  const out = await run('v="ABC"; echo "[${v,,}]"');
  const last = lastLine(out, (l) => l.startsWith('['));
  obs.lowerExpansion = last === '[abc]' ? 'SUPPORTED' :
                       last === '[ABC]' ? 'no_op' :
                       last === '[]' ? 'empty' : last;
}

// 4. trap EXIT — should fire on shell exit (or session-end). Limited
//    forensic since we can't easily test EXIT from the same session;
//    test the IMMEDIATE form: trap fires on `exit` builtin in subshell.
{
  // Use a `bash -c` style chain via `(...)` subshell IF supported.
  // Fallback: just register the trap and exit; can't observe directly.
  const out = await run("trap 'echo TRAP_FIRED' EXIT; echo registered");
  obs.trapEXIT = out.includes('TRAP_FIRED') ? 'SUPPORTED' : 'not_fired_synchronously';
}

// 5. globstar (**) recursive glob.
{
  await run('rm -rf /tmp/gstar && mkdir -p /tmp/gstar/a/b && touch /tmp/gstar/x.txt /tmp/gstar/a/y.txt /tmp/gstar/a/b/z.txt');
  const out = await run('shopt -s globstar 2>&1; ls /tmp/gstar/**/*.txt 2>&1');
  const sawX = /\/tmp\/gstar\/x\.txt/.test(out);
  const sawY = /\/tmp\/gstar\/a\/y\.txt/.test(out);
  const sawZ = /\/tmp\/gstar\/a\/b\/z\.txt/.test(out);
  obs.globstar = `x=${sawX} y=${sawY} z=${sawZ}`;
  obs.globstarStatus =
    sawX && sawY && sawZ ? 'SUPPORTED' :
    sawY ? 'partial' : 'unsupported';
}

// 6. Subshell parens: (cmd; cmd) — different from arr literals.
{
  const out = await run('(echo SUB_OK; echo SUB_2)');
  const has = out.includes('SUB_OK') && out.includes('SUB_2');
  obs.subshellParens = has ? 'SUPPORTED' :
                       /unexpected token/.test(out) ? 'parse_error' : 'unknown';
}

console.log('\n=== Documented bash-extension observability ===');
for (const [k, v] of Object.entries(obs)) {
  console.log(`  ${k.padEnd(20)} : ${v}`);
}
console.log('\nForensic probe — exits 0 regardless. Migrate to R-tier if a');
console.log('feature graduates from "parse_error" / "unsupported" to "SUPPORTED".');

await t.close();
process.exit(0);
