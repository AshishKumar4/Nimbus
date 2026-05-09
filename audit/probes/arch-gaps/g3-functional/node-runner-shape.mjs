#!/usr/bin/env bun
// G3 functional — node-runner-shape (TDD RED → GREEN once G4 lands).
//
// Asserts:
//   1. src/runtime/node-runner.ts exports `detectLongRunning(code, args)`
//      and `runNodeScript(facetMgr, opts)`.
//   2. detectLongRunning returns true for known long-running patterns
//      (http.createServer, app.listen, --watch, --inspect, top-level
//      await, Bun.serve, Deno.serve).
//   3. detectLongRunning returns false for short scripts (console.log,
//      arithmetic, simple require).
//   4. src/session/init.ts dispatches `node` through `runNodeScript`,
//      not directly through `facetMgr.exec`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); fail++; }
};

console.log('G3 functional/node-runner-shape — long-running fork-to-loader structural');

const RUNNER_FILE = path.join(ROOT, 'src/runtime/node-runner.ts');
const INIT_FILE = path.join(ROOT, 'src/session/init.ts');

// 1+2+3
if (!fs.existsSync(RUNNER_FILE)) {
  check('src/runtime/node-runner.ts exists', false, 'expected new file');
} else {
  const src = fs.readFileSync(RUNNER_FILE, 'utf8');
  check('node-runner.ts exists', true);
  check('exports detectLongRunning',
    /export\s+(?:function|const)\s+detectLongRunning\b/.test(src));
  check('exports runNodeScript',
    /export\s+(?:async\s+)?(?:function|const)\s+runNodeScript\b/.test(src));

  // Behavioural: import + run detectLongRunning against a small fixture
  // set. We dynamic-import; if the file's not yet present this tier
  // already failed above. Wrap so a structural-only failure doesn't
  // crash the probe.
  try {
    const mod = await import(RUNNER_FILE);
    if (typeof mod.detectLongRunning === 'function') {
      const positives = [
        ['http.createServer((req,res)=>res.end("hi")).listen(3000)', []],
        ["import http from 'http'; http.createServer().listen(3000)", []],
        ['app.listen(3000)', []],
        ['server.listen(3000)', []],
        ['Bun.serve({fetch:r=>new Response("hi")})', []],
        ['Deno.serve(r=>new Response("hi"))', []],
        ['await import("./x.js")', []],
        ['console.log("hi")', ['--watch']],
        ['console.log("hi")', ['--inspect']],
      ];
      const negatives = [
        ['console.log("hi")', []],
        ['for(let i=0;i<3;i++)console.log(i)', []],
        ['const z=require("zod"); console.log(typeof z)', []],
        ['process.exit(0)', []],
      ];
      let posOk = 0, negOk = 0;
      for (const [code, args] of positives) {
        if (mod.detectLongRunning(code, args) === true) posOk++;
      }
      for (const [code, args] of negatives) {
        if (mod.detectLongRunning(code, args) === false) negOk++;
      }
      check(`detectLongRunning matches ${positives.length}/${positives.length} positive cases`,
        posOk === positives.length, `${posOk}/${positives.length}`);
      check(`detectLongRunning rejects ${negatives.length}/${negatives.length} negative cases`,
        negOk === negatives.length, `${negOk}/${negatives.length}`);
    }
  } catch (e) {
    check('detectLongRunning callable', false, String(e?.message ?? e));
  }
}

// 4
if (fs.existsSync(INIT_FILE)) {
  const src = fs.readFileSync(INIT_FILE, 'utf8');
  // Look at the `node` registry handler block, not just the file.
  const nodeBlockMatch = src.match(/registry\.register\s*\(\s*['"]node['"][\s\S]*?\n\s+\}\s*\)\s*;/);
  const block = nodeBlockMatch ? nodeBlockMatch[0] : '';
  check('node handler dispatches via runNodeScript',
    /runNodeScript\s*\(/.test(block),
    'expected `runNodeScript(...)` call inside the node command handler');
  check('node handler imports from runtime/node-runner',
    /from\s+['"][.\/]+runtime\/node-runner/.test(src) ||
    /import\s+\{[^}]*runNodeScript[^}]*\}\s+from/.test(src));
}

console.log(`\n  ──── ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
