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
import { deletionResult } from './_ledger.mjs';

export const BASE = process.env.BASE || 'http://127.0.0.1:8792';
export const WS_BASE = BASE.replace(/^http/, 'ws');
export const AUTH_COOKIE = process.env.NIMBUS_PROBE_COOKIE || process.env.NIMBUS_AUTH_COOKIE || '';
export let AUTH_TOKEN = process.env.NIMBUS_PROBE_TOKEN || '';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function stripAnsi(s) {
  return s.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[\(\)][AB012]/g, '');
}

function authHeaders() {
  const headers = {};
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;
  if (AUTH_COOKIE) headers.Cookie = AUTH_COOKIE;
  return headers;
}

export function requestHeaders(extra = {}) {
  return { ...authHeaders(), ...extra };
}

/** Options for `new WebSocket(url, wsHeaders())` carrying probe auth. */
export function wsHeaders() {
  const headers = authHeaders();
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

/**
 * `text` with every credential it may carry replaced by `…`: an attach token
 * in a URL's query (`nimbus_token=`, and any `token=`/`access_token=`), and
 * a bearer. The one helper for every URL or response a probe prints; every
 * assertion detail goes through it (makeAsserter).
 */
export function redactCredentials(text) {
  return String(text)
    .replace(/([?&#](?:nimbus_token|access_token|token)=)[^&#\s"'<>]+/gi, '$1…')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1…');
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

const sessionAttachPaths = new Map();

// Every minted session is DELETEd at exit unless deleteSession already did; only SIGKILL or a crash escapes.
const LEDGER = process.env.NIMBUS_PROBE_LEDGER || '';
const PROBE = relative(dirname(fileURLToPath(import.meta.url)), process.argv[1] || '');
const undeleted = new Map(); // sid → the headers it was minted with
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
function noteMinted(sid, status, { reap } = {}) {
  if (!exitHookArmed) {
    exitHookArmed = true;
    // First, so a failure names its sessions as they were before the hook below deletes them.
    process.on('exit', nameMintedOnFailure);
    process.on('exit', deleteUndeletedSync);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(signal, () => process.exit(130));
    }
  }
  undeleted.set(sid, requestHeaders({ 'X-Nimbus-Cleanup-Reason': 'probe-exit' }));
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

// 'exit' listeners must be synchronous, so a child of the same runtime runs the fetches.
// Each DELETE is read through deletionResult: only the destroy result confirms a deletion.
// A 503 (the session object refusing work it is too busy to admit; the destroy
// never ran) or a failed request is tried again, after the answer's Retry-After
// (else 1 s), at most DELETE_TRIES times within DELETE_BUDGET_MS: a session busy
// with an install refused its DELETE once and was counted a leak while it lived.
// Any other answer is the verdict. The destroy is idempotent.
const DELETE_TRIES = 4;
const DELETE_BUDGET_MS = 30_000;
const DELETE_SESSIONS = `
(async () => {
  const { deletionResult } = await import(${JSON.stringify(new URL('./_ledger.mjs', import.meta.url).href)});
  const { base, sessions, tries, budgetMs } = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const results = await Promise.all(sessions.map(async ([sid, headers]) => {
    const deadline = Date.now() + budgetMs;
    let last;
    for (let attempt = 1; ; attempt++) {
      let waitMs = 1000;
      try {
        const response = await fetch(base + '/s/' + encodeURIComponent(sid) + '/', {
          method: 'DELETE', headers, signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
        });
        const result = await deletionResult(response);
        last = { status: result.status, confirmed: result.ok, attempts: attempt };
        if (response.status !== 503) return last;
        const after = Number(response.headers.get('retry-after'));
        if (Number.isFinite(after) && after >= 0) waitMs = after * 1000;
      } catch (error) {
        last = { status: 'error: ' + error.message, confirmed: false, attempts: attempt };
      }
      if (attempt >= tries || Date.now() + waitMs >= deadline) return last;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }));
  process.stdout.write(JSON.stringify(results));
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;

function deleteUndeletedSync() {
  // NIMBUS_PROBE_KEEP_SESSIONS=1 leaves them for forensics (a dead session's next incarnation holds its _diag).
  if (undeleted.size === 0 || process.env.NIMBUS_PROBE_KEEP_SESSIONS === '1') return;
  const sessions = [...undeleted];
  let statuses;
  try {
    statuses = JSON.parse(execFileSync(process.execPath, ['-e', DELETE_SESSIONS], {
      input: JSON.stringify({ base: BASE, sessions, tries: DELETE_TRIES, budgetMs: DELETE_BUDGET_MS }),
      encoding: 'utf8',
      timeout: 60_000,
    }));
  } catch (e) {
    statuses = sessions.map(() => ({ status: `error: ${String(e?.message ?? e).split('\n')[0]}`, confirmed: false }));
  }
  sessions.forEach(([sid], i) => {
    const result = statuses[i];
    const tries = result.attempts > 1 ? ` after ${result.attempts} tries` : '';
    console.log(`deleteSession (exit hook): ${sid} → ${result.status} confirmed=${result.confirmed === true}${tries}`);
    ledger('exit-delete', sid, result.status, { confirmed: result.confirmed === true, attempts: result.attempts });
  });
}

/**
 * Why `POST /new` produced no session, in terms an operator can act on.
 *
 * A rejected credential is not a probe failure, but it presents as one:
 * measured 2026-08-05, a redeploy elsewhere on this machine rotated the
 * target's `JWT_SECRET` mid-suite and 360 probes failed in 35 seconds
 * with `no Location (status 401)` — the whole suite red, no Nimbus code
 * reached, hours spent looking for the bug in Nimbus. The credential is
 * the first thing this message names.
 */
function newSessionFailure(status, body) {
  const detail = body.trim().split('\n')[0].slice(0, 200);
  if (status !== 401 && status !== 403) {
    return `POST ${BASE}/new → ${status}, no Location${detail ? `: ${detail}` : ''}`;
  }
  if (AUTH_TOKEN) {
    return (
      `POST ${BASE}/new → ${status}: the target rejected this probe's bearer token.\n`
      + `The token is signed with a JWT_SECRET the target no longer has — the target was\n`
      + `redeployed with a rotated secret — or the token has expired. No probe code ran.\n`
      + `Re-mint a token for the target BASE points at:\n`
      + `  staging   → bun tests/behavioral/_staging-target.mjs token\n`
      + `  throwaway → bun tests/behavioral/_throwaway-target.mjs token --name <name>`
    );
  }
  return (
    `POST ${BASE}/new → ${status}: no probe credential was sent.\n`
    + `Export NIMBUS_PROBE_TOKEN (\`bun tests/behavioral/_staging-target.mjs token\`) or\n`
    + `NIMBUS_PROBE_COOKIE before running probes against a deployed target.`
  );
}

/** POST /new → 302 → sid. The only session-creation surface. */
export async function mintSession() {
  const r = await fetch(`${BASE}/new`, { method: 'POST', redirect: 'manual', headers: requestHeaders() });
  const loc = r.headers.get('location');
  if (loc) {
    const m = loc.match(/\/s\/([^/]+)/);
    if (!m) throw new Error(`unexpected Location: ${loc}`);
    sessionAttachPaths.set(m[1], loc);
    noteMinted(m[1], r.status);
    return m[1];
  }

  // The one target where an unauthenticated POST /new is expected to fail:
  // production gates it on an interactive login, and the public anonymous
  // demo endpoint mints a sid-pinned attach token for the session it opens.
  // Anything else — or a probe carrying a credential — is still the loud
  // credential failure, not a silent fallback.
  const text = await r.text().catch(() => '');
  const code = (() => { try { return JSON.parse(text)?.code; } catch { return undefined; } })();
  if (r.status === 401 && code === 'E_DEMO_LOGIN_REQUIRED' && !AUTH_TOKEN && !AUTH_COOKIE) {
    const created = await fetch(`${BASE}/api/demo/anon-session`, { method: 'POST' });
    const body = await created.json().catch(() => ({}));
    if (!created.ok) {
      throw new Error(
        `anon session ${created.status}: ${JSON.stringify(body)}`
        + (created.status === 429 ? ' (per-IP rate limit; retry in a minute)' : '')
        + (created.status === 503 ? ' (global anon capacity reached)' : ''),
      );
    }
    const token = new URL(body.wsUrl, BASE).searchParams.get('nimbus_token');
    if (!body.sessionId || !token) {
      throw new Error(`anon session gave no sid/token: ${JSON.stringify(body)}`);
    }
    // Live binding: importers that read AUTH_TOKEN after this call see the
    // sid-pinned bearer, so requestHeaders()/wsHeaders() pick it up too.
    AUTH_TOKEN = token;
    // The shell page, as POST /new's Location names it: a browser exchanges
    // its token there for the session cookie. wsUrl is the WebSocket, which
    // answers a page load 426 and sets nothing.
    sessionAttachPaths.set(body.sessionId, `/s/${encodeURIComponent(body.sessionId)}/?nimbus_token=${encodeURIComponent(token)}`);
    noteMinted(body.sessionId, created.status, { reap: 'ttl' });
    return body.sessionId;
  }

  throw new Error(newSessionFailure(r.status, text));
}

/**
 * The attach path returned by `/new` for this session. In enforce mode
 * it carries the single-use bootstrap token that exchanges into the
 * session cookie on first navigation; otherwise the clean session path.
 */
export function attachPathFor(sid) {
  return sessionAttachPaths.get(sid) || `/s/${sid}/`;
}

export async function deleteSession(sid, reason = 'behavioral-probe-cleanup') {
  const r = await fetch(`${BASE}/s/${encodeURIComponent(sid)}/`, {
    method: 'DELETE',
    headers: requestHeaders({ 'X-Nimbus-Cleanup-Reason': reason }),
  });
  const result = await deletionResult(r);
  ledger('delete', sid, result.status, { confirmed: result.ok });
  if (result.ok) undeleted.delete(sid);
  return result;
}

/** GET /s/<sid>/preview/ — returns {status, html}. */
export async function fetchPreview(sid, opts = {}) {
  const url = `${BASE}/s/${sid}/preview/${opts.path || ''}`;
  const t0 = Date.now();
  const r = await fetch(url, { redirect: 'manual', headers: requestHeaders() });
  const text = await r.text().catch(() => '');
  return { status: r.status, html: text, elapsed: Date.now() - t0, url };
}

/** Fetch /s/<sid>/port/<n>/ — returns {status, body}. */
export async function fetchPort(sid, port, path = '', init = {}) {
  const url = `${BASE}/s/${sid}/port/${port}/${path}`;
  const t0 = Date.now();
  const extraHeaders = init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
  const r = await fetch(url, { ...init, redirect: 'manual', headers: requestHeaders(extraHeaders) });
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
    this.wsOptions = options.wsOptions ?? wsHeaders();
    this.ws = null;
    // reset() clears the caller's view, never the shell protocol stream.
    this.stream = '';
    this.bufferStart = 0;
    this.submitCursor = 0;
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
    this.ws = new WebSocket(`${this.wsBase}/s/${this.sid}/ws`, this.wsOptions);
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
        } else if (m.type === 'spawn') {
          this.spawns.push(m);
        }
      } catch { /* non-json control frames ignored */ }
    });
    await awaitSocketOpen(this.ws, timeoutMs, `terminal WebSocket /s/${this.sid}/ws`);
  }

  send(line) {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error('WS not open');
    if (/[\r\n]/.test(line)) this.submitCursor = this.stream.length;
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
        reject(new Error(`waitFor(${label}) timeout after ${timeoutMs}ms; tail: ${JSON.stringify(stripAnsi(this.buf).slice(-300))}`));
      }, timeoutMs);
      this.ws?.on('message', check);
      this.ws?.on('close', check);
      check();
    });
  }

  promptAfter(cursor) {
    let exitCode = null;
    for (const mark of this.stream.slice(cursor).matchAll(/\x1b\]133;([ABCD])(?:;(-?\d+))?(?:\x07|\x1b\\)/g)) {
      if (mark[1] === 'C') exitCode = null;
      if (mark[1] === 'D') exitCode = mark[2] === undefined ? null : Number(mark[2]);
      if (mark[1] === 'B') return { end: cursor + mark.index + mark[0].length, exitCode };
    }
    return null;
  }

  /** The first shell prompt-end mark after cmd(), even if it already arrived. */
  async waitForPrompt(timeoutMs = 30_000) {
    const cursor = this.submitCursor;
    return this.waitFor(() => this.promptAfter(cursor) !== null, timeoutMs, 'shell prompt-end mark');
  }

  /**
   * Run a shell command through its first prompt-end mark. Output includes
   * the terminal's command echo and prompt; bare D yields a null exitCode.
   */
  async run(line, timeoutMs = 60_000) {
    this.reset();
    const t0 = Date.now();
    this.cmd(line);
    const cursor = this.submitCursor;
    await this.waitForPrompt(timeoutMs);
    const completion = this.promptAfter(cursor);
    const elapsed = Date.now() - t0;
    return { elapsed, output: stripAnsi(this.stream.slice(cursor, completion.end)), exitCode: completion.exitCode };
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
  const ws = new WebSocket(`${WS_BASE}/s/${sid}/api/logs/${pid}`, wsHeaders());
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

/**
 * Helper for assertion-style probes. Maintains pass/fail counts +
 * a label.
 */
export function makeAsserter(label) {
  let pass = 0;
  let fail = 0;
  const failures = [];
  return {
    check(name, ok, detail = '') {
      if (ok) { console.log(`  ✓ ${name}`); pass++; return; }
      // A detail is often a URL or a response: never a live credential.
      const shown = redactCredentials(String(detail));
      console.log(`  ✗ ${name}${shown ? ' — ' + shown : ''}`);
      failures.push(`${name}: ${shown}`);
      fail++;
    },
    summary() {
      console.log(`\n  ──── [${label}] ${pass} pass / ${fail} fail`);
      return { pass, fail, failures };
    },
    get pass() { return pass; },
    get fail() { return fail; },
  };
}
