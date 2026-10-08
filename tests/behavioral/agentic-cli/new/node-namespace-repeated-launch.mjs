#!/usr/bin/env bun
// Repeated launches after warming a 2MiB CommonJS fixture.
import { mintSession, Terminal, makeAsserter, deleteSession, heredocCommand, termBody } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'agentic-cli/new/node-namespace-repeated-launch';
const a = makeAsserter(label);
const sid = await mintSession();
console.log(`${label} — ${process.env.BASE} SID=${sid}`);
const terminal = new Terminal(sid);
const generator = [
  "const fs = require('fs');",
  "const dir = '/home/user/bench/node_modules/big';",
  'const names = [];',
  'for (let m = 0; m < 100; m++) {',
  "  let s = '';",
  "  for (let j = 0; s.length < 20480; j++) s += 'exports.f' + j + ' = function (a, b) { const c = a * ' + j + ' + b; return c > ' + j + ' ? c - ' + m + ' : c + ' + j + '; };\\n';",
  "  fs.writeFileSync(dir + '/m' + m + '.js', s); names.push('./m' + m + '.js');",
  '}',
  "fs.writeFileSync(dir + '/index.js', names.map((n) => 'require(' + JSON.stringify(n) + ');').join('\\n') + '\\nmodule.exports = ' + names.length + ';');",
  "fs.writeFileSync('/home/user/bench/app.js', \"console.log('big', require('big'));\");",
  "console.log('GENERATED_100');",
].join('\n');

try {
  await terminal.connect(); await terminal.waitForPrompt(60_000);
  await terminal.run('mkdir -p /home/user/bench/node_modules/big', 15_000);
  await terminal.run(heredocCommand('/home/user/bench/gen.js', generator), 15_000);
  const generated = termBody((await terminal.run('cd /home/user/bench && node gen.js; echo SETUP_RC=$?', 120_000)).output);
  a.check('module fixture completes', /GENERATED_100/.test(generated) && /SETUP_RC=0/.test(generated), generated.slice(-800));
  if (!/SETUP_RC=0/.test(generated)) throw new Error('fixture failed before launch loops');
  for (const command of ['node -e 1', 'node app.js']) {
    for (let n = 0; n < 20; n++) {
      const out = termBody((await terminal.run(`cd /home/user/bench && ${command}; echo WARM_RC=$?`, 120_000)).output);
      if (!/WARM_RC=0/.test(out) || /the process was not started/.test(out)) throw new Error(`warm ${command} #${n}: ${out.slice(-1000)}`);
    }
  }
  for (let n = 1; n <= 6; n++) {
    const started = Date.now();
    const out = termBody((await terminal.run('cd /home/user/bench && for i in $(seq 50); do echo NODE_NS_ITER=$i; node -e 1; done; echo NAMESPACE_LOOP_RC=$?', 180_000)).output);
    let iteration = 0;
    for (const line of out.split('\n')) {
      const marker = /NODE_NS_ITER=(\d+)/.exec(line);
      if (marker) iteration = Number(marker[1]);
      if (/the process was not started/.test(line)) console.log(`LOOP${n} ITER${iteration}: ${line}`);
    }
    a.check(`sequential Node loop50 #${n} keeps its namespace`, /NAMESPACE_LOOP_RC=0/.test(out) && !/node:|the process was not started|could not be listed/.test(out), `wall=${Date.now() - started}ms ${out.slice(-1800)}`);
  }
} finally {
  await terminal.close().catch(() => {});
  const cleanup = await deleteSession(sid);
  a.check('session cleanup is confirmed', cleanup.ok, `${cleanup.status}`);
}
const summary = a.summary();
process.exit(summary.fail > 0 ? 1 : 0);
