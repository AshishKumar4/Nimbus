#!/usr/bin/env bun
// cli-scaffold — `create-nimbus-app` writes the wrangler config that
// @nimbus-sh/config builds for the template's choices (the public directory
// and the session Agent's vars), so a scaffolded project deploys with every
// setting an embedder built from the config package gets.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWranglerJsonc } from '../../packages/worker/src/wrangler/wrangler-config.ts';
import { scaffold } from '../../packages/cli/src/commands/scaffold.ts';
import { buildNimbusWranglerConfig } from '../../packages/config/src/index.ts';

const root = mkdtempSync(join(tmpdir(), 'cli-scaffold-'));
const oldStdoutWrite = process.stdout.write;
const oldStderrWrite = process.stderr.write;
try {
  const target = join(root, 'my-app');
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  let code;
  try {
    code = await scaffold([target, '--name', 'my-worker']);
  } finally {
    process.stdout.write = oldStdoutWrite;
    process.stderr.write = oldStderrWrite;
  }
  assert.equal(code, 0);

  const config = parseWranglerJsonc(readFileSync(join(target, 'wrangler.jsonc'), 'utf8'));
  assert.deepEqual(config, buildNimbusWranglerConfig({
    name: 'my-worker',
    nimbusPublicDirectory: true,
    agent: { model: '@cf/moonshotai/kimi-k2.6', gatewayId: 'default' },
  }));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('cli-scaffold: ok');
