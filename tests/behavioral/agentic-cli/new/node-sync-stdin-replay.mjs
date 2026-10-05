#!/usr/bin/env bun
// agentic-cli/new/node-sync-stdin-replay — a synchronous read of stdin waits
// for its input, as under Node, and only a read that runs waits.
//
// WHAT IT PROVES
//   A child an agent CLI spawns with child_process can print READY, have its
//   parent write stdin only then, in delayed pieces, and read all of it with
//   fs.readFileSync(0); a readSync prompt answers each line as it arrives; a
//   child whose code merely contains such a read, with its stdin left open as
//   agent CLIs leave it, runs at once. Each child's output is what host Node
//   prints for the same parent (recorded below). Nimbus waits by stopping the
//   run at the read and running the program again once the input is there
//   (packages/worker/src/runtime/stop-replay.ts), so also: what the child
//   printed before the read is shown once, its random numbers and clock are
//   the same on both sides of the read, a pipe whose writer runs on does not
//   hold a program that never reads it, Ctrl-C while the read waits is 130,
//   and a program that changed something outside itself before the read
//   cannot be run again and says so. A server the SDK starts in the
//   background, whose stdin the caller writes and ends, boots once that
//   input is there.

import { AUTH_TOKEN, BASE, makeAsserter, mintSession, deleteSession, Terminal, writeFileViaShell, stripAnsi, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('agentic-cli/new/node-sync-stdin-replay');
const DIR = '/home/user/sync-stdin';

const CHILDREN = {
  ready: "const fs = require('fs'); console.log('child: READY'); const input = fs.readFileSync(0, 'utf8'); console.log('child: got ' + JSON.stringify(input)); console.log('child: done');",
  prompts: "const fs = require('fs'); const buf = Buffer.alloc(64); function line() { let s = ''; for (;;) { const n = fs.readSync(0, buf, 0, buf.length, null); if (n === 0) return s || null; s += buf.toString('utf8', 0, n); if (s.endsWith('\\n')) return s.slice(0, -1); } } console.log('name?'); const name = line(); console.log('hello ' + name + '; colour?'); const colour = line(); console.log(name + ' likes ' + colour);",
  unused: "const fs = require('fs'); function unused() { return fs.readFileSync(0); } console.log('child: printed');",
  draws: "const fs = require('fs'); const d = () => [Math.random(), new Date().toISOString(), require('crypto').randomUUID()].join(' '); console.log('before ' + d()); console.log('child: READY'); const input = fs.readFileSync(0, 'utf8'); console.log('after ' + d() + ' ' + JSON.stringify(input));",
};
// What host Node prints for the same parent (node v22, 2026-10-03).
const NODE = {
  ready: { code: 0, out: 'child: READY\nchild: got "hello\\nworld\\n"\nchild: done\n' },
  prompts: { code: 0, out: 'name?\nhello ada; colour?\nada likes blue\n' },
  unused: { code: 0, out: 'child: printed\n', prompt: true },
};
const PARENT = `
const { spawn } = require('child_process');
const CHILDREN = ${JSON.stringify(CHILDREN)};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function run(name, drive) {
  return new Promise((resolve) => {
    const c = spawn('node', ['-e', CHILDREN[name]]);
    let out = '';
    const t0 = Date.now();
    const stuck = setTimeout(() => { c.kill(); resolve({ stuck: true, out }); }, 60000);
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    const until = (text) => new Promise((ok) => { const iv = setInterval(() => { if (out.includes(text)) { clearInterval(iv); ok(); } }, 10); });
    drive(c, until).catch(() => {});
    c.on('close', (code) => { clearTimeout(stuck); resolve({ code, out, ms: Date.now() - t0 }); });
  });
}
const cases = {
  ready: async (c, until) => { await until('READY'); for (const s of ['hello\\n', 'world\\n']) { await sleep(300); c.stdin.write(s); } await sleep(300); c.stdin.end(); },
  prompts: async (c, until) => { await until('name?'); await sleep(200); c.stdin.write('ada\\n'); await until('colour?'); await sleep(200); c.stdin.write('blue\\n'); await sleep(200); c.stdin.end(); },
  unused: async () => {},
  draws: async (c, until) => { await until('READY'); await sleep(300); c.stdin.end('in'); },
};
(async () => {
  for (const [name, drive] of Object.entries(cases)) {
    const r = await run(name, drive);
    const shown = r.stuck ? { stuck: true, out: r.out } : { code: r.code, out: r.out };
    if (name === 'unused' && !r.stuck) shown.prompt = r.ms < 20000;
    console.log('CASE ' + name + ' ' + JSON.stringify(shown));
  }
  process.exit(0);
})();
`;
const EFFECT = `
const fs = require('fs');
(async () => {
  await fs.promises.writeFile('${DIR}/effect.txt', 'x');
  console.log('child: READY');
  console.log('child: got ' + fs.readFileSync(0, 'utf8'));
})();
`;

const sid = await mintSession();
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  await t.run(`mkdir -p ${DIR}`, 30_000);
  await writeFileViaShell((cmd) => t.run(cmd, 60_000), `${DIR}/parent.js`, PARENT);
  await writeFileViaShell((cmd) => t.run(cmd, 60_000), `${DIR}/effect.js`, EFFECT);

  const cases = stripAnsi((await t.run(`cd ${DIR} && node parent.js`, 400_000)).output);
  const got = {};
  for (const m of cases.matchAll(/^CASE (\w+) (.*)$/gm)) got[m[1]] = JSON.parse(m[2].replace(/\r$/, ''));
  for (const name of ['ready', 'prompts', 'unused']) {
    a.check(`${name}: as under node`, JSON.stringify(got[name]) === JSON.stringify(NODE[name]),
      `node ${JSON.stringify(NODE[name])}\n  nimbus ${JSON.stringify(got[name])}`);
  }
  const lines = (got.draws?.out ?? '').trim().split('\n');
  const before = lines.filter((l) => l.startsWith('before ')), after = lines.filter((l) => l.startsWith('after '));
  a.check('draws: what the child printed before the read is shown once, and its draws after it are new',
    got.draws?.code === 0 && before.length === 1 && after.length === 1
      && before[0].split(' ')[1] !== after[0].split(' ')[1] && before[0].split(' ')[3] !== after[0].split(' ')[3]
      && after[0].endsWith(' "in"'),
    JSON.stringify(got.draws));

  const effect = stripAnsi((await t.run(`cd ${DIR} && (sleep 2; echo late) | node effect.js`, 120_000)).output);
  a.check('a program that changed something before the read says so',
    /ERR_NIMBUS_SYNC_STDIN/.test(effect) && /writeFile/.test(effect) && !/child: got/.test(effect), effect.slice(-600));

  t.reset();
  const t0 = Date.now();
  t.cmd(`sleep 8 | node -e "function u(){require('fs').readFileSync(0)} console.log('print' + 'ed')"`);
  const printedAfter = await t.waitFor((b) => /\nprinted/.test(b), 60_000, 'printed');
  await t.waitForNewPrompt(60_000);
  a.check(`an unused reader in a pipeline prints before its writer ends (${printedAfter} ms, writer 8000 ms)`, printedAfter < 5_000, `${Date.now() - t0} ms`);

  t.reset();
  t.cmd(`sleep 60 | node -e "console.log('wait' + 'ing'); require('fs').readFileSync(0)"`);
  await t.waitFor((b) => /\nwaiting/.test(b), 60_000, 'waiting');
  await sleep(1000);
  const c0 = Date.now();
  t.send('\x03');
  await t.waitForNewPrompt(30_000);
  const interrupted = Date.now() - c0;
  const status = /S=(\d+)/.exec(stripAnsi((await t.run('echo "S=$?"', 30_000)).output))?.[1];
  a.check(`Ctrl-C while the read waits: status ${status} after ${interrupted} ms`, status === '130' && interrupted < 10_000, '');
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}

// A resident the SDK starts: its boot reads its config from stdin.
const { Nimbus } = await import('../../../../packages/sdk/src/index.ts');
const box = Nimbus.connect({ endpoint: BASE, ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}) }).sandbox(`sync-stdin-${Date.now()}`);
try {
  await box.files.mkdir('/home/user/rs');
  await box.files.write('/home/user/rs/srv.js', [
    "const fs = require('fs');",
    "console.log('RS before ' + Math.random());",
    "const cfg = fs.readFileSync(0, 'utf8');",
    "require('http').createServer((q, s) => s.end('RS ' + cfg)).listen(8960, () => console.log('RS listening'));",
  ].join('\n'));
  const job = await box.startProcess('node srv.js', { cwd: '/home/user/rs' });
  const until = async (what, read, ms = 60_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(250);
    }
  };
  await until('RS before in its log', async () => /RS before/.test((await box.processes.logs(job.pid)).text));
  await sleep(1500);
  await box.processes.write(job.pid, 'cfg-1');
  await box.processes.endInput(job.pid);
  await until('the server on 8960', async () => (await box.ports.list()).find((p) => p.port === 8960));
  const answer = await box.exec('curl -s http://localhost:8960/');
  const log = (await box.processes.logs(job.pid)).text;
  a.check('an SDK resident boots once its stdin is written and ended, printing its first line once',
    answer.stdout.trim() === 'RS cfg-1' && (log.match(/RS before/g) || []).length === 1 && /RS listening/.test(log),
    `answered ${JSON.stringify(answer.stdout)}, log ${JSON.stringify(log)}`);
  await box.processes.kill(job.pid).catch(() => {});
} finally {
  await box.destroy().catch(() => {});
}
const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
