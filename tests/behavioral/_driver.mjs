// Black-box driver for behavioral probes.
//
// CHARTER: NO knowledge of facets/isolates/heap/W7/_diag. Public
// surfaces only:
//   - POST /new                   → mint session, returns sid
//   - WS   /s/<sid>/ws            → terminal stdin/stdout
//   - GET  /s/<sid>/preview/      → vite dev output
//   - GET  /s/<sid>/port/<n>/     → user-bound HTTP servers
//
// Each helper is a thin wrapper over fetch + ws. No /api/_diag/*,
// no /api/_test/*, no /api/processes — those are white-box surfaces

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createProbeTarget, redactCredentials } from './_session-transport.mjs';
export { redactCredentials };
export { makeAsserter } from './_assertions.mjs';

export const BASE = process.env.BASE || 'http://127.0.0.1:8792';
export const WS_BASE = BASE.replace(/^http/, 'ws');
export const AUTH_COOKIE = process.env.NIMBUS_PROBE_COOKIE || process.env.NIMBUS_AUTH_COOKIE || '';
export const AUTH_TOKEN = process.env.NIMBUS_PROBE_TOKEN || '';
export const probeTarget = createProbeTarget({ base: BASE, token: AUTH_TOKEN, cookie: AUTH_COOKIE });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function stripAnsi(s) {
  return s.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[\(\)][AB012]/g, '');
}

export function requestHeaders(extra = {}, sid) {
  return probeTarget.headers(extra, sid);
}

/** Options for `new WebSocket(url, wsHeaders())` carrying probe auth. */
export function wsHeaders(sid) {
  const headers = probeTarget.headers({}, sid);
  return Object.keys(headers).length > 0 ? { headers } : undefined;
}

/**
 * What the session `sid` recorded about itself since `openedAt`, read after
 * its socket closed abnormally: its isolate generation now, and its recovery
 * ring's transitions since then (/api/_diag/memory, which every probe
 * target serves: NIMBUS_DEBUG, PROBE_TARGET_VARS). A `ws-close`/`ws-error`
 * on the generation it had means the session saw its socket end and lived:
 * the connection dropped. An `init-session` after the socket opened, on a
 * higher generation, means a fresh isolate: the session was reset or
 * evicted. The ring is per isolate, so another session sharing it can add
 * lines. `headers` are the socket's own credentials. Resolves to text,
 * never throws; bounded at 10 s.
 */
async function sessionRecord(sid, openedAt, base, headers) {
  try {
    const r = await fetch(`${base}/s/${encodeURIComponent(sid)}/api/_diag/memory`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return `the session's record: unavailable (/api/_diag/memory answered ${r.status})`;
    const diag = await r.json();
    const time = (at) => new Date(at).toISOString().slice(11, 23);
    const since = (diag.recoveryEvents ?? []).filter((e) => e.at >= openedAt - 1000).reverse()
      .map((e) => `${time(e.at)} ${e.fromState}→${e.toState} ${e.trigger} gen ${e.isolateGen}${e.dataLoss ? ' DATA LOSS' : ''}`);
    return `the session's record (socket opened ${time(openedAt)}; isolate gen now ${diag.hib?.isolateGen ?? '?'}): ${since.length ? since.join('; ') : 'no transitions since the socket opened'}`;
  } catch (error) {
    return `the session's record: unavailable (${error.message})`;
  }
}

/** A close frame in one clause: `code 1006 (abnormal): <reason>`. */
function describeSocketClose(code, reason) {
  const text = reason ? String(reason).slice(0, 200) : '';
  const known = code === 1000 ? 'normal'
    : code === 1001 ? 'going away'
    : code === 1006 ? 'abnormal — no close frame: the session reset, or the connection dropped; the session\'s own record follows'
    : code === 1011 ? 'server error'
    : code === 1012 ? 'service restart'
    : null;
  return `close code ${code}${known ? ` (${known})` : ''}${text ? `: ${text}` : ''}`;
}

/**
 * Wait for a WebSocket to open, and if it does not, say why the server did
 * not open it.
 *
 * Every failure on these routes used to present as one string — `connect
 * timeout` — because the `error` event was discarded and the wait loop never
 * looked at `close`. An auth rejection, the router's catch-all 500 (a
 * Durable Object that is overloaded or was reset rejects `stub.fetch`, and
 * that is what the caller gets), and a genuinely silent server were
 * indistinguishable, so the one measurement the probe could take about its
 * own failure was the one it threw away. A refused upgrade already names
 * itself in the `error` event — "Unexpected server response: 500" under node's
 * `ws`, "Expected 101 status code" under bun's — so keeping that event is the
 * whole fix. (`unexpected-response`, which carries the status object itself,
 * is not implemented in bun and would only warn on every socket.)
 */
async function awaitSocketOpen(ws, timeoutMs, what) {
  let open = false;
  let closed = null;
  let rejected = null;
  ws.on('open', () => { open = true; });
  ws.on('close', (code, reason) => { closed ??= describeSocketClose(code, reason); });
  ws.on('error', (e) => { rejected ??= `socket error: ${e?.message ?? String(e)}`; });

  const t0 = Date.now();
  while (!open && !closed && !rejected && Date.now() - t0 < timeoutMs) await sleep(50);
  if (open) return;
  const why = rejected ?? closed ?? `no response in ${timeoutMs}ms`;
  throw new Error(`${what} did not open: ${why}`);
}

// A WebSocket silent both ways for ~270 s is dropped before the session (1006, no close frame).
const SOCKET_KEEPALIVE_MS = 30_000;

function keepSocketAlive(ws, everyMs = SOCKET_KEEPALIVE_MS) {
  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.ping(); } catch { /* closing under us: its close stops this */ }
  }, everyMs);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  ws.on('close', stop);
  ws.on('error', stop);
}

// Every minted session is DELETEd at exit unless deleteSession already did; only SIGKILL or a crash escapes.
const LEDGER = process.env.NIMBUS_PROBE_LEDGER || '';
const PROBE = relative(dirname(fileURLToPath(import.meta.url)), process.argv[1] || '');
const undeleted = new Map(); // sid → its target-scoped session record
const minted = []; // { sid, at }: every session this probe minted, in order
let exitHookArmed = false;

function ledger(event, sid, status, extra = {}) {
  // One appendFileSync per line, so parallel probes never interleave lines.
  if (LEDGER) appendFileSync(LEDGER, `${JSON.stringify({ probe: PROBE, sid, event, status, at: new Date().toISOString(), ...extra })}\n`);
}

/**
 * `reap: 'ttl'` marks a session the probe cannot delete: an anonymous demo
 * session, whose DELETE answers 401 by design and which the demo's TTL reaps.
 * run-all reports it as TTL-reaped rather than leaked (see _ledger.mjs).
 */
function noteMinted(session) {
  const { sessionId: sid, status, reap } = session;
  if (!exitHookArmed) {
    exitHookArmed = true;
    // First, so a failure names its sessions as they were before the hook below deletes them.
    process.on('exit', nameMintedOnFailure);
    process.on('exit', deleteUndeletedSync);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(signal, () => process.exit(130));
    }
  }
  undeleted.set(sid, session);
  // One time for the mint, in the failure's list and the ledger alike: read
  // twice, the two could fall in different milliseconds.
  const at = new Date().toISOString();
  minted.push({ sid, at });
  ledger('mint', sid, status, { at, ...(reap ? { reap } : {}) });
}

/**
 * A failing probe's output names every session it minted, with the time it
 * was minted: a session that reset (a socket closed 1006) is then looked up
 * by that session in Workers Logs and Traces (AGENTS.md "Tails reset
 * sessions"), which a probe's own messages do not name.
 */
function nameMintedOnFailure(code) {
  if (code === 0) return;
  console.error(`sessions this probe minted on ${BASE} (exit ${code}):`);
  for (const { sid, at } of minted) console.error(`  ${sid}  minted ${at}${undeleted.has(sid) ? '' : '  (deleted by the probe)'}`);
}

// 'exit' listeners must be synchronous, so a child of the same runtime runs
// the DELETEs (_ledger.mjs deleteSessions: what is retried, and how long).
const DELETE_TRIES = 4;
const DELETE_BUDGET_MS = 30_000;
const DELETE_SESSIONS = `
import(${JSON.stringify(new URL('./_ledger.mjs', import.meta.url).href)})
  .then(({ deleteSessions }) => deleteSessions(JSON.parse(require('fs').readFileSync(0, 'utf8'))))
  .then((results) => process.stdout.write(JSON.stringify(results)))
  .catch((error) => { console.error(error); process.exitCode = 1; });
`;

function deleteUndeletedSync() {
  // NIMBUS_PROBE_KEEP_SESSIONS=1 leaves them for forensics (a dead session's next incarnation holds its _diag).
  if (undeleted.size === 0 || process.env.NIMBUS_PROBE_KEEP_SESSIONS === '1') return;
  const sessions = [...undeleted.values()];
  let statuses;
  try {
    statuses = JSON.parse(execFileSync(process.execPath, ['-e', DELETE_SESSIONS], {
      input: JSON.stringify({ sessions, tries: DELETE_TRIES, budgetMs: DELETE_BUDGET_MS }),
      encoding: 'utf8',
      timeout: 60_000,
    }));
  } catch (e) {
    statuses = sessions.map(() => ({ status: `error: ${String(e?.message ?? e).split('\n')[0]}`, confirmed: false }));
  }
  sessions.forEach(({ sessionId: sid }, i) => {
    const result = statuses[i];
    const tries = result.attempts > 1 ? ` after ${result.attempts} tries` : '';
    console.log(`deleteSession (exit hook): ${sid} → ${result.status} confirmed=${result.confirmed === true}${tries}`);
    ledger('exit-delete', sid, result.status, { confirmed: result.confirmed === true, attempts: result.attempts });
  });
}

/** POST /new → 302 → sid. The only session-creation surface. */
export async function mintSession() {
  const session = await probeTarget.create({ anonymous: true });
  noteMinted(session);
  return session.sessionId;
}

/**
 * The attach path returned by `/new` for this session. In enforce mode
 * it carries the single-use bootstrap token that exchanges into the
 * session cookie on first navigation; otherwise the clean session path.
 */
export function attachPathFor(sid) {
  return probeTarget.session(sid).attachPath;
}

export async function deleteSession(sid, reason = 'behavioral-probe-cleanup') {
  const result = await probeTarget.delete(sid, { reason });
  ledger('delete', sid, result.status, { confirmed: result.ok });
  if (result.ok) undeleted.delete(sid);
  return result;
}

/** GET /s/<sid>/preview/ — returns {status, html}. */
export async function fetchPreview(sid, opts = {}) {
  const url = `${BASE}/s/${sid}/preview/${opts.path || ''}`;
  const t0 = Date.now();
  const r = await fetch(url, { redirect: 'manual', headers: requestHeaders({}, sid) });
  const text = await r.text().catch(() => '');
  return { status: r.status, html: text, elapsed: Date.now() - t0, url };
}

/** Fetch /s/<sid>/port/<n>/ — returns {status, body}. */
export async function fetchPort(sid, port, path = '', init = {}) {
  const url = `${BASE}/s/${sid}/port/${port}/${path}`;
  const t0 = Date.now();
  const extraHeaders = init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
  const r = await fetch(url, { ...init, redirect: 'manual', headers: requestHeaders(extraHeaders, sid) });
  const text = await r.text().catch(() => '');
  return { status: r.status, body: text, headers: r.headers, elapsed: Date.now() - t0, url };
}

/**
 * Black-box terminal session. The ONLY public terminal surface is
 * the WebSocket; this class wraps it with a sufficient API to drive
 * shell commands and read output. No diag, no internal state peeking.
 */
export class Terminal {
  /**
   * `options.wsOptions` overrides how the socket authenticates. The suite's
   * bearer token is the default; an anonymous demo session has no bearer
   * token and carries the `__Host-nimbus_token` cookie the attach exchange
   * set in the browser instead.
   */
  constructor(sid, options = {}) {
    this.sid = sid;
    // Deploy readiness drives the freshly deployed target explicitly;
    // it must not inherit BASE from another suite in the caller's env.
    this.wsBase = (options.base ?? BASE).replace(/^http/, 'ws');
    this.wsOptions = options.wsOptions ?? ((options.base ?? BASE) === BASE ? wsHeaders(sid) : undefined);
    this.keepaliveMs = options.keepaliveMs ?? SOCKET_KEEPALIVE_MS;
    this.ws = null;
    // reset() clears the caller's view, never the shell protocol stream.
    this.stream = '';
    this.bufferStart = 0;
    this.submission = null;
    this.submissions = new Map();
    this.protocol = [];
    this.promptCursor = 0;
    /** The `spawn` frames the session sent: one per process it started. */
    this.spawns = [];
    this.connected = false;
    this.closed = false;
    this.closeDetail = null;
    this.closeCode = null;
    this.openedAt = null;
    this.closing = false;
  }

  async connect(timeoutMs = 15_000) {
    this.submission = null;
    this.promptCursor = this.protocol.length;
    this.ws = new WebSocket(`${this.wsBase}/s/${this.sid}/ws`, this.wsOptions);
    keepSocketAlive(this.ws, this.keepaliveMs);
    this.connected = false;
    this.closed = false;
    this.closeDetail = null;
    this.closeCode = null;
    this.closing = false;
    this.openedAt = Date.now();
    this.ws.on('open', () => { this.connected = true; this.openedAt = Date.now(); });
    this.ws.on('close', (code, reason) => {
      this.closed = true;
      this.closeCode = code;
      this.closeDetail = describeSocketClose(code, reason);
    });
    this.ws.on('message', (data) => {
      try {
        const m = JSON.parse(data.toString('utf8'));
        if (m.type === 'output' && typeof m.data === 'string') {
          this.stream += m.data;
        } else if (m.type === 'shell-integration') {
          this.protocol.push({ ...m, at: this.stream.length });
          const submission = this.submissions.get(m.submissionId);
          if (m.event === 'input' && submission) submission.ownerId = m.ownerId;
          if (m.event === 'end' && submission && submission.end === null && (m.exitCode === null || Number.isSafeInteger(m.exitCode))) {
            submission.end = this.stream.length;
            submission.exitCode = m.exitCode;
          }
        } else if (m.type === 'spawn') {
          this.spawns.push(m);
        }
      } catch { /* non-json control frames ignored */ }
    });
    await awaitSocketOpen(this.ws, timeoutMs, `terminal WebSocket /s/${this.sid}/ws`);
  }

  send(line) {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error('WS not open');
    if (/[\r\n]/.test(line)) {
      const submission = { id: crypto.randomUUID(), start: this.stream.length, end: null, exitCode: null, ownerId: null };
      this.submissions.set(submission.id, submission);
      this.submission = submission;
      this.ws.send(JSON.stringify({ type: 'input', data: line, submissionId: submission.id }));
      return;
    }
    if (line === '\x03') {
      this.promptCursor = this.protocol.length;
      this.submission = null;
    }
    this.ws.send(JSON.stringify({ type: 'input', data: line }));
  }

  /** Send a command + carriage return. */
  cmd(line) {
    this.send(line + '\r');
  }

  get buf() { return this.stream.slice(this.bufferStart); }

  reset() { this.bufferStart = this.stream.length; }

  /** Wait until predicate(stripped buf) returns true. */
  async waitFor(predicate, timeoutMs = 30_000, label = 'pattern') {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.ws?.off('message', check);
        this.ws?.off('close', check);
      };
      const check = () => {
        try {
          if (predicate(stripAnsi(this.buf))) { cleanup(); resolve(Date.now() - t0); }
          else if (this.closed) {
            cleanup();
            const elapsed = Date.now() - t0;
            // A close this side did not ask for classifies itself: the
            // session's own record of what happened to it since the socket opened.
            const record = !this.closing && this.closeCode !== 1000
              ? sessionRecord(this.sid, this.openedAt, this.wsBase.replace(/^ws/, 'http'), this.wsOptions?.headers ?? requestHeaders())
              : null;
            Promise.resolve(record).then((record) => reject(new Error(`Terminal closed while waiting for ${label} after ${elapsed}ms `
              + `(${this.closeDetail ?? 'no close frame'}); tail: ${JSON.stringify(stripAnsi(this.buf).slice(-600))}${record ? `\n${record}` : ''}`)));
          }
        } catch (error) { cleanup(); reject(error); }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`waitFor(${label}) timeout after ${timeoutMs}ms; tail: ${JSON.stringify(stripAnsi(this.buf).slice(-300))}; shell control: ${JSON.stringify(this.protocol.slice(-8))}`));
      }, timeoutMs);
      this.ws?.on('message', check);
      this.ws?.on('close', check);
      check();
    });
  }

  /** Trusted server completion for this input, or a fresh primary prompt on connect. */
  async waitForPrompt(timeoutMs = 30_000) {
    const submission = this.submission;
    const promptCursor = this.promptCursor;
    return this.waitFor(() => submission
      ? submission.end !== null
      : this.protocol.slice(promptCursor).some((frame) => frame.event === 'prompt'), timeoutMs, 'shell completion');
  }

  /**
   * Run one submitted batch through its server-confirmed end. Output includes
   * echoes and prompts; exitCode is the last executed command's status, or null.
   */
  async run(line, timeoutMs = 60_000) {
    this.reset();
    const t0 = Date.now();
    this.cmd(line);
    const submission = this.submission;
    await this.waitFor(() => submission.end !== null, timeoutMs, 'submitted shell batch');
    const elapsed = Date.now() - t0;
    return { elapsed, output: stripAnsi(this.stream.slice(submission.start, submission.end)), exitCode: submission.exitCode };
  }

  /** Write `content` to `path` with a quoted heredoc (heredocCommand). */
  async writeFile(path, content, timeoutMs = 10_000) {
    return this.run(heredocCommand(path, content), timeoutMs);
  }

  async close() {
    this.closing = true;
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      try { this.ws.close(); } catch { /* swallow */ }
    }
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (this.closed || Date.now() - t0 > 3_000) {
          clearInterval(iv);
          resolve();
        }
      }, 25);
    });
  }
}

export async function connectProcessTerminal(sid, pid, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const wsBase = (options.base ?? BASE).replace(/^http/, 'ws');
  const ws = new WebSocket(`${wsBase}/s/${sid}/api/logs/${pid}`, options.wsOptions ?? wsHeaders(sid));
  keepSocketAlive(ws, options.keepaliveMs);
  let closed = false;
  let closeDetail = null;
  let exit = null;
  let stdinAck = null;
  let text = '';

  ws.on('close', (code, reason) => {
    closed = true;
    closeDetail = describeSocketClose(code, reason);
  });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    if (msg.type === 'backlog') {
      for (const chunk of msg.chunks || []) text += String(chunk.data || '');
    } else if (msg.type === 'chunk') {
      text += String(msg.data || '');
    } else if (msg.type === 'exit') {
      exit = msg;
    } else if (msg.type === 'stdin-ack') {
      stdinAck = msg;
    }
  });

  await awaitSocketOpen(ws, timeoutMs, `process terminal /s/${sid}/api/logs/${pid}`);

  return {
    ws,
    async waitFor(predicate, waitMs = 30_000, label = 'process terminal output') {
      const t0 = Date.now();
      while (Date.now() - t0 < waitMs) {
        if (predicate(stripAnsi(text))) return Date.now() - t0;
        if (closed) {
          throw new Error(
            `process terminal WebSocket closed while waiting for ${label} `
            + `(${closeDetail ?? 'no close frame'}); `
            + `tail=${JSON.stringify(stripAnsi(text).slice(-400))}`,
          );
        }
        await sleep(50);
      }
      throw new Error(`waitFor(${label}) timeout after ${waitMs}ms; tail=${JSON.stringify(stripAnsi(text).slice(-400))}`);
    },
    input(data) {
      ws.send(JSON.stringify({ type: 'input', data }));
    },
    resize(columns, rows) {
      ws.send(JSON.stringify({ type: 'resize', columns, rows }));
    },
    signal(signal) {
      ws.send(JSON.stringify({ type: 'signal', signal }));
    },
    get rawOutput() { return text; },
    get output() { return stripAnsi(text); },
    get stdinAck() { return stdinAck; },
    get exit() { return exit; },
    get closed() { return closed; },
  };
}

/** Write a file via base64 + node -e to avoid shell-quoting hazards. */
export function writeFileViaShell(termCmd, path, content) {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  return termCmd(`node -e "require('fs').writeFileSync('${path}', Buffer.from('${b64}','base64').toString('utf8'))"`);
}

/**
 * Write a small file via the standard `cat > path << 'EOF' … EOF`
 * heredoc shape (tested against current shell). Lives here because
 * several behavioral probes need it.
 */
export function heredocCommand(path, content) {
  // Single-quoted EOF marker prevents shell expansion of $/`/\;
  return `cat > ${path} << 'NIMBUS_HEREDOC_EOF'\n${content}\nNIMBUS_HEREDOC_EOF`;
}

/**
 * What one `Terminal.run` printed: ANSI stripped, without the command's
 * echo line (`… $ cmd`) or the prompt it returned to.
 */
export function termBody(raw) {
  const lines = stripAnsi(raw).split(/\r?\n/);
  if (lines.length && /\$\s*$/.test(lines[lines.length - 1])) lines.pop();
  if (lines.length && /\$\s/.test(lines[0])) lines.shift();
  return lines.join('\n');
}

/**
 * Whether some line of `output`, trimmed, is exactly `expected`. A bare
 * `\r` ends a line as `\n` does: a terminal redraws over it.
 */
export function hasOutputLine(output, expected) {
  return stripAnsi(output)
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .includes(expected);
}
