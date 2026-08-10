#!/usr/bin/env bun
// keybindings/misc — Ctrl+L clear-screen, Ctrl+\ quit, Ctrl+R reverse search.

import { CTRL_L, CTRL_BACKSLASH, CTRL_R, CTRL_C, CTRL_U } from './_keys.mjs';
import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('keybindings/misc');
console.log(`keybindings/misc\nBASE=${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Seed history for Ctrl+R.
async function execAndAwait(cmd) {
  const tail0 = t.buf.length;
  t.send(cmd + '\r');
  await t.waitFor(
    (b) => b.length > 0 && t.buf.length > tail0 && /[$#>]\s*$/.test(b.trimEnd().slice(-3)),
    15_000, `prompt after ${cmd}`,
  );
}
await execAndAwait('echo CARROT_MARKER');
await execAndAwait('echo BANANA_MARKER');

// ────────────── Ctrl+L: clear screen, KEEP current line ──────────────
// Real readline: emits `\x1b[H\x1b[2J` (or `\x1b[H\x1b[J`) and redraws
// the prompt + current line. We verify by observing the clear-screen
// bytes followed by a redraw containing the current line content.
{
  t.send(CTRL_U); await sleep(50);
  t.reset();
  // Type a partial line, then Ctrl+L.
  t.send('echo CL_TEST'); await sleep(60);
  const before = t.buf.length;
  t.send(CTRL_L); await sleep(150);
  const after = t.buf.slice(before);
  // Look for clear-screen bytes.
  const hasClear = /\x1b\[2?J/.test(after) || /\x1b\[H\x1b\[/.test(after);
  // Look for the line content redrawn after the clear.
  const hasRedraw = /CL_TEST/.test(after);
  a.check('Ctrl+L emits clear-screen bytes', hasClear,
    hasClear ? '' : `after-buf=${JSON.stringify(after.slice(0, 200))}`);
  a.check('Ctrl+L re-renders current line after clearing', hasRedraw,
    hasRedraw ? '' : `after-buf=${JSON.stringify(after.slice(0, 200))}`);

  // Now press Enter — the line should actually execute as "echo CL_TEST".
  const tail0 = t.buf.length;
  t.send('\r');
  await t.waitFor(
    (b) => b.length > 0 && t.buf.length > tail0 && /[$#>]\s*$/.test(b.trimEnd().slice(-3)),
    15_000, 'prompt after Ctrl+L Enter',
  );
  const out = stripAnsi(t.buf.slice(tail0));
  a.check('Ctrl+L preserved the line for execution', /CL_TEST/.test(out),
    /CL_TEST/.test(out) ? '' : JSON.stringify(out.slice(0, 200)));
}

// ────────────── Ctrl+\ — SIGQUIT ──────────────
// Real bash: Ctrl+\ raises SIGQUIT. With no foreground job readline absorbs
// it and the line survives; with one, the command dies and $? is 131 (128+3).
// Both assertions land on an effect the terminal does not mirror: the line
// still EXECUTES, and the exit status the shell reports afterwards.
{
  // No foreground job: absorbed, current line untouched.
  t.send(CTRL_U); await sleep(50);
  t.send('echo QUIT_LINE_SURVIVED'); await sleep(60);
  t.send(CTRL_BACKSLASH); await sleep(120);
  t.reset();
  t.send('\r');
  const ranAnyway = await t.waitFor((b) => /QUIT_LINE_SURVIVED/.test(b), 15_000, 'line survives Ctrl+\\')
    .then(() => true).catch(() => false);
  a.check('Ctrl+\\ at the prompt is absorbed and leaves the line intact', ranAnyway,
    ranAnyway ? '' : JSON.stringify(stripAnsi(t.buf).slice(-200)));

  // Foreground job: SIGQUIT ends `sleep 20` early. The marker command is
  // queued right behind it, so the wait discriminates on its own: signalled,
  // the marker lands in ~1 s; unsignalled, `sleep 20` runs out first and the
  // marker cannot arrive inside the bound. $? then names the signal exactly.
  await t.waitForPrompt(15_000);
  t.reset();
  t.cmd('sleep 20');
  await t.waitFor((b) => /sleep 20/.test(b), 10_000, 'sleep echo');
  await sleep(1000);
  const t0 = Date.now();
  t.send(CTRL_BACKSLASH);
  t.cmd('echo "QS=$?=END"');
  const marked = await t.waitFor((b) => /QS=\d+=END/.test(b), 12_000, 'quit status marker')
    .then(() => true).catch(() => false);
  const elapsed = Date.now() - t0;
  a.check('Ctrl+\\ terminates the foreground command (SIGQUIT delivered)',
    marked && elapsed < 12_000,
    `marked=${marked} elapsed=${elapsed}ms tail=${JSON.stringify(stripAnsi(t.buf).slice(-200))}`);

  const qs = stripAnsi(t.buf).match(/QS=(\d+)=END/);
  a.check('Ctrl+\\ reports SIGQUIT status 131 in $?',
    qs !== null && Number(qs[1]) === 131,
    `got=${qs ? qs[1] : 'none'}`);
}

// ────────────── Ctrl+R — reverse-i-search ──────────────
// readline opens "(reverse-i-search)`<query>': <match>" sub-prompt.
// Typing chars narrows the search; Enter executes; Ctrl+G aborts.
// We test: Ctrl+R, type "CARROT", Enter → should re-run
// "echo CARROT_MARKER".
{
  t.send(CTRL_U); await sleep(50);
  t.reset();
  const tail0 = t.buf.length;
  t.send(CTRL_R); await sleep(120);
  // Type the query a char at a time. Each char should refresh the
  // displayed match in the sub-prompt.
  for (const ch of 'CARROT') {
    t.send(ch);
    await sleep(40);
  }
  // Press Enter to execute the currently-matched history line.
  t.send('\r');
  await t.waitFor(
    (b) => b.length > 0 && t.buf.length > tail0 && /[$#>]\s*$/.test(b.trimEnd().slice(-3)),
    20_000, 'prompt after Ctrl+R Enter',
  );
  const out = stripAnsi(t.buf.slice(tail0));
  // Match the actual echo output (CARROT_MARKER printed). We also want
  // some evidence the (reverse-i-search) prompt appeared.
  const matched = /CARROT_MARKER/.test(out);
  const hadSearchPrompt = /reverse-?i-?search|\(reverse/i.test(out);
  a.check('Ctrl+R opens reverse-i-search prompt', hadSearchPrompt,
    hadSearchPrompt ? '' : JSON.stringify(out.slice(0, 300)));
  a.check('Ctrl+R + query + Enter executes the matched history line', matched,
    matched ? '' : JSON.stringify(out.slice(0, 300)));
}

await t.close();
const sum = a.summary();
if (sum.fail > 0) process.exit(1);
