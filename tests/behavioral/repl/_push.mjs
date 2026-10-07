// One line typed into an interactive REPL, waited for by its own echo.
//
// A REPL's prompt can arrive after the output a probe waited for (a check
// that waited for `4` returns before the `>>> ` behind it), so "the next
// prompt" is not this line's: the late prompt of the line before would end
// the wait at once and every later check would read its predecessor's
// output. A pushed line is done when the prompt that follows ITS echo has
// arrived.

import { stripAnsi } from '../_driver.mjs';

/**
 * Type `line` at the REPL behind `t` and wait (bounded) for the prompt
 * after its echo. Returns what the line printed: the text between its echo
 * and that prompt.
 */
export async function pushLine(t, line, { prompt = />>>\s*$/, timeoutMs = 15_000 } = {}) {
  t.reset();
  t.cmd(line);
  const after = (text) => {
    const at = text.indexOf(line);
    return at < 0 ? null : text.slice(at + line.length);
  };
  await t.waitFor((b) => {
    const rest = after(stripAnsi(b));
    return rest !== null && /\n/.test(rest) && prompt.test(rest.trimEnd() + ' ');
  }, timeoutMs, `the prompt after ${JSON.stringify(line)}`);
  return after(stripAnsi(t.buf)).replace(prompt, '').trim();
}
