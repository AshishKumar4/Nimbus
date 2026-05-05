#!/usr/bin/env bun
// W12 regression: W11's framework-detect.ts still exports detectFramework
// + the precedence-rule constants W11 introduced. Drift detector that
// W12's nimbus-session.ts edits don't accidentally regress framework
// routing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FD = path.resolve(HERE, '..', '..', '..', '..', 'src', 'framework-detect.ts');

await group('framework-detect.ts source-shape unchanged', () => {
  ok('file exists', fs.existsSync(FD));
  const txt = fs.readFileSync(FD, 'utf8');
  ok('exports detectFramework', /export\s+function\s+detectFramework/.test(txt));
});

summary('w12/regression/w11-frameworks-detect-unchanged');
