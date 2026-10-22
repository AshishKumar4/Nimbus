// @serial
// @tier slow — drives a local workerd
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
// And a strict cell's loop that reads a global costs what the same loop
// reading it once into a local does, timed from outside (a guest's clocks
// stand still while it computes). In a `{ cjs }` module 2e7 such reads cost
// 2.9-3.1 s, in an ES module the whole loop 28-54 ms (2026-10-21, verdict
// 20261021T224745-d95ed4dfaace): the least of three runs each may differ by
// at most a third of the `{ cjs }` cost (READ_GAP_MS).
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
  // The loop, as a required strict cell, reading Math each round and once.
  'loop-strict.js': [
    '"use strict";',
    'exports.global = (n) => { let h = 0; for (let i = 0; i < n; i++) h = Math.imul(h ^ i, 16777619); return h; };',
    'exports.local = (n) => { const imul = Math.imul; let h = 0; for (let i = 0; i < n; i++) h = imul(h ^ i, 16777619); return h; };',
  ].join('\n') + '\n',
  'loop.js': 'console.log("LOOP " + require("./loop-strict")[process.argv[2]](2e7));\n',
};
/** A third of what 2e7 global reads cost in a `{ cjs }` module (2.9-3.1 s), and 20x the whole loop's in an ES module. */
const READ_GAP_MS = 1_000;
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
      const walls = { global: [], local: [] };
      for (let i = 0; i < 3; i++) {
        for (const kind of ['global', 'local']) {
          const t0 = performance.now();
          const run = await terminal.run(`cd ${W} && node loop.js ${kind}`);
          walls[kind].push(Math.round(performance.now() - t0));
          assert.equal(run.status, 0, run.stdout);
          assert.match(run.stdout, /^LOOP -?\d+$/m, run.stdout);
        }
      }
      const gap = Math.min(...walls.global) - Math.min(...walls.local);
      assert.ok(gap <= READ_GAP_MS, `a strict cell's global reads cost what reading it once does: ${JSON.stringify(walls)} ms`);
      console.log(`  ok  a strict cell's 2e7 global reads: ${gap} ms over reading it once (${JSON.stringify(walls)})`);
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
