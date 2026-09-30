// @serial — browser probe: launches a real Chrome under the run's shared profile root, which the runner's orphan reaper cannot scope to one probe mid-run
// session-lifecycle/new/ws-close-handshake-answered — the session answers a
// browser's close frame on every socket it accepts.
//
// RFC 6455 §5.5.1: an endpoint that receives a Close frame sends a Close
// frame in response, and a browser that closes first fires `close` only on
// that answer. Measured on a throwaway before this fix, from Chrome: the
// terminal and file-watch sockets' closes went unanswered until Chrome's own
// 60 s handshake timeout, which froze the isolated-shell switch for a minute
// (it hands the terminal over by closing its socket). A Node `ws` client saw
// its closes answered on the same build, so this probe closes from Chrome.
//
// The shell page's own terminal socket, a file-watch socket and a
// process-log socket each close from the page and must finish within 5 s.

import { AUTH_TOKEN, BASE, Terminal, deleteSession, heredocCommand, makeAsserter, mintSession } from '../../_driver.mjs';
import { applyProbeCookies, exchangeAttachCookie, launchBrowser } from '../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'session-lifecycle/new/ws-close-handshake-answered';
const a = makeAsserter(label);
console.log(`${label} — BASE=${BASE}`);

const ANSWERED_WITHIN_MS = 5_000;

const sid = await mintSession();
const browser = await launchBrowser({ timeout: 60_000 });
try {
  const terminal = new Terminal(sid);
  await terminal.connect();
  await terminal.waitForPrompt(30_000);
  await terminal.run(heredocCommand('/home/user/quiet.js', "require('http').createServer((req, res) => res.end('ok')).listen(3005);"), 15_000);
  const started = await terminal.run('node --watch /home/user/quiet.js', 60_000);
  const pid = Number(started.output.match(/pid=(\d+)/)?.[1] || 0);
  a.check('a process to stream logs from', pid > 0, started.output.slice(-300));
  await terminal.close();

  const page = await browser.newPage();
  if (AUTH_TOKEN) await exchangeAttachCookie(page, sid);
  else await applyProbeCookies(page);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN, { timeout: 60_000 });

  const outcomes = await page.evaluate(async ({ pid, withinMs }) => {
    const base = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + location.pathname.replace(/\/$/, '');
    const open = (url) => new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.onopen = () => resolve(socket);
      socket.onerror = () => reject(new Error('could not open ' + url));
    });
    const closeTimed = (socket) => new Promise((resolve) => {
      const started = performance.now();
      const timer = setTimeout(() => resolve({ ms: null }), withinMs);
      socket.addEventListener('close', (event) => {
        clearTimeout(timer);
        resolve({ ms: Math.round(performance.now() - started), code: event.code, clean: event.wasClean });
      }, { once: true });
      socket.close(1000, 'probe done');
    });
    const watch = await closeTimed(await open(base + '/ws?kind=fs-watch'));
    const logs = await closeTimed(await open(base + '/api/logs/' + pid));
    // The shell's own terminal socket, taken out of its hands so it does not
    // redial into the measurement.
    const shellSocket = ws;
    ws = null;
    const shell = await closeTimed(shellSocket);
    return { watch, logs, shell };
  }, { pid, withinMs: ANSWERED_WITHIN_MS });

  for (const [name, outcome] of [['terminal', outcomes.shell], ['file-watch', outcomes.watch], ['process-log', outcomes.logs]]) {
    a.check(`the ${name} socket’s close is answered within ${ANSWERED_WITHIN_MS / 1000} s`, outcome.ms !== null && outcome.clean === true, JSON.stringify(outcome));
  }

  // The terminal is free again at once: a new terminal is not refused.
  const again = new Terminal(sid);
  await again.connect();
  await again.waitForPrompt(30_000);
  a.check('a new terminal attaches right after', again.connected === true);
  await again.close();
} catch (error) {
  a.check('probe completed', false, error instanceof Error ? error.stack : String(error));
} finally {
  await browser.close().catch(() => {});
  await deleteSession(sid);
}

const summary = a.summary();
process.exit(summary.fail > 0 ? 1 : 0);
