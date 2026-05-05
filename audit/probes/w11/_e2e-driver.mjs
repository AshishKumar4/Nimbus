// W11 e2e shared driver. Materializes a fixture into /home/user/app on a
// prod session, runs `npm install` then `npm run dev`, waits for a banner
// regex on stdout (with stderr-fail-fast on `Error:`), then GETs the
// preview URL and matches a marker regex.
//
// Gate: NIMBUS_W11_E2E=1. Default-skip mirrors W5/W9.

import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(HERE, '_fixtures');

const BASE = process.env.NIMBUS_W11_BASE || process.env.BASE || 'https://nimbus.ashishkmr472.workers.dev';
export const E2E_ENABLED = process.env.NIMBUS_W11_E2E === '1';

function strip(s) {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[\(\)][AB012]/g, '');
}

export async function newSession() {
  const r = await fetch(BASE + '/new', { method: 'POST', redirect: 'manual' });
  const loc = r.headers.get('location') || '';
  const m = loc.match(/\/s\/([^\/]+)/);
  if (!m) throw new Error('no session in redirect: ' + loc);
  return m[1];
}

export async function openWs(sid) {
  const w = new WebSocket(BASE.replace(/^http/, 'ws') + '/s/' + sid + '/ws');
  let buffer = '';
  let closed = false;
  await new Promise((res, rej) => {
    w.on('open', () => res());
    w.on('error', rej);
  });
  w.on('message', (d) => { buffer += strip(String(d)); });
  w.on('close', () => { closed = true; });
  return {
    ws: w,
    send: (text) => w.send(text),
    snapshot: () => buffer,
    closed: () => closed,
    close: () => { try { w.close(); } catch {} },
  };
}

export async function send(ws, line, settleMs = 200) {
  ws.send(line + '\r');
  await new Promise(r => setTimeout(r, settleMs));
}

export async function waitFor(ws, regex, opts = {}) {
  const { timeoutMs = 30_000, errorRegex = /^.*Error:|UnhandledPromiseRejection|throw new Error/ } = opts;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const snap = ws.snapshot();
    if (regex.test(snap)) return { ok: true, ms: Date.now() - t0, snap };
    if (errorRegex.test(snap)) return { ok: false, ms: Date.now() - t0, snap, reason: 'error-line' };
    if (ws.closed()) return { ok: false, ms: Date.now() - t0, snap, reason: 'ws-closed' };
    await new Promise(r => setTimeout(r, 250));
  }
  return { ok: false, ms: Date.now() - t0, snap: ws.snapshot(), reason: 'timeout' };
}

/**
 * Materialize a fixture into /home/user/app via heredoc commands.
 * Each file is <= 64KB; large fixtures should be uploaded differently.
 */
export async function materializeFixture(ws, fixtureDir, projectDir = '/home/user/app') {
  // Walk the fixture
  const entries = walk(fixtureDir).filter(p => !p.endsWith('PROVENANCE.md'));
  await send(ws, `mkdir -p ${projectDir}`);
  await send(ws, `rm -rf ${projectDir}/*`);
  for (const abs of entries) {
    const rel = path.relative(fixtureDir, abs);
    const dest = path.posix.join(projectDir, rel.replace(/\\/g, '/'));
    const content = fs.readFileSync(abs, 'utf8');
    const dir = path.posix.dirname(dest);
    await send(ws, `mkdir -p ${dir}`);
    // Use heredoc with no-eval marker
    const marker = 'EOF_W11_' + Math.random().toString(36).slice(2, 10);
    ws.send(`cat > ${dest} <<'${marker}'\r\n` + content + `\r\n${marker}\r\n`);
    await new Promise(r => setTimeout(r, 80));
  }
  await send(ws, `cd ${projectDir} && ls -la`, 500);
}

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'PROVENANCE.md') continue;
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

/**
 * GET against the session's preview URL and return { status, body }.
 */
export async function fetchPreview(sid, suffix = '/') {
  const url = BASE + '/s/' + sid + '/preview' + (suffix.startsWith('/') ? suffix : '/' + suffix);
  const r = await fetch(url);
  const body = await r.text();
  return { status: r.status, body, url };
}

export function skipIfDisabled(name) {
  if (!E2E_ENABLED) {
    console.log(`# ${name} skipped (set NIMBUS_W11_E2E=1)`);
    console.log('# 0 passed, 0 failed');
    process.exit(0);
  }
}
