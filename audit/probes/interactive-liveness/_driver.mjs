// Shared driver for the interactive-liveness probe class.
//
// These three probes (long-form-replay / walltime-distribution /
// error-recovery) are the acceptance harness for plan §3 Track A'+B'+D'.
// They run against local wrangler dev (BASE env) by default; flip BASE
// to point at prod for prod-side smoke tests.
//
// Design intent: each probe's pass/fail criteria are stated as
// architectural assertions ("isolateGen does not bump", "p99 wallTime
// on /api/_diag/memory < 500 ms", "recovery transitions show
// dataLoss=false"). Failures point at a regression in a specific
// phase of the rebuild.

import WebSocket from 'ws';

export const BASE = process.env.BASE || 'http://127.0.0.1:8792';
export const WS_BASE = BASE.replace(/^http/, 'ws');

export function strip(s) {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[\(\)][AB012]/g, '');
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function mintSession() {
  const r = await fetch(`${BASE}/new`, { method: 'POST', redirect: 'manual' });
  const loc = r.headers.get('location');
  if (!loc) throw new Error(`/new returned no Location (status ${r.status})`);
  const m = loc.match(/^\/s\/([^/]+)\/?$/);
  if (!m) throw new Error(`unexpected Location: ${loc}`);
  return m[1];
}

export async function getDiag(sid) {
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/memory`);
  if (!r.ok) throw new Error(`diag fetch failed: ${r.status}`);
  return r.json();
}

/**
 * Minimal WS client for shell-terminal sessions. Tracks the output
 * buffer + the count of MOTD banner appearances (the "DO RESET"
 * tell). Provides waitFor / waitForPrompt for synchronizing on
 * shell state.
 */
export class WsSession {
  constructor(sid) {
    this.sid = sid;
    this.ws = null;
    this.buf = '';
    this.bannerCount = 0;
    this.connected = false;
    this.closed = false;
    this.bannerMarker = 'Cloud Dev Environment';
  }

  async connect(timeoutMs = 10000) {
    this.ws = new WebSocket(`${WS_BASE}/s/${this.sid}/ws`);
    this.connected = false;
    this.closed = false;
    this.ws.on('open', () => { this.connected = true; });
    this.ws.on('close', () => { this.closed = true; });
    this.ws.on('error', () => {/* swallow; close fires after */});
    this.ws.on('message', (data) => {
      try {
        const m = JSON.parse(data.toString('utf8'));
        if (m.type === 'output' && typeof m.data === 'string') {
          this.buf += m.data;
          if (m.data.includes(this.bannerMarker)) this.bannerCount++;
        }
      } catch {/* ignore */}
    });
    const t0 = Date.now();
    while (!this.connected && Date.now() - t0 < timeoutMs) await sleep(50);
    if (!this.connected) throw new Error('WS connect timeout');
  }

  send(data) {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error('WS not open');
    this.ws.send(JSON.stringify({ type: 'input', data }));
  }

  async waitFor(predicate, timeoutMs, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (predicate(this.buf)) return;
      await sleep(50);
    }
    throw new Error(`waitFor timeout after ${timeoutMs}ms: ${label} (last 200 chars: ${JSON.stringify(this.buf.slice(-200))})`);
  }

  async waitForPrompt(timeoutMs = 5000) {
    return this.waitFor(
      (b) => /\$ ?$|# ?$|> ?$/.test(strip(b).trimEnd().slice(-3)),
      timeoutMs,
      'prompt',
    );
  }

  /**
   * Like waitForPrompt, but waits for a NEW prompt — useful when the
   * buf already contains a prompt at end (from prior command) and we
   * just sent input. Strategy: capture buf length when called; wait
   * until buf grows AND ends with a prompt. Avoids the race where
   * the test loop "passes" instantly on the prior command's prompt.
   */
  async waitForNewPrompt(timeoutMs = 5000) {
    const startLen = this.buf.length;
    return this.waitFor(
      (b) => b.length > startLen && /\$ ?$|# ?$|> ?$/.test(strip(b).trimEnd().slice(-3)),
      timeoutMs,
      'new prompt',
    );
  }

  /** Read the cwd portion of the most recent prompt
   *  (e.g. user@nimbus:~/app$). Returns null when the buffer doesn't
   *  contain a prompt. */
  promptCwd() {
    const stripped = strip(this.buf);
    const m = stripped.match(/user@nimbus:([^$#]+)[$#]\s*$/);
    return m ? m[1].trim() : null;
  }

  reset() { this.buf = ''; }

  close() {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) this.ws.close();
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (this.closed || Date.now() - t0 > 3000) { clearInterval(iv); resolve(); }
      }, 25);
    });
  }
}

/** Compute a histogram bucket label for a wallTime value (ms). */
export function wallTimeBucket(ms) {
  if (ms < 100) return '<100';
  if (ms < 500) return '100-500';
  if (ms < 1000) return '500-1000';
  if (ms < 4500) return '1-5s';
  if (ms < 6000) return '~5s';
  if (ms < 15000) return '5-15s';
  if (ms < 60000) return '15-60s';
  return '>60s';
}

/** Statistics helpers for the wallTime probe. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((sorted.length - 1) * p / 100);
  return sorted[idx];
}
