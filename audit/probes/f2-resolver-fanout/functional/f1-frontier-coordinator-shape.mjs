#!/usr/bin/env bun
// F-2 functional probe — frontier coordinator structural shape.
//
// Asserts that the supervisor exposes a `resolveTreeViaFanout` entry
// point that wraps NimbusFanoutPool and runs the BFS as a sequence of
// `submitMany` calls (one per layer). The probe doesn't run install —
// it inspects the source for the expected call shape.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const installer = fs.readFileSync(path.join(ROOT, 'src/npm/installer.ts'), 'utf8');

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); fail++; }
};

console.log('F-2 functional/f1-frontier-coordinator-shape — installer.ts has frontier coordinator');

// 1. Method exists.
check(
  'private async resolveTreeViaFanout(',
  /private\s+async\s+resolveTreeViaFanout\s*\(/.test(installer),
  'expected new method resolveTreeViaFanout in installer.ts',
);

// 2. Calls submitMany on a NimbusFanoutPool inside a while-loop body
//    (the frontier loop). We assert the textual shape: a `while` whose
//    body contains `submitMany` AND the file has a `new NimbusFanoutPool(`
//    construction inside resolveTreeViaFanout's body.
//
//    Regex anchored at the method body; we scan from the method start
//    to its closing brace at column 0 (private methods in this style
//    end at `^  }$`).
const methodMatch = installer.match(/private\s+async\s+resolveTreeViaFanout\s*\([\s\S]*?\n  \}/);
const body = methodMatch ? methodMatch[0] : '';
check('method body captured', body.length > 0);
check(
  'method constructs NimbusFanoutPool',
  /new\s+NimbusFanoutPool\s*\(/.test(body),
);
check(
  'method has frontier while-loop',
  /while\s*\(/.test(body),
);
check(
  'frontier loop calls submitMany',
  /submitMany\s*</.test(body) || /submitMany\s*\(/.test(body),
);

// 3. installer.ts's main install path now dispatches to
//    resolveTreeViaFanout (NOT resolveTreeViaFacet).
check(
  'install() dispatches to resolveTreeViaFanout',
  /this\.resolveTreeViaFanout\s*\(/.test(installer),
);

// 4. The NimbusFanoutPool import already lives in installer.ts
//    (asserted by F-1 too; included here as a regression).
check(
  'NimbusFanoutPool import present',
  /import\s+\{[^}]*NimbusFanoutPool[^}]*\}\s+from\s+['"][.\/]+loaders\/fanout-pool/.test(installer),
);

console.log(`\n  ──── ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
