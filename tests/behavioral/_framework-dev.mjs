// Real-framework dev proof: a bounded sequence of explicit relaunches, only
// when Nimbus reports code/read state that the next launch will stage.
// No retry on arbitrary framework errors or isolate resets.
import { BASE, connectProcessTerminal, requestHeaders, sleep, stripAnsi } from './_driver.mjs';

export const NEXT_FRAMEWORK_LAUNCH = /the next (?:launch|run) of (?:this|the same) command (?:stages|compiles) (?:it|them)/;
export const frameworkProxyHost = new URL(BASE).hostname;

export async function launchFrameworkDev({ terminal, sid, cwd, command, port, accepts, maxLaunches = 16, budgetMs = 180_000 }) {
  let last = 'not launched';
  let output = '';
  for (let attempt = 1; attempt <= maxLaunches; attempt++) {
    const start = await terminal.run(`cd ${cwd} && __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=${frameworkProxyHost} ${command}`, 180_000);
    const text = stripAnsi(start.output);
    const pid = Number(text.match(/\[(?:bin|facet) started \(long-running\): pid=(\d+)/)?.[1] || 0);
    if (!pid) return { ok: false, attempt, pid: 0, output: text, last: 'no resident process was launched', process: null, response: null };
    const proc = await connectProcessTerminal(sid, pid);
    let response = null;
    let next = false;
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
      output = proc.output;
      next = NEXT_FRAMEWORK_LAUNCH.test(output + r.body);
      if (next) break;
      await sleep(1000);
    }
    // A process can serve once and then fail its startup-residency check.
    await sleep(1000);
    output = proc.output;
    if (response && !proc.exit) return { ok: true, attempt, pid, output, last, process: proc, response };
    next ||= NEXT_FRAMEWORK_LAUNCH.test(text + output);
    if (!proc.exit) {
      proc.signal('SIGKILL');
      for (let i = 0; i < 20 && !proc.exit; i++) await sleep(100);
    }
    proc.ws.close();
    if (!next) return { ok: false, attempt, pid, output, last, process: null, response: null };
    console.log(`[framework] launch ${attempt} staged code or read state; relaunching`);
  }
  return { ok: false, attempt: maxLaunches, pid: 0, output, last, process: null, response: null };
}
