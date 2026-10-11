// Real-framework dev proof: one launch of the project's own CLI, as a user
// types it. A program that only serves after a second run fails here; so does
// one that serves and then dies. Residency policy belongs to this proof.
import { BASE, connectProcessTerminal, requestHeaders, sleep } from './_driver.mjs';
import { startDevCommand } from './_dev-start.mjs';
export { frameworkProxyHost } from './_dev-start.mjs';

const RESIDENCY_MS = 65_000;
const RESIDENCY_REQUESTS = 14;

export async function launchFrameworkDev({ terminal, sid, cwd, command, port, accepts, budgetMs = 180_000 }) {
  const { output: text, pid } = await startDevCommand({ terminal, cwd, command });
  if (!pid) return { ok: false, pid: 0, output: text, last: 'no resident process was launched', process: null, response: null };
  const proc = await connectProcessTerminal(sid, pid);
  let response = null;
  let last = 'not served';
  const deadline = Date.now() + budgetMs;
  const request = async (until) => {
    let status = 0;
    const r = await fetch(BASE + '/s/' + sid + '/port/' + port + '/', {
      headers: requestHeaders({}, sid), signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, until - Date.now()))),
    }).then(async (res) => {
      status = res.status;
      return { status, body: await res.text() };
    }).catch((error) => ({ status, body: `${status ? 'response body' : 'response headers'}: ${error.message}` }));
    last = `HTTP ${r.status}: ${r.body.slice(0, 240)}`;
    return r;
  };
  while (Date.now() < deadline && !proc.exit) {
    const r = await request(deadline);
    if (accepts(r)) { response = r; break; }
    await sleep(1000);
  }
  // Retain the strengthened first-run proof: every further request succeeds,
  // across at least 65 seconds and at least fourteen further requests.
  if (response) {
    const started = Date.now();
    let requests = 0;
    for (; !proc.exit; requests++) {
      const r = await request(Date.now() + 30_000);
      if (!accepts(r)) { response = null; break; }
      response = r;
      if (Date.now() - started >= RESIDENCY_MS && requests + 1 >= RESIDENCY_REQUESTS) break;
      await sleep(Math.min(5_000, Math.max(0, RESIDENCY_MS - (Date.now() - started))));
    }
    console.log(`[framework-dev] pid=${pid} residency=${Date.now() - started}ms furtherRequests=${requests + (response && !proc.exit ? 1 : 0)} healthy=${!!response && !proc.exit}`);
  }
  const output = text + proc.output;
  if (response && !proc.exit) return { ok: true, pid, output, last, process: proc, response };
  if (!proc.exit) {
    proc.signal('SIGKILL');
    for (let i = 0; i < 20 && !proc.exit; i++) await sleep(100);
  }
  proc.ws.close();
  return { ok: false, pid, output, last, process: null, response: null };
}
