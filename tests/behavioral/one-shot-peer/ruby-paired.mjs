#!/usr/bin/env bun
// Experiment (not for landing): warm ruby one-shots back to back, as
// perf-regression/ruby-gem-require runs them (7 a round), with the session
// pinned to run them itself, and on its warm peer, in one session, 8 rounds,
// order alternating. Per call: the client's wall, the session's facet-call
// time, and on the peer its pool's build and submit times and the session's
// round trip.
import { mintSession, deleteSession, Terminal, BASE, requestHeaders } from '../_driver.mjs';
import { peer, warmFor } from './_peer.mjs';

const out = (record) => console.log(JSON.stringify(record));
const LINE = `ruby -e "require 'json'; require 'set'; require 'time'; require 'fileutils'; require 'optparse'; puts 1"`;
const sid = await mintSession();
const t = new Terminal(sid);
const facetCalls = async () => {
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/session`, { headers: requestHeaders({}, sid) });
  return (await r.json()).launch?.facetCalls ?? [];
};
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  const setup = await t.run('nimbus install ruby', 600_000);
  if (setup.exitCode !== 0) throw new Error(`setup failed: ${setup.output.slice(-300)}`);
  await peer(sid, 'pin');
  await t.run(LINE, 600_000);
  await t.run(LINE, 600_000);
  await peer(sid, 'unpin');
  await t.run(LINE, 600_000);
  await warmFor(sid, 'ruby-runner');
  for (let i = 1; i <= 8; i++) {
    for (const host of i % 2 ? ['session', 'peer'] : ['peer', 'session']) {
      await peer(sid, host === 'session' ? 'pin' : 'unpin');
      if (host === 'peer') await warmFor(sid, 'ruby-runner');
      const walls = [];
      for (let k = 0; k < 7; k++) {
        const started = Date.now();
        const r = await t.run(LINE, 600_000);
        walls.push({ wall: Date.now() - started, exit: r.exitCode });
      }
      const calls = (await facetCalls()).filter((c) => c.tag.startsWith('ruby')).slice(-7).map((c) => ({ callMs: c.callMs, cold: c.cold }));
      const peerSide = host === 'peer' ? await peer(sid, 'facet-calls') : null;
      out({ round: i, host, walls, calls, spans: peerSide?.spans.slice(-7) ?? null, sent: peerSide?.sent.slice(-7) ?? null });
    }
  }
} catch (error) {
  out({ kind: 'error', error: String(error?.stack ?? error).slice(0, 2000) });
  process.exitCode = 1;
} finally {
  await peer(sid, 'unpin').catch(() => {});
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
