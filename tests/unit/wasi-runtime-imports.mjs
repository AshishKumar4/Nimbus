#!/usr/bin/env bun
// The git build's verify entrypoint uses core's import contract, without a
// compiler or a rebuild. Refuse unknown namespaces and a build missing the
// filesystem extension; the same verifier serves CPython's two variants.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import wabtInit from 'wabt';
import { WASI_RUNTIME_IMPORT_MODULES } from '../../packages/core/src/runtime/os-contracts.ts';

const root = mkdtempSync(join(tmpdir(), 'wasi-runtime-imports-'));
const wabt = await wabtInit();
const script = new URL('../../packages/worker/wasm/git/build-git.sh', import.meta.url).pathname;
const verify = (name, modules) => {
  const module = wabt.parseWat(name, `(module ${modules.map((ns) => `(import "${ns}" "probe" (func))`).join(' ')})`);
  const file = join(root, `${name}.wasm`);
  writeFileSync(file, module.toBinary({}).buffer);
  module.destroy();
  const env = { ...process.env };
  delete env.WASI_SDK;
  return spawnSync('bash', [script, 'verify', file], { env, encoding: 'utf8' });
};
try {
  for (const namespace of WASI_RUNTIME_IMPORT_MODULES) {
    const result = verify(`allowed-${namespace}`, [...new Set(['nimbus_fs', namespace])]);
    assert.equal(result.status, 0, `${namespace}: ${result.stdout}${result.stderr}`);
  }
  const unknown = verify('unknown', ['nimbus_fs', 'foreign_host']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /foreign_host/);
  const old = verify('old', ['wasi_snapshot_preview1']);
  assert.notEqual(old.status, 0);
  assert.match(old.stderr, /nimbus_fs/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('wasi-runtime-imports: allowed and refused builds match the shared contract');
