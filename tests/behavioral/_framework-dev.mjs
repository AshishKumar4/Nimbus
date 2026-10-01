// Real-framework dev proof: one launch of the project's own CLI, as a user
// types it. A program that only serves after a second run fails here; so does
// one that serves and then dies.
import { BASE, connectProcessTerminal, requestHeaders, sleep, stripAnsi } from './_driver.mjs';

export const frameworkProxyHost = new URL(BASE).hostname;

export async function launchFrameworkDev({ terminal, sid, cwd, command, port, accepts, budgetMs = 180_000 }) {
  const start = await terminal.run(`cd ${cwd} && __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=${frameworkProxyHost} ${command}`, 180_000);
  const text = stripAnsi(start.output);
  const pid = Number(text.match(/\[(?:bin|facet) started \(long-running\): pid=(\d+)/)?.[1] || 0);
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
