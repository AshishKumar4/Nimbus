#!/usr/bin/env bun
// Exercise the real Bun compiler define: the catalog is emitted once, not
// twice through the unresolved typeof guard, while server lookup still works.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nimbusFoldModelsCatalogGuard } from '../../packages/worker/scripts/opencode/bundle-patches.ts';
const marker = 'NIMBUS_UNIQUE_MODELS_CATALOG';
const catalog = { provider: { name: marker, models: {} } };
const input = 'declare const OPENCODE_MODELS_DEV: unknown; export const snapshot = () => typeof OPENCODE_MODELS_DEV === "undefined" ? undefined : OPENCODE_MODELS_DEV;';
const scratch = mkdtempSync(join(tmpdir(), 'opencode-models-'));
try {
  const build = async source => {
    const path = join(scratch, 'entry.ts');
    writeFileSync(path, source);
    const built = await Bun.build({ entrypoints: [path], target: 'node', format: 'esm', minify: true, write: false, define: { OPENCODE_MODELS_DEV: JSON.stringify(catalog) } });
    assert.equal(built.success, true, JSON.stringify(built.logs));
    return built.outputs[0].text();
  };
  const before = await build(input);
  const after = await build(await nimbusFoldModelsCatalogGuard(input, 'models-dev.ts'));
  assert.equal(after.split(marker).length - 1, 1, 'the configured snapshot is emitted once');
  const loaded = await import('data:text/javascript;base64,' + Buffer.from(after).toString('base64'));
  assert.deepEqual(loaded.snapshot(), catalog, 'server lookup still receives the complete configured snapshot');
  console.log(`catalog copies before=${before.split(marker).length - 1} after=1`);
  await assert.rejects(nimbusFoldModelsCatalogGuard('export const snapshot = 1;', 'models-dev.ts'), /expected one/);
} finally { rmSync(scratch, { recursive: true, force: true }); }
