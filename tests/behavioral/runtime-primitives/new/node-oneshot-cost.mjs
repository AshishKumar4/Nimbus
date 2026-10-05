// node one-shots, timed by the client, enough times to see past the shell's
// prompt polling: what a change to the resident store must leave as it was.
import { mintSession, deleteSession, Terminal } from '../../_driver.mjs';

const REPS = Number(process.env.REPS ?? 12);
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
  await t.run("mkdir -p tree && for i in $(seq 1 200); do echo $i > tree/f$i; done", 300_000);
  await t.run(`cat > reads.js <<'EOF'
const fs = require('fs');
let n = 0;
for (const f of fs.readdirSync('tree')) n += fs.readFileSync('tree/' + f).length;
console.log(n);
EOF`, 60_000);
  const cases = { 'node -e': "node -e 'console.log(1)'", 'node reads 200 files': 'node reads.js', 'true (shell floor)': 'true' };
  for (const [label, cmd] of Object.entries(cases)) {
    await time(cmd);
    const xs = [];
    for (let i = 0; i < REPS; i++) xs.push(await time(cmd));
    console.log(JSON.stringify({ label, ...stats(xs) }));
  }
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
