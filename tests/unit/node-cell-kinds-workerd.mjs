// @serial
// @tier quiet-cpu — drives a local workerd and compares two programs' compute
// Node guests on the real registry: a CommonJS cell is an ES module when it
// is strict code that the module goal reads the same (core commonjs-cell.ts
// THE WRAPPER), and a program sees no difference. Each fixture runs in the
// guest and under the host's real node, and prints what it found; the lines
// must match:
//   - a strict cell's `this`, `exports`, `arguments` and `require.main`;
//   - a cycle between a strict cell and a sloppy one, each seeing the other's
//     partial exports;
//   - a strict cell that throws while required: the error, the cache entry it
//     leaves, and a second require that evaluates it again;
//   - require.cache deletion and a re-require;
//   - a stack frame's line and column in a strict cell and in a sloppy one, on
//     its first line and below it, in a required cell and in the entry.
// And a strict cell's loop that reads a global runs as an ES module's does,
// against the same loop in a sloppy cell (a `{ cjs }` module), in the same
// run: each timed from outside (a guest's clocks stand still while it
// computes), less the same launch with no rounds. A `{ cjs }` loop of 2e7
// reads took 54-111 times an ES module's (2895-3108 ms against 28-54 ms,
// 2026-10-21, verdict 20261021T224745-d95ed4dfaace); the sloppy cell must
// take at least SPEEDUP times the strict one's.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const W = '/home/user/cells';
const top = (marker) => `console.log(${JSON.stringify(marker + ' ')} + JSON.stringify(`;
const FILES = {
  'this.js': '"use strict";\n' + top('THIS') + '[this === module.exports, exports === module.exports, typeof require, arguments.length, require.main === module, typeof __filename, typeof __dirname]));\n',
  'cycle-strict.js': '"use strict";\nexports.a = 1;\nconst sloppy = require("./cycle-sloppy");\nexports.sawB = sloppy.b;\nexports.sawPartial = sloppy.sawPartial;\nexports.done = true;\n',
  'cycle-sloppy.js': 'exports.b = 2;\nvar strict = require("./cycle-strict");\nexports.sawPartial = JSON.stringify(strict);\n',
  'cycle.js': top('CYCLE') + 'require("./cycle-strict")));\n',
  'throws.js': '"use strict";\nglobalThis.__evaluated = (globalThis.__evaluated || 0) + 1;\nexports.before = 1;\nthrow new Error("boom");\n',
  'throw.js': [
    'const path = require.resolve("./throws");',
    'let first, second;',
    'try { require("./throws"); } catch (e) { first = e; }',
    'const cached = path in require.cache;',
    'try { require("./throws"); } catch (e) { second = e; }',
    top('THROW') + '[first.message, second.message, first === second, first instanceof Error, cached, globalThis.__evaluated]));',
  ].join('\n') + '\n',
  'counter.js': '"use strict";\nglobalThis.__n = (globalThis.__n || 0) + 1;\nmodule.exports = globalThis.__n;\n',
  'recache.js': [
    'const a = require("./counter");',
    'const again = require("./counter");',
    'delete require.cache[require.resolve("./counter")];',
    'const b = require("./counter");',
    top('RECACHE') + '[a, again, b]));',
  ].join('\n') + '\n',
  // A frame below the first line, and one on it (where the wrapper's head shifts the column).
  'stack-strict.js': '"use strict"; module.exports = [new Error("first").stack.split("\\n")[1].trim()];\nfunction where() {\n  return new Error("x").stack.split("\\n")[1].trim();\n}\nmodule.exports.push(where());\n',
  'stack-sloppy.js': 'module.exports = [new Error("first").stack.split("\\n")[1].trim()];\nfunction where() {\n  return new Error("x").stack.split("\\n")[1].trim();\n}\nmodule.exports.push(where());\n',
  'stack.js': top('STACK') + '[require("./stack-strict"), require("./stack-sloppy")]).replaceAll(__dirname, "<dir>"));\n',
  'entry-strict.js': '"use strict"; const first = new Error("e").stack.split("\\n")[1].trim();\nfunction f() {\n  return new Error("e").stack.split("\\n").slice(1, 3).map((l) => l.trim());\n}\n' + top('ENTRYSTRICT') + '[first, f()]).replaceAll(__dirname, "<dir>"));\n',
  'entry-sloppy.js': 'const first = new Error("e").stack.split("\\n")[1].trim();\nfunction f() {\n  return new Error("e").stack.split("\\n").slice(1, 3).map((l) => l.trim());\n}\n' + top('ENTRYSLOPPY') + '[first, f()]).replaceAll(__dirname, "<dir>"));\n',
  // The loop, reading Math each round, as a required strict cell and as a sloppy one.
  'loop-strict.js': '"use strict";\nmodule.exports = (n) => { let h = 0; for (let i = 0; i < n; i++) h = Math.imul(h ^ i, 16777619); return h; };\n',
  'loop-sloppy.js': 'module.exports = (n) => { var h = 0; for (var i = 0; i < n; i++) h = Math.imul(h ^ i, 16777619); return h; };\n',
  'loop.js': 'console.log("LOOP " + require("./loop-" + process.argv[2])(Number(process.argv[3])));\n',
};
/**
 * The least the sloppy cell's loop may take against the strict one's, net of
 * the launch: a tenth of the least measured (54), rounded down, so a strict cell compiled
 * as `{ cjs }` again (about 1) fails, and noise in the strict loop's tens of
 * milliseconds does not.
 */
const SPEEDUP = 5;
const DIFFERENTIAL = [['this.js', 'THIS'], ['cycle.js', 'CYCLE'], ['throw.js', 'THROW'], ['recache.js', 'RECACHE'], ['stack.js', 'STACK'],
  ['entry-strict.js', 'ENTRYSTRICT'], ['entry-sloppy.js', 'ENTRYSLOPPY']];
const line = (stdout, marker) => new RegExp(`^${marker} .*$`, 'm').exec(stdout)?.[0];

const host = mkdtempSync(join(tmpdir(), 'node-cell-kinds-'));
try {
  for (const [name, text] of Object.entries(FILES)) writeFileSync(join(host, name), text);
  console.log('node-cell-kinds-workerd: starting local workerd');
  const probe = await startLocalProbe();
  try {
    const terminal = await localTerminal(probe, { install: [] });
    try {
      const payload = Buffer.from(JSON.stringify(FILES)).toString('base64');
      const setup = await terminal.run(
        `mkdir -p ${W} && node -e "const f = JSON.parse(Buffer.from('${payload}', 'base64').toString()); for (const [n, t] of Object.entries(f)) require('fs').writeFileSync('${W}/' + n, t); console.log('SETUP')"`,
      );
      assert.match(setup.stdout, /SETUP/, setup.stdout);
      for (const [file, marker] of DIFFERENTIAL) {
        const reference = spawnSync('node', [file], { cwd: host, encoding: 'utf8' });
        assert.equal(reference.status, 0, `host node ${file}: ${reference.stderr}`);
        const guest = await terminal.run(`cd ${W} && node ${file}`);
        assert.equal(guest.status, 0, `${file}: ${guest.stdout}`);
        assert.equal(line(guest.stdout, marker), line(reference.stdout, marker), `${file} answers as node does:\n${guest.stdout}`);
        console.log(`  ok  ${file}: ${line(guest.stdout, marker)}`);
      }
      const ARMS = { none: 'strict 0', strict: 'strict 20000000', sloppy: 'sloppy 20000000' };
      const walls = { none: [], strict: [], sloppy: [] };
      for (let i = 0; i < 3; i++) {
        for (const [arm, args] of Object.entries(ARMS)) {
          const t0 = performance.now();
          const run = await terminal.run(`cd ${W} && node loop.js ${args}`);
          walls[arm].push(Math.round(performance.now() - t0));
          assert.equal(run.status, 0, run.stdout);
          assert.match(run.stdout, /^LOOP -?\d+$/m, run.stdout);
        }
      }
      const least = (arm) => Math.min(...walls[arm]);
      const strict = Math.max(1, least('strict') - least('none'));
      const sloppy = least('sloppy') - least('none');
      assert.ok(sloppy >= SPEEDUP * strict, `a strict cell's loop runs as an ES module's, not a { cjs } one's: ${JSON.stringify(walls)} ms`);
      console.log(`  ok  2e7 global reads: ${strict} ms in a strict cell, ${sloppy} ms in a sloppy one, net of the launch (${JSON.stringify(walls)})`);
    } finally {
      await terminal.close().catch(() => {});
    }
  } finally {
    await probe.stop();
  }
} finally {
  rmSync(host, { recursive: true, force: true });
}
console.log('node-cell-kinds-workerd: a strict cell as an ES module behaves as node\'s cell');
