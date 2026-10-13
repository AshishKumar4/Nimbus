// A recall is a call from the session into a running process's facet and the
// answer back. The nearest existing path: a request the session routes to a
// resident Python server (the session submits the request to its facet, the
// handler answers, the session replies). Timed from the client against a
// request the session answers itself (a port nothing listens on), medians of
// N: the difference is the session -> facet -> session leg plus the handler.
// (In-session timing is not possible: a Worker's clock stands still between
// I/O, so a shell loop of `true` measures 0.)
import { mintSession, deleteSession, Terminal, stripAnsi, fetchPort } from '../../tests/behavioral/_driver.mjs';

const N = Number(process.env.N ?? 40);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const sid = await mintSession();
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  await t.run('nimbus install python 2>&1 | tail -1', 900_000);
  const up = await t.run('mkdir -p www && echo x > www/x && cd www && python3 -m http.server 8077 2>&1 | head -2; cd ~', 300_000);
  console.log(JSON.stringify({ server: stripAnsi(up.output).slice(-200) }));
  for (let round = 1; round <= 2; round++) {
    const session = [];
    const facet = [];
    for (let i = 0; i < N; i++) {
      session.push((await fetchPort(sid, 8099, 'x')).elapsed);
      const r = await fetchPort(sid, 8077, 'x');
      if (r.status !== 200) throw new Error(`port 8077: ${r.status} ${r.body.slice(0, 200)}`);
      facet.push(r.elapsed);
    }
    console.log(JSON.stringify({ round, n: N, sessionOnlyMedianMs: median(session), throughFacetMedianMs: median(facet), facetLegMs: median(facet) - median(session) }));
  }
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
