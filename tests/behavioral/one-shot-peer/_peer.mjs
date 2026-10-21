// What the one-shot-peer probes share: the session's view of where its
// one-shots ran (/api/_diag/session's launch.oneShots, fabric
// one-shot-peer.ts), the probe app's handle on its peer, and an observer of
// the session's thread.
import { BASE, requestHeaders, sleep } from '../_driver.mjs';

/**
 * `terminal` held as a browser tab holds one: a frame every 5 s while quiet
 * (public/s/index.html's liveness probe, PROBE_AFTER_MS and TICK_MS), which
 * keeps its socket's owner live (shell-socket.ts). A protocol ping, all the
 * driver sends, leaves no trace there. Returns what stops it.
 */
export function holdLive(terminal) {
  const timer = setInterval(() => {
    try { terminal.ws?.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 })); } catch { /* closing */ }
  }, 5_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** The session's placement record: its peer, each worker it is warm for, and where its last one-shots ran. */
export async function placement(sid) {
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/session`, { headers: requestHeaders({}, sid), signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`diag ${r.status}`);
  return (await r.json()).launch?.oneShots ?? null;
}

/** The probe app's handle on the session's peer: `forget` it, `reset` it, or ask whether it `stored` a needle. */
export async function peer(sid, action, needle) {
  const r = await fetch(`${BASE}/api/embedder/${sid}/one-shot-peer`, {
    method: 'POST', headers: requestHeaders({ 'content-type': 'application/json' }, sid),
    body: JSON.stringify(needle === undefined ? { action } : { action, needle }), signal: AbortSignal.timeout(60_000),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`one-shot-peer ${action}: ${r.status} ${JSON.stringify(body)}`);
  return body;
}

/**
 * Until the peer is warm for a worker of `tag`: a cold peer's first call took
 * 2.3-3.5 s (verdict 20261021T134050-9f15a2864f23), so ten times the worst.
 */
export async function warmFor(sid, tag) {
  const until = Date.now() + 35_000;
  for (;;) {
    const record = await placement(sid);
    if (record?.peer && Object.keys(record.warm ?? {}).some((key) => key.startsWith(`${tag}\n`))) return;
    if (Date.now() > until) throw new Error(`the peer was not warm for ${tag} within 35 s; its last failed warming: ${JSON.stringify(record?.warmFailure)}; peer ${record?.peer}`);
    await sleep(250);
  }
}

/** The worker the session's last one-shot ran on, as its placement keys warmth. */
export async function lastWorker(sid) {
  return ((await placement(sid))?.calls ?? []).at(-1)?.worker ?? null;
}

/** Until the peer is warm for `worker` (warmFor's bound). */
export async function warmForWorker(sid, worker) {
  const until = Date.now() + 35_000;
  for (;;) {
    const record = await placement(sid);
    if (record?.peer && Object.hasOwn(record.warm ?? {}, worker)) return;
    if (Date.now() > until) throw new Error(`the peer was not warm for ${JSON.stringify(worker)} within 35 s; its last failed warming: ${JSON.stringify(record?.warmFailure)}; peer ${record?.peer}`);
    await sleep(250);
  }
}

/** When the session's last one-shot began, on its clock: what `hostsSince` counts from. */
export async function mark(sid) {
  return ((await placement(sid))?.calls ?? []).at(-1)?.at ?? 0;
}

/** Where each one-shot the session began after `marked` ran, oldest first. */
export async function hostsSince(sid, marked) {
  return ((await placement(sid))?.calls ?? []).filter((call) => call.at > marked).map((call) => call.host);
}

/** A request to the session, timed: a held thread answers it late. */
export async function diagLatency(sid) {
  const started = Date.now();
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/session`, { headers: requestHeaders({}, sid), signal: AbortSignal.timeout(60_000) });
  await r.arrayBuffer();
  return Date.now() - started;
}

/**
 * `call`, while `observe` repeats beside it every 100 ms; its value, wall,
 * and the observer's worst latency, counted once the observation in flight
 * when the call ended has ended too: that one waited longest.
 */
export async function watched(call, observe) {
  let running = true;
  const samples = [];
  const observer = (async () => {
    while (running) {
      samples.push(await observe());
      await sleep(100);
    }
  })();
  const started = Date.now();
  let value, ms;
  try {
    value = await call();
    ms = Date.now() - started;
  } finally {
    running = false;
    await observer;
  }
  if (samples.length === 0) throw new Error('the session was never observed during the call');
  return { value, ms, worst: Math.max(...samples), samples: samples.length };
}

export const median = (values) => {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)];
};
