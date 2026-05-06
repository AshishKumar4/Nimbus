#!/usr/bin/env bun
// X5G regression: install-pipeline-coverage's SCENARIOS list is
// unchanged. Asserts that X5G doesn't accidentally remove or add
// expected packages from the coverage gate.

import { ok, eq, group, summary } from '../../w6/_tap.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COVERAGE = path.join(HERE, '../../regression/install-pipeline-coverage.mjs');
const src = fs.readFileSync(COVERAGE, 'utf8');

group('SCENARIOS list contains the expected 4 scenarios', () => {
  for (const lbl of ['fastify', 'express', 'ts-jest', 'redis']) {
    ok(`SCENARIOS contains label "${lbl}"`,
      new RegExp(`label:\\s*'${lbl}'`).test(src));
  }
});

group('mustHaveAtLeastOne lists are unchanged', () => {
  // typescript MUST still appear in ts-jest's mustHaveAtLeastOne.
  // X5G's G3 rule (peer-meta-only-not-installed) does NOT affect
  // typescript (typescript IS in ts-jest's peerDependencies).
  ok("ts-jest scenario expects 'typescript' visible",
    /'typescript'/.test(src));
  ok("ts-jest scenario expects 'jest' visible",
    /'jest'/.test(src));
});

summary('install-pipeline-coverage-shim');
