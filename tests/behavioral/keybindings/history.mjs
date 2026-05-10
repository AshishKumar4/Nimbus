#!/usr/bin/env bun
// keybindings/history — readline parity for history navigation.

import {
  ARROW_UP, ARROW_DOWN, CTRL_P, CTRL_N, ALT_DOT, CTRL_U,
} from './_keys.mjs';
import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('keybindings/history');
console.log(`keybindings/history — history nav\nBASE=${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Pre-populate history with three echo commands so we have something
// to navigate. After running them, prompt returns each time.
async function execAndAwait(cmd) {
  const tail0 = t.buf.length;
  t.send(cmd + '\r');
  await t.waitFor(
    (b) => b.length > 0 && t.buf.length > tail0 && /[$#>]\s*$/.test(b.trimEnd().slice(-3)),
    15_000, `prompt after ${cmd}`,
  );
}

await execAndAwait('echo HIST_ONE');
await execAndAwait('echo HIST_TWO');
await execAndAwait('echo HIST_THREE last_arg_for_alt_dot');

// ────────────── Up-arrow: most-recent history ──────────────
{
  t.send(CTRL_U); await sleep(50);
  t.reset();
  const tail0 = t.buf.length;
  // Up-arrow → "echo HIST_THREE last_arg_for_alt_dot" appears at prompt.
  // Pressing Enter executes it.
  t.send(ARROW_UP); await sleep(60);
  t.send('\r');
  await t.waitFor(
    (b) => b.length > 0 && t.buf.length > tail0 && /[$#>]\s*$/.test(b.trimEnd().slice(-3)),
    15_000, 'prompt after Up-arrow execute',
  );
  const stripped = stripAnsi(t.buf.slice(tail0));
  const ok = /HIST_THREE last_arg_for_alt_dot/.test(stripped);
  a.check('Up-arrow recalls last command', ok, ok ? '' : JSON.stringify(stripped.slice(0, 200)));
}

// ────────────── Ctrl+P (readline alias for ↑) ──────────────
{
  t.send(CTRL_U); await sleep(50);
  t.reset();
  const tail0 = t.buf.length;
  t.send(CTRL_P); await sleep(60);
  t.send('\r');
  await t.waitFor(
    (b) => b.length > 0 && t.buf.length > tail0 && /[$#>]\s*$/.test(b.trimEnd().slice(-3)),
    15_000, 'prompt after Ctrl+P execute',
  );
  const stripped = stripAnsi(t.buf.slice(tail0));
  // After the previous Up-arrow execute, the most-recent history entry
  // is again "echo HIST_THREE last_arg_for_alt_dot" (the line we just
  // re-ran). Ctrl+P should pull it back.
  const ok = /HIST_THREE last_arg_for_alt_dot/.test(stripped);
  a.check('Ctrl+P recalls last command (alias of ↑)', ok, ok ? '' : JSON.stringify(stripped.slice(0, 200)));
}

// ────────────── ↑ then ↑ then ↓ — walks the history ──────────────
{
  t.send(CTRL_U); await sleep(50);
  t.reset();
  const tail0 = t.buf.length;
  // Two ups go back two entries; one down advances by one — so we
  // should land on the second-most-recent entry.
  // History recent-first (after the runs above + two re-runs of THREE):
  //   [HIST_THREE… , HIST_THREE…, HIST_THREE last_arg, HIST_TWO, HIST_ONE]
  // Two ups → "HIST_THREE…" (second-most-recent, same as last by re-run).
  // For an unambiguous test, just check we landed on an "echo HIST_"
  // line that is NOT empty.
  t.send(ARROW_UP); await sleep(60);
  t.send(ARROW_UP); await sleep(60);
  t.send(ARROW_DOWN); await sleep(60);
  t.send('\r');
  await t.waitFor(
    (b) => b.length > 0 && t.buf.length > tail0 && /[$#>]\s*$/.test(b.trimEnd().slice(-3)),
    15_000, 'prompt after ↑↑↓ execute',
  );
  const stripped = stripAnsi(t.buf.slice(tail0));
  const ok = /HIST_(ONE|TWO|THREE)/.test(stripped);
  a.check('↑ ↑ ↓ navigates history (lands on a history entry)', ok, ok ? '' : JSON.stringify(stripped.slice(0, 200)));
}

// ────────────── Ctrl+N (readline alias for ↓) — empty when past most-recent ──────────────
// At a fresh prompt with no "future" to navigate to, Ctrl+N must be a
// no-op (must NOT insert a control char or garbage into the line). We
// verify by sending Ctrl+N then typing a clean command — the executed
// line must be exactly the typed command.
{
  t.send(CTRL_U); await sleep(50);
  t.reset();
  const tail0 = t.buf.length;
  t.send(CTRL_N); await sleep(60); // expected: no-op
  t.send('echo CTRLN_NOOP_OK\r');
  await t.waitFor(
    (b) => b.length > 0 && t.buf.length > tail0 && /[$#>]\s*$/.test(b.trimEnd().slice(-3)),
    15_000, 'prompt after Ctrl+N noop',
  );
  const stripped = stripAnsi(t.buf.slice(tail0));
  // The output line should be "CTRLN_NOOP_OK" exactly — not preceded
  // by junk from a Ctrl+N insertion.
  const lines = stripped.split(/\r?\n/).map(l => l.replace(/\s+$/, ''));
  const outputLine = lines.find(l => l && !/@[^:]*:.*[$#]\s/.test(l) && !/[$#>]\s*$/.test(l));
  const ok = outputLine === 'CTRLN_NOOP_OK';
  a.check('Ctrl+N at end of history is a no-op (line runs cleanly)', ok,
    ok ? '' : `outputLine=${JSON.stringify(outputLine)} raw=${JSON.stringify(stripped.slice(0, 200))}`);
}

// ────────────── Alt+. — last arg of previous command ──────────────
// readline yank-last-arg. Run a fresh command with a distinctive last
// word, then on the very next prompt type `echo ` + Alt+. — that last
// word should land at the cursor.
{
  // Set up a known-last command. CTRL_U-clears any noise.
  t.send(CTRL_U); await sleep(50);
  await execAndAwait('echo SETUP_LAST_ALTDOT_TOKEN');
  // Now the most-recent history line is "echo SETUP_LAST_ALTDOT_TOKEN"
  // and its last whitespace-delimited word is "SETUP_LAST_ALTDOT_TOKEN".
  t.send(CTRL_U); await sleep(50);
  t.reset();
  const tail0 = t.buf.length;
  t.send('echo '); await sleep(40);
  t.send(ALT_DOT); await sleep(60);
  t.send('\r');
  await t.waitFor(
    (b) => b.length > 0 && t.buf.length > tail0 && /[$#>]\s*$/.test(b.trimEnd().slice(-3)),
    15_000, 'prompt after Alt+. execute',
  );
  const stripped = stripAnsi(t.buf.slice(tail0));
  const ok = /SETUP_LAST_ALTDOT_TOKEN/.test(stripped);
  a.check('Alt+. inserts last arg of previous command', ok,
    ok ? '' : JSON.stringify(stripped.slice(0, 200)));
}

await t.close();
const sum = a.summary();
if (sum.fail > 0) process.exit(1);
