// W7 regression/install-pipeline-coverage
//
// W7 is an RPC overhaul. The install-pipeline regression probe must
// remain present and unchanged. We mirror the W5/W8 contract here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, summary, group } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, '..', '..', 'regression', 'install-pipeline-coverage.mjs');

await group('install-pipeline-coverage probe still present', () => {
  ok('file exists', fs.existsSync(PROBE));
  const txt = fs.readFileSync(PROBE, 'utf8');
  ok('mentions fastify scenario', txt.includes("label: 'fastify'"));
  ok('mentions express scenario', txt.includes("label: 'express'"));
  ok('mentions ts-jest scenario', txt.includes("label: 'ts-jest'"));
  ok('mentions redis scenario', txt.includes("label: 'redis'"));
  ok('mustHaveAtLeastOne contract present',
    txt.includes('mustHaveAtLeastOne'));
});

summary('install-pipeline-coverage [W7 regression]');
