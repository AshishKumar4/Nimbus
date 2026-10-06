// @serial
// The Dynamic Worker ledger's refusal through npm scripts, under workerd:
// nine children, each `sh -c 'npm run build'` with build
// 'node parent.cjs && true', each program waiting on a grandchild of its
// own, fill the limit with their parent. npm's script runs on a shell of its
// own under its wrapper's pid, which `npm run` awaits: one grandchild's
// spawn fails EAGAIN and the other eight run. Before, the wrapper's work and
// its caller's await of it went uncounted, and all ten hung. (The rest of
// the ledger's refusals: cp-dynamic-worker-refusal-workerd, -2, -3.)
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';

import { localTerminal, startLocalProbe, splitScenarioOutput } from './lib/workerd-probe.mjs';

const SCENARIOS = {
  npmdeadlock: `
const { spawn } = require('child_process');
const fs = require('fs');
const N = 9;
// As shdeadlock, through npm: each child is sh -c 'npm run build', and build
// is 'node parent.cjs && true', so npm's script runs under a wrapper of its
// own, and the program under that.
fs.mkdirSync('/home/user/npmfam', { recursive: true });
fs.writeFileSync('/home/user/npmfam/package.json', JSON.stringify({ name: 'npmfam', version: '1.0.0', scripts: { build: 'node parent.cjs && true' } }));
fs.writeFileSync('/home/user/npmfam/parent.cjs', [
  "const fs = require('fs');",
  "fs.writeFileSync('/home/user/npmready/' + process.pid, 'ready');",
  "const go = async () => { for (;;) { try { await fs.promises.access('/home/user/npmdeadlock-go'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } };",
  "go().then(() => {",
  "  const g = require('child_process').spawn('node', ['-e', 'console.log(1+1)']);",
  "  let o = '';",
  "  g.stdout.on('data', (d) => { o += d; });",
  "  g.on('error', (e) => { console.log('error ' + e.code); process.exit(0); });",
  "  g.on('close', (code) => { console.log('close ' + code + ' ' + o.trim()); process.exit(0); });",
  "});",
].join('\\n'));
try { fs.unlinkSync('/home/user/npmdeadlock-go'); } catch {}
fs.rmSync('/home/user/npmready', { recursive: true, force: true });
fs.mkdirSync('/home/user/npmready');
const results = [];
for (let i = 0; i < N; i++) {
  const c = spawn('sh', ['-c', 'npm run build'], { cwd: '/home/user/npmfam' });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.on('close', (code) => {
    const said = out.split('\\n').filter((l) => /^(close|error) /.test(l)).join(' | ');
    results.push(said + ' ; ' + code);
    if (results.length === N) console.log(results.sort().join('\\n'));
  });
}
const poll = setInterval(() => {
  if (fs.readdirSync('/home/user/npmready').length < N) return;
  clearInterval(poll);
  fs.writeFileSync('/home/user/npmdeadlock-go', 'go');
}, 100);
`,
};

console.log('cp-dynamic-worker-refusal-4-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    for (const [name, source] of Object.entries(SCENARIOS)) await terminal.writeFile(`/home/user/${name}.js`, source);
    const run = async (name, { args = '' } = {}) => {
      const r = await terminal.run(`node /home/user/${name}.js ${args}`, 180_000);
      assert.equal(r.status, 0, `${name}: ${r.stdout.slice(-800)}`);
      return splitScenarioOutput(r.stdout);
    };

    // Nine children, each stuck through npm's script wrapper: sh -c 'npm run
    // build', build 'node parent.cjs && true' (before, the wrapper ran on the
    // session shell with no work counted and no await of it recorded, and all
    // ten hung).
    const npm = await run('npmdeadlock');
    console.log('  npmdeadlock:\n    ' + npm.lines.join('\n    '));
    assert.deepEqual(npm.lines, ['close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'error EAGAIN ; 0'],
      "through npm run, one grandchild's spawn fails EAGAIN, and the other eight run");
  } finally {
    await terminal.close();
  }
} finally {
  await probe.stop();
}
console.log('ok - cp-dynamic-worker-refusal-4-workerd (nine children stuck through npm scripts: one EAGAIN, eight runs)');
