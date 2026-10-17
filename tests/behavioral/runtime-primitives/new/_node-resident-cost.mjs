// A resident node process (a listening server, whose store is its facet's
// SQLite), timed by the client: how long it takes to boot and answer, and an
// answer that reads 200 files and their stats synchronously twenty times
// over (4,000 of each, so the store's work outweighs the request's), enough
// times to see past the shell's prompt polling. What a change to the resident
// store must leave as it was.
//
// Category: F (forensic) — a measurement with no verdict, so run-all does not
// discover it (the leading `_`). Run it by hand on each side of a change:
//   BASE=<target> bun tests/behavioral/runtime-primitives/new/_node-resident-cost.mjs
import { mintSession, deleteSession, Terminal } from '../../_driver.mjs';

const REPS = Number(process.env.REPS ?? 12);
const PORT = 8137;
const sid = await mintSession();
const t = new Terminal(sid);
const time = async (cmd) => { const s = Date.now(); await t.run(cmd, 300_000); return Date.now() - s; };
const stats = (xs) => {
  const s = [...xs].sort((x, y) => x - y);
  return { n: s.length, p50: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1], mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length) };
};
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  await t.run('mkdir -p tree && for i in $(seq 1 200); do echo $i > tree/f$i; done', 300_000);
  await t.run(`cat > server.js <<'EOF'
const fs = require('fs');
const http = require('http');
http.createServer((req, res) => {
  let n = 0;
  for (let pass = 0; pass < 20; pass++) {
    for (const f of fs.readdirSync('tree')) n += fs.readFileSync('tree/' + f).length + fs.statSync('tree/' + f).size;
  }
  res.end(String(n));
}).listen(${PORT}, () => console.log('listening'));
EOF`, 60_000);
  const boots = [];
  const answers = [];
  for (let round = 0; round <= REPS; round++) {
    const started = Date.now();
    await t.run('node server.js > server.log 2>&1 &', 60_000);
    await t.run(`until curl -sf localhost:${PORT} > /dev/null; do sleep 0.05; done`, 120_000);
    const booted = Date.now() - started;
    const answered = await time(`for i in $(seq 1 10); do curl -sf localhost:${PORT} > /dev/null; done`);
    await t.run('kill %1; wait', 60_000);
    // The first round warms the session; it is not counted.
    if (round > 0) { boots.push(booted); answers.push(answered); }
  }
  console.log(JSON.stringify({ label: 'resident boot to first answer', ...stats(boots) }));
  console.log(JSON.stringify({ label: 'resident 10 answers of 4000 reads and stats', ...stats(answers) }));
  console.log(JSON.stringify({ label: 'true (shell floor)', ...stats(await (async () => { const xs = []; for (let i = 0; i < REPS; i++) xs.push(await time('true')); return xs; })()) }));
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
