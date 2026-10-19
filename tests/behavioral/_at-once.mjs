// Commands run at once in one session, the way one user's parallel build
// does: `a & b & … wait`. The step's wall time, and whether the session lived
// through it, for a reset closes the terminal mid-step.

import { BASE, requestHeaders, stripAnsi, hasOutputLine } from './_driver.mjs';

/**
 * Run `commands` at once in `t`'s shell and wait for all of them: whether
 * the shell answered after the last one ended, the step's wall time, and
 * its output's tail (or the closed terminal's report).
 */
export async function atOnce(t, commands, timeoutMs) {
  const marker = `AT_ONCE_DONE_${commands.length}`;
  const started = Date.now();
  try {
    const { output } = await t.run(`${commands.map((command) => `${command} &`).join(' ')} wait; echo ${marker}`, timeoutMs);
    const text = stripAnsi(output);
    return { survived: hasOutputLine(output, marker), ms: Date.now() - started, detail: text.slice(-400) };
  } catch (error) {
    return { survived: false, ms: Date.now() - started, detail: String(error?.message ?? error) };
  }
}

/** The isolate `sid` runs in now (/api/_diag/memory, which every probe target serves): sessions with one id share its memory limit. */
export async function isolateOf(sid) {
  const response = await fetch(`${BASE}/s/${encodeURIComponent(sid)}/api/_diag/memory`, { headers: requestHeaders({}, sid), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`/api/_diag/memory for ${sid} answered ${response.status}`);
  const id = (await response.json()).isolate?.id;
  if (typeof id !== 'string') throw new Error(`/api/_diag/memory for ${sid} names no isolate`);
  return id;
}
