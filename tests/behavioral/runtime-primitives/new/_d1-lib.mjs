// Experiment (D1 measurement, not for landing): what the d1 probes share.
import { sleep, requestHeaders, BASE } from '../../_driver.mjs';

export const out = (record) => console.log(JSON.stringify(record));
export const heredoc = (path, body) => `cat > ${path} <<'NIMBUS_EOF'\n${body}NIMBUS_EOF`;
export const PY_IMPORTS = 'import email.parser, http.client, json, decimal, asyncio, unittest, xml.dom.minidom, sqlite3, argparse, logging; print(1)';
export const RB_REQUIRES = "require 'json'; require 'set'; require 'time'; require 'fileutils'; require 'optparse'; puts 1";

export async function diag(sid) {
  const started = Date.now();
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/session`, { headers: requestHeaders({}, sid), signal: AbortSignal.timeout(60_000) });
  if (r.ok) await r.arrayBuffer();
  return Date.now() - started;
}

async function embedder(sid, route, body) {
  const r = await fetch(`${BASE}/api/embedder/${sid}/${route}`, {
    method: 'POST', headers: requestHeaders({ 'content-type': 'application/json' }, sid), body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${route} ${JSON.stringify(body)}: ${r.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** Where the session's python, ruby, clang, git and tsc one-shots run: on the peer named `peer`, or in the session (null). */
export const setHost = (sid, peer, stats = false) => embedder(sid, 'd1-host', { peer, stats });
export const burn = (sid, via, n) => embedder(sid, 'd1-burn', { via, n });

/**
 * Runs `call` while `observe` repeats beside it (by default, a request to the
 * session every 100 ms); the observer's latencies say how long the session's
 * thread was held.
 */
export async function watched(sid, call, observe = () => diag(sid)) {
  let running = true;
  const samples = [];
  const observer = (async () => {
    while (running) {
      samples.push(await observe().catch(() => -1));
      await sleep(100);
    }
  })();
  const startedAt = Date.now();
  try {
    const value = await call();
    return { value, startedAt, ms: Date.now() - startedAt, samples };
  } finally {
    running = false;
    await observer;
  }
}

export function sampleStats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { samples: samples.length, maxMs: sorted.at(-1) ?? 0, medianMs: sorted[Math.floor(sorted.length / 2)] ?? null };
}
