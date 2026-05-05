#!/usr/bin/env bun
// W12 regression: W9 hibernation auto-response config helper still wired.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HIB = path.resolve(HERE, '..', '..', '..', '..', 'src', 'ws-hibernation-config.ts');
const SESSION = path.resolve(HERE, '..', '..', '..', '..', 'src', 'nimbus-session.ts');

await group('W9 hibernation config still wired', () => {
  ok('ws-hibernation-config.ts exists', fs.existsSync(HIB));
  ok('NimbusSession still imports configureWsHibernation',
     fs.readFileSync(SESSION, 'utf8').includes('configureWsHibernation'));
});

summary('w12/regression/w9-hib-config-still-present');
