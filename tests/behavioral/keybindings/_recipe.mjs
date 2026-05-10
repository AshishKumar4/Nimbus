// keybindings — shared "edit recipe" runner.
//
// To verify what the shell's line-editor *actually executed* after a
// sequence of keypresses, we use `echo` as the carrier:
//
//   1. Connect to a session, wait for the first prompt.
//   2. Send keystrokes that build up some line (typing + edits).
//   3. Send `\r` (carriage return).
//   4. The shell runs the line. If it was `echo <stuff>`, the next
//      output line is `<stuff>` verbatim.
//   5. We strip ANSI, find the last printed line before the next
//      prompt, and compare.
//
// This sidesteps trying to parse cursor-movement bytes — we observe
// the *result* of the edits, which is the user-visible contract.

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep, WS_BASE } from '../_driver.mjs';

/**
 * Run one keybinding recipe.
 *
 * @param {string} probeLabel       — label for assertions
 * @param {Array<{name: string, steps: string[], expect: string}>} cases
 *        Each case:
 *          - name:    human label
 *          - steps:   array of strings to send one at a time (NOT yet
 *                     including the final \r). Each string is sent
 *                     as one WS frame; this matters because xterm
 *                     emits each escape sequence as one onData chunk.
 *          - expect:  the exact line the shell should run (`echo` arg)
 *
 * Tests one shared session for speed; resets state between cases by
 * sending Ctrl+U to clear the line.
 */
export async function runRecipes(probeLabel, cases) {
  const a = makeAsserter(probeLabel);
  console.log(`${probeLabel} — ${cases.length} cases\nBASE=${process.env.BASE}\nWS_BASE=${WS_BASE}`);

  const sid = await mintSession();
  console.log(`SID: ${sid}`);
  const t = new Terminal(sid);
  await t.connect();

  // Wait for the very first prompt (cold session).
  await t.waitForPrompt(60_000);

  for (const c of cases) {
    // Clean any state from the previous case: Ctrl+U clears the line
    // (current shell empties the whole buffer; new editor cuts-to-start
    //  but starting at cursor pos 0 is the same outcome).
    t.send('\x15');
    await sleep(50);
    t.reset();

    // Send steps one frame at a time, mimicking real-terminal arrival.
    for (const s of c.steps) {
      t.send(s);
      // 25 ms between frames lets the shell digest each sequence
      // before the next one lands. NOT a "retry/timeout/sleep" hack —
      // these are different input events with their own state
      // transitions; real keyboards have ms+ gaps between keys.
      await sleep(25);
    }

    // Execute the line.
    const tail0 = t.buf.length;
    t.send('\r');
    // Wait for a fresh prompt to appear after the command runs.
    await t.waitFor(
      (b) => b.length > 0 && t.buf.length > tail0 && /[$#>]\s*$/.test(b.trimEnd().slice(-3)),
      15_000,
      `prompt after recipe "${c.name}"`,
    );

    // Extract the OUTPUT line. The buffer after the recipe contains:
    //   <command-echo-line>\r\n         e.g. "user@nimbus:~$ echo abX"
    //   <echo-output>\r\n               e.g. "abX"
    //   <new-prompt>                    e.g. "user@nimbus:~$ "
    //
    // We want the echo-output. Skip lines that:
    //   - are empty (after trim)
    //   - contain "@" followed by ":" and end with `$ ` or end with `> `
    //     (these are prompt lines, including the command-echo line)
    //   - end with `$`, `#`, or `>` (raw prompts without content)
    const stripped = stripAnsi(t.buf.slice(tail0));
    const lines = stripped.split(/\r?\n/);
    const isPromptLine = (ln) => {
      const trimmed = ln.replace(/\s+$/, '');
      if (!trimmed) return true;
      // user@host:cwd$ <maybe command>  → prompt line (or command echo)
      if (/@[^:]*:[^$#]*[$#]\s/.test(trimmed)) return true;
      // bare prompt at end
      if (/[$#>]\s*$/.test(trimmed)) return true;
      return false;
    };
    let observed = null;
    for (const raw of lines) {
      const ln = raw.replace(/\s+$/, '');
      if (!ln) continue;
      if (isPromptLine(ln)) continue;
      observed = ln;
      break;
    }
    if (observed === null) observed = '';

    const ok = observed === c.expect;
    a.check(
      c.name,
      ok,
      ok ? '' : `expected="${c.expect}" observed="${observed}" raw=${JSON.stringify(stripped.slice(0, 200))}`,
    );
  }

  await t.close();
  const sum = a.summary();
  if (sum.fail > 0) process.exit(1);
}
