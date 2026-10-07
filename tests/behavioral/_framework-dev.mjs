// Real-framework dev proof: one launch of the project's own CLI, as a user
// types it. A program that only serves after a second run fails here; so does
// one that serves and then dies.
import { BASE, connectProcessTerminal, requestHeaders, sleep, stripAnsi } from './_driver.mjs';

export const frameworkProxyHost = new URL(BASE).hostname;

const LONG_RUNNING = /\[(?:bin|facet) started \(long-running\): pid=(\d+)/;

export async function launchFrameworkDev({ terminal, sid, cwd, command, port, accepts, budgetMs = 180_000 }) {
  // The server's start line names its pid, and the shell's prompt comes back
  // once it runs in the background. Its own output goes on reaching the
  // terminal, and its first lines can arrive in the same frame as the prompt
  // ("…/mvp$ 08:01:15 [vite] connected."), so the buffer need never end with
  // the prompt that Terminal.run waits for: astro-real timed out "waiting for
  // new prompt" on a server that was up. So the start line ends the wait; a
  // command that never goes long-running ends it with its prompt.
  terminal.reset();
  terminal.cmd(`cd ${cwd} && __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=${frameworkProxyHost} ${command}`);
  await terminal.waitFor((b) => LONG_RUNNING.test(b) || (b.length > 0 && /[$#>]\s*$/.test(b.trimEnd().slice(-3))), 180_000, 'the server start line or the prompt');
  const text = stripAnsi(terminal.buf);
  const pid = Number(text.match(LONG_RUNNING)?.[1] || 0);
  if (!pid) return { ok: false, pid: 0, output: text, last: 'no resident process was launched', process: null, response: null };
  const proc = await connectProcessTerminal(sid, pid);
  let response = null;
  let last = 'not served';
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline && !proc.exit) {
    let status = 0;
    const r = await fetch(BASE + '/s/' + sid + '/port/' + port + '/', {
      headers: requestHeaders(), signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now()))),
    }).then(async (res) => {
      status = res.status;
      return { status, body: await res.text() };
    }).catch((error) => ({ status, body: `${status ? 'response body' : 'response headers'}: ${error.message}` }));
    last = `HTTP ${r.status}: ${r.body.slice(0, 240)}`;
    if (accepts(r)) { response = r; break; }
    await sleep(1000);
  }
  // A process can serve once and then fail its startup-residency check.
  await sleep(1000);
  const output = text + proc.output;
  if (response && !proc.exit) return { ok: true, pid, output, last, process: proc, response };
  if (!proc.exit) {
    proc.signal('SIGKILL');
    for (let i = 0; i < 20 && !proc.exit; i++) await sleep(100);
  }
  proc.ws.close();
  return { ok: false, pid, output, last, process: null, response: null };
}
