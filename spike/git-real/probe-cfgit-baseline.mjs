// Today's `git` (cf-git in the session) on a real clone: wall time per command.
import { mintSession, deleteSession, Terminal, stripAnsi } from '../../tests/behavioral/_driver.mjs';
const repo = process.env.REPO ?? 'https://github.com/microsoft/vscode';
const sid = await mintSession();
const t = new Terminal(sid);
const step = async (label, cmd, timeout = 900_000) => {
  const started = Date.now();
  const r = await t.run(cmd, timeout);
  console.log(JSON.stringify({ label, wallMs: Date.now() - started, out: stripAnsi(r.output).replace(/\s+$/, '').slice(-300) }));
};
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  console.log(JSON.stringify({ sid }));
  await step('clone', `git clone ${repo} repo 2>&1 | tail -1; echo RC=$?`);
  for (let i = 1; i <= 3; i++) await step(`status #${i}`, 'cd repo; git status | tail -2; cd ..');
  await step('log -n 50', 'cd repo; git log -n 50 --oneline | wc -l; cd ..');
  await step('touch 5 + diff --stat', "cd repo; for f in README.md package.json src/main.ts gulpfile.mjs LICENSE.txt; do echo x >> $f; done; git diff --stat | tail -1; cd ..");
  await step('status after edit', 'cd repo; git status | tail -3; cd ..');
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
