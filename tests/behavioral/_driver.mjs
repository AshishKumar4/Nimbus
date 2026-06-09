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

import WebSocket from 'ws';

export const BASE = process.env.BASE || 'http://127.0.0.1:8792';
export const WS_BASE = BASE.replace(/^http/, 'ws');
export const AUTH_COOKIE = process.env.NIMBUS_PROBE_COOKIE || process.env.NIMBUS_AUTH_COOKIE || '';
export const AUTH_TOKEN = process.env.NIMBUS_PROBE_TOKEN || '';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[\(\)][AB012]/g, '');
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

const sessionAttachPaths = new Map();

/** POST /new → 302 → sid. The only session-creation surface. */
export async function mintSession() {
  const r = await fetch(`${BASE}/new`, { method: 'POST', redirect: 'manual', headers: requestHeaders() });
  const loc = r.headers.get('location');
  if (!loc) throw new Error(`POST /new returned no Location (status ${r.status})`);
  const m = loc.match(/\/s\/([^/]+)/);
  if (!m) throw new Error(`unexpected Location: ${loc}`);
  sessionAttachPaths.set(m[1], loc);
  return m[1];
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
  const text = await r.text().catch(() => '');
  return { ok: r.ok, status: r.status, body: text };
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
  constructor(sid) {
    this.sid = sid;
    this.ws = null;
    this.buf = '';
    this.connected = false;
    this.closed = false;
  }

  async connect(timeoutMs = 15_000) {
    this.ws = new WebSocket(`${WS_BASE}/s/${this.sid}/ws`, wsHeaders());
    this.connected = false;
    this.closed = false;
    this.ws.on('open', () => { this.connected = true; });
    this.ws.on('close', () => { this.closed = true; });
    this.ws.on('error', () => { /* swallow; close fires after */ });
    this.ws.on('message', (data) => {
      try {
        const m = JSON.parse(data.toString('utf8'));
        if (m.type === 'output' && typeof m.data === 'string') {
          this.buf += m.data;
        }
      } catch { /* non-json control frames ignored */ }
    });
    const t0 = Date.now();
    while (!this.connected && Date.now() - t0 < timeoutMs) await sleep(50);
    if (!this.connected) throw new Error('Terminal connect timeout');
  }

  send(line) {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error('WS not open');
    this.ws.send(JSON.stringify({ type: 'input', data: line }));
  }

  /** Send a command + carriage return. */
  cmd(line) {
    this.send(line + '\r');
  }

  reset() { this.buf = ''; }

  /** Wait until predicate(stripped buf) returns true. */
  async waitFor(predicate, timeoutMs = 30_000, label = 'pattern') {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (predicate(stripAnsi(this.buf))) return Date.now() - t0;
      if (this.closed) throw new Error(`Terminal closed while waiting for ${label}`);
      await sleep(50);
    }
    throw new Error(`waitFor(${label}) timeout after ${timeoutMs}ms; tail: ${JSON.stringify(stripAnsi(this.buf).slice(-300))}`);
  }

  /** Wait until the most recent line ends with a shell prompt ($ or # or >). */
  async waitForPrompt(timeoutMs = 30_000) {
    return this.waitFor(
      (b) => /[$#>]\s*$/.test(b.trimEnd().slice(-3)),
      timeoutMs,
      'prompt',
    );
  }

  /** Wait for a NEW prompt after sending input (avoids returning on the prior prompt). */
  async waitForNewPrompt(timeoutMs = 30_000) {
    const startLen = this.buf.length;
    return this.waitFor(
      (b) => b.length > 0 && this.buf.length > startLen && /[$#>]\s*$/.test(b.trimEnd().slice(-3)),
      timeoutMs,
      'new prompt',
    );
  }

  /**
   * Run a shell command + wait for the prompt to return; return the
   * stdout chunk produced (output between this command's echo and the
   * next prompt). Best-effort: we strip the command echo from the head.
   */
  async run(line, timeoutMs = 60_000) {
    this.reset();
    const t0 = Date.now();
    this.cmd(line);
    await this.waitForNewPrompt(timeoutMs);
    const elapsed = Date.now() - t0;
    return { elapsed, output: stripAnsi(this.buf) };
  }

  async close() {
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
  let open = false;
  let closed = false;
  let exit = null;
  let stdinAck = null;
  let text = '';

  ws.on('open', () => { open = true; });
  ws.on('close', () => { closed = true; });
  ws.on('error', () => {});
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

  const started = Date.now();
  while (!open && Date.now() - started < timeoutMs) await sleep(50);
  if (!open) throw new Error('process terminal WebSocket connect timeout');

  return {
    ws,
    async waitFor(predicate, waitMs = 30_000, label = 'process terminal output') {
      const t0 = Date.now();
      while (Date.now() - t0 < waitMs) {
        if (predicate(stripAnsi(text))) return Date.now() - t0;
        if (closed) {
          throw new Error(`process terminal WebSocket closed while waiting for ${label}; tail=${JSON.stringify(stripAnsi(text).slice(-400))}`);
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
 * Helper for assertion-style probes. Maintains pass/fail counts +
 * a label.
 */
export function makeAsserter(label) {
  let pass = 0;
  let fail = 0;
  const failures = [];
  return {
    check(name, ok, detail = '') {
      if (ok) { console.log(`  ✓ ${name}`); pass++; }
      else { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); failures.push(`${name}: ${detail}`); fail++; }
    },
    summary() {
      console.log(`\n  ──── [${label}] ${pass} pass / ${fail} fail`);
      return { pass, fail, failures };
    },
    get pass() { return pass; },
    get fail() { return fail; },
  };
}
