#!/usr/bin/env bun
// W12 regression: W7 writeBatchStream RPC contract still exposed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUP = path.resolve(HERE, '..', '..', '..', '..', 'src', 'supervisor-rpc.ts');

await group('SupervisorRPC still has W7 stream surface', () => {
  ok('source exists', fs.existsSync(SUP));
  const txt = fs.readFileSync(SUP, 'utf8');
  ok('writeBatchStream method declaration present', txt.includes('writeBatchStream'));
});

summary('w12/regression/w7-stream-rpc-still-present');
