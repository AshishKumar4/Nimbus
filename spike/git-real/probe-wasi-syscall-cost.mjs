// What one filesystem syscall costs a WASI guest in a Nimbus session, and how
// long today's `git status` takes on a cloned repo: the two numbers a real-git
// runtime would be judged against. Run with BASE and NIMBUS_PROBE_TOKEN set
// (bun tests/behavioral/_throwaway-target.mjs up). REPO overrides the clone.
import { mintSession, deleteSession, Terminal, stripAnsi } from '../../tests/behavioral/_driver.mjs';

const repo = process.env.REPO ?? 'https://github.com/expressjs/express';
const sid = await mintSession();
const t = new Terminal(sid);
const step = async (label, cmd, timeout = 900_000) => {
  const started = Date.now();
  const r = await t.run(cmd, timeout);
  const out = stripAnsi(r.output).replace(/\s+$/, '');
  console.log(JSON.stringify({ label, wallMs: Date.now() - started, out: out.slice(-600) }));
  return out;
};
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  await step('install python', 'nimbus install python 2>&1 | tail -2', 600_000);
  await step('clone', `git clone ${repo} repo 2>&1 | tail -2; echo RC=$?`);
  await step('files', "find repo -type f -not -path 'repo/.git/*' | wc -l");
  const py = (n, body) => `python3 -c "import os,time\nt=time.perf_counter()\nfor _ in range(${n}): ${body}\nd=time.perf_counter()-t\nprint('per_call_us', round(d*1e6/${n},1), 'total_s', round(d,2))"`;
  await step('python warm', py(10, "os.stat('repo/package.json')"));
  await step('stat x2000', py(2000, "os.stat('repo/package.json')"));
  await step('lstat missing x2000', py(2000, "os.path.lexists('repo/nope')"));
  await step('listdir x500', py(500, "os.listdir('repo/lib')"));
  await step('open+read x500', py(500, "open('repo/package.json','rb').read()"));
  for (let i = 1; i <= 3; i++) await step(`git status #${i}`, 'cd repo && time git status | tail -3; cd ..');
  await step('git log -n 50', 'cd repo && time git log -n 50 --oneline | wc -l; cd ..');
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
