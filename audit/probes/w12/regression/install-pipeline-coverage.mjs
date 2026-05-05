#!/usr/bin/env bun
// W12 regression: confirm the install-pipeline-coverage probe still
// loadable + scenario list unchanged. Mirrors W11 / W9.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, '..', '..', '..', 'probes', 'regression', 'install-pipeline-coverage.mjs');

await group('install-pipeline-coverage probe still present', () => {
  ok('file exists', fs.existsSync(PROBE));
  const txt = fs.readFileSync(PROBE, 'utf8');
  ok('mentions fastify scenario', txt.includes("label: 'fastify'"));
  ok('mentions express scenario', txt.includes("label: 'express'"));
  ok('mentions ts-jest scenario', txt.includes("label: 'ts-jest'"));
  ok('mentions redis scenario', txt.includes("label: 'redis'"));
  ok('mustHaveAtLeastOne contract present', txt.includes('mustHaveAtLeastOne'));
});

summary('w12/regression/install-pipeline-coverage');
