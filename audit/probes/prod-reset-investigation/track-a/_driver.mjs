// Track A probe driver — runs against local wrangler dev (or any BASE).
//
// Provides a small WS client that:
//   - connects /ws under a fresh /new session (or a pre-minted SID)
//   - streams `{type:'output', data}` frames into a buffer
//   - sends `{type:'input', data}` frames
//   - awaits patterns with timeout
//   - cleanly closes
//
// Track A's symptoms are server-side: connect → cd → close → reconnect →
// observe MOTD count + prompt cwd. We do not need any of the heavy
// _driver.mjs infrastructure (no node-eval, no lib-fs). Keep this driver
// small and self-contained so failures point at the change under test.

import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://127.0.0.1:8792';
const WS_BASE = BASE.replace(/^http/, 'ws');

function strip(s) {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[\(\)][AB012]/g, '');
}

export async function mintSession() {
  // Follow /new to get a fresh /s/<id>/.
  const res = await fetch(`${BASE}/new`, { method: 'POST', redirect: 'manual' });
  const loc = res.headers.get('location');
  if (!loc) throw new Error(`/new returned no Location header (status ${res.status})`);
  const m = loc.match(/^\/s\/([^/]+)\/?$/);
  if (!m) throw new Error(`unexpected Location: ${loc}`);
  return m[1];
}

export async function getDiag(sid) {
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/memory`);
  return await r.json();
}

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
    this.ws.on('error', (_e) => { /* swallow; we'll see via close */ });
    this.ws.on('message', (data) => {
      try {
        const m = JSON.parse(data.toString('utf8'));
        if (m.type === 'output' && typeof m.data === 'string') {
          this.buf += m.data;
          if (m.data.includes(this.bannerMarker)) this.bannerCount++;
        }
      } catch { /* ignore */ }
    });
    const t0 = Date.now();
    while (!this.connected && Date.now() - t0 < timeoutMs) await new Promise(r => setTimeout(r, 50));
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
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(`waitFor timeout after ${timeoutMs}ms: ${label} (last 200 chars: ${JSON.stringify(this.buf.slice(-200))})`);
  }

  // Wait for a fresh prompt to appear AT THE TAIL of the buffer.
  // Any "$ " prompt counts. We wait for trailing-end stability.
  async waitForPrompt(timeoutMs = 5000) {
    return this.waitFor((b) => /\$ ?$|# ?$|> ?$/.test(strip(b).trimEnd().slice(-3)), timeoutMs, 'prompt');
  }

  // Read the cwd portion of the most recent prompt. Nimbus prompts look like
  //   user@nimbus:~/app$
  // Strip ANSI codes first.
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

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export { strip, BASE, WS_BASE };
