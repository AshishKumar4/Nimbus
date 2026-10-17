#!/usr/bin/env bun
// perf-regression/module-load — a node program's module loading and
// node:path, against the baseline.
//
// User flow timed: `node main.js` in a session, over a tree it was given
// (untimed): 24 packages under node_modules of 16 modules each, every
// module requiring its sibling by a relative path and naming itself with
// path.join/basename, then 20,000 rounds of path.resolve, dirname,
// relative, normalize and extname. From the command to its last line.
//
// Graded paired (_paired.mjs): each round runs the flow on the baseline's
// two Previews and the candidate's, at once.
//
// Realistic causes of a fail here:
//   - node:path's posix half slower (it is the guest's own, on captured
//     built-ins, core _shared/posix-path.ts).
//   - require()'s resolution, or the module loader's path work, slower.

import { mintSession, Terminal, makeAsserter, deleteSession, stripAnsi } from '../_driver.mjs';
import { assertCandidateRounds, assertPaired, measurePaired, requirePairedTargets } from '../_paired.mjs';

const a = makeAsserter('perf-regression/module-load');
const arms = requirePairedTargets('perf-regression/module-load');
console.log(`perf-regression/module-load — baseline ${arms.a1.base}, ${arms.a2.base}; candidate ${arms.b1.base}, ${arms.b2.base}`);

const ROUNDS = 40;
const PACKAGES = 24;
const MODULES = 16;

// The tree, written by node itself (setup.js).
const SETUP = `const fs = require('fs'), path = require('path');
for (let p = 0; p < ${PACKAGES}; p++) {
  const dir = path.join('node_modules', 'pkg' + p, 'lib', 'deep');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join('node_modules', 'pkg' + p, 'package.json'), JSON.stringify({ name: 'pkg' + p, main: 'lib/deep/m0.js' }));
  for (let m = 0; m < ${MODULES}; m++) {
    const next = m + 1 < ${MODULES} ? "require('./m" + (m + 1) + ".js')" : '0';
    fs.writeFileSync(path.join(dir, 'm' + m + '.js'), "const path = require('path');\\nmodule.exports = path.join(__dirname, path.basename(__filename, '.js')).length + " + next + ";\\n");
  }
}
// Each package named literally, so the launch stages the whole tree.
let requires = '';
for (let p = 0; p < ${PACKAGES}; p++) requires += "total += require('pkg" + p + "');\\n";
fs.writeFileSync('main.js', "const path = require('path');\\nlet total = 0;\\n" + requires + "let work = 0;\\nfor (let i = 0; i < 20000; i++) {\\n  const f = path.resolve('a/b/' + (i % 97), '../c/./d.' + (i % 7) + '.js');\\n  work += path.dirname(f).length + path.relative('/home/user/x', f).length + path.normalize(f + '/..//e').length + path.extname(f).length;\\n}\\nconsole.log('module-load done', total > 0, work > 0);\\n");
console.log('module-load ready');`;

const result = await measurePaired(arms, ROUNDS, async (target) => {
  const sid = await mintSession(target);
  const t = new Terminal(sid);
  try {
    await t.connect();
    await t.waitForPrompt(30_000);
    await t.run('mkdir -p ml && cd ml', 30_000);
    await t.writeFile('setup.js', SETUP);
    const made = await t.run('node setup.js', 120_000);
    if (!/module-load ready/.test(made.output)) throw new Error(`${sid}: the tree was not written: ${JSON.stringify(made.output.slice(-400))}`);
    // Once untimed, so the timed run's tree is staged and its process warm, as every arm's is.
    await t.run('node main.js', 120_000);
    const timed = await t.run('node main.js', 120_000);
    if (!/module-load done true true/.test(timed.output)) {
      throw new Error(`${sid}: node main.js did not finish its work: ${JSON.stringify(stripAnsi(timed.output).slice(-400))}`);
    }
    return { 'module load': timed.elapsed };
  } finally {
    await t.close();
    await deleteSession(sid);
  }
});

assertCandidateRounds(a, 'its program loads its modules and does its path work', result);
const graded = assertPaired(a, 'module load', result);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : graded ? 0 : 2);
