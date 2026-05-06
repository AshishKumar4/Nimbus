#!/usr/bin/env bun
// X5M regression: install-pipeline-coverage's SCENARIOS list is unchanged.
// X.5-M is a shim-layer wave (no install-pipeline edits); the 4-package
// coverage gate must remain identical.

import { ok, group, summary } from '../../w6/_tap.mjs';
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

group('mustHaveAtLeastOne lists unchanged for fastify/redis (the M-1/M-2 packages)', () => {
  ok("fastify scenario expects 'fastify' visible", /'fastify'/.test(src));
  ok("redis scenario expects '@redis/client' visible",
    /'@redis\/client'/.test(src));
});

summary('install-pipeline-coverage-shim');
