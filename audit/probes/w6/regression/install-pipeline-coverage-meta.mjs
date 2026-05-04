// W6 regression: the W2.5 install-pipeline-coverage prod probe (Mossaic
// gate) must still exist and parse with all four scenario labels. The
// W6 swap registry only touches a small set of names — none of which
// appear in the fastify/express/ts-jest/redis scenarios — so this gate
// must remain green.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, '..', '..', 'regression', 'install-pipeline-coverage.mjs');

group('install-pipeline-coverage probe still present', () => {
  ok('file exists', fs.existsSync(PROBE));
  const txt = fs.readFileSync(PROBE, 'utf8');
  ok('mentions fastify scenario', txt.includes("label: 'fastify'"));
  ok('mentions express scenario', txt.includes("label: 'express'"));
  ok('mentions ts-jest scenario', txt.includes("label: 'ts-jest'"));
  ok('mentions redis scenario', txt.includes("label: 'redis'"));
  ok('mustHaveAtLeastOne contract present', txt.includes('mustHaveAtLeastOne'));
});

group('Mossaic gate scenarios untouched by W6', () => {
  // Verify none of the four scenarios install a name that W6 swaps or rejects.
  const txt = fs.readFileSync(PROBE, 'utf8');
  // Gate: the install commands in this probe must not reference any swap-source
  // or reject name (other than transitive — we can only check explicit installs).
  // The scenarios install: fastify, express, ts-jest, jest, typescript, redis.
  // None of these are in our W6 registry.
  ok('does NOT install esbuild explicitly', !/npm install\s+esbuild\b/.test(txt));
  ok('does NOT install bcrypt explicitly', !/npm install\s+bcrypt\b/.test(txt));
  ok('does NOT install sharp explicitly', !/npm install\s+sharp\b/.test(txt));
  ok('does NOT install prisma explicitly', !/npm install\s+prisma\b/.test(txt));
});

summary('w6/regression/install-pipeline-coverage-meta');
