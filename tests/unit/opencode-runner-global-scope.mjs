#!/usr/bin/env bun
// The staged opencode runner's module top level evaluates in workerd's
// "global scope", where async I/O (fetch/connect), timers, and random-value
// generation are disallowed. Every splice that lands there (VFS write ledger,
// shims, polyfills) must be side-effect free at module init — the offending
// call only belongs inside a handler. This test evaluates the REAL generated
// server-mode module under traps that mirror workerd's global-scope
// restrictions, so any future top-level fetch/setTimeout/RNG regression fails
// here instead of killing `opencode` in production
// ("Disallowed operation called within global scope").
//
// Evaluation happens in a child process: the resident runner swaps
// globalThis.process for the shim process at module scope, which must not
// clobber the test runner's own globals.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.NIMBUS_GLOBAL_SCOPE_EVAL_CHILD) {
  const { generateOpencodeRunnerCode, SQLITE_WASM_MODULE_NAME, YOGA_WASM_MODULE_NAME } = await import(
    '../../packages/worker/src/runtime/opencode-facet-runner.ts'
  );
  const { OPENTUI_WASM_MODULE_NAME } = await import(
    '../../packages/worker/src/runtime/opentui-facet-backend.ts'
  );
  const { OPENCODE_TREE_SITTER_WASMS, OPENCODE_YOGA_WASM, OPENCODE_ARTIFACT_ENTRY } = await import(
    '../../packages/worker/src/opencode-artifact.generated.ts'
  );
  const { OPENTUI_WASM_ENTRY } = await import(
    '../../packages/worker/src/opentui-wasm-artifact.generated.ts'
  );
  const { generateShimsCode } = await import(
    '../../packages/worker/src/runtime/node-shims.ts'
  );

  const mode = process.env.NIMBUS_GLOBAL_SCOPE_EVAL_MODE;
  let source = generateOpencodeRunnerCode({
    argv: mode === 'server' ? ['serve', '--port', '4096', '--hostname', '127.0.0.1'] : [],
    env: {},
    cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    cwd: '/home/user',
    stdin: '',
    shimsCode: generateShimsCode(),
    vfsBundle: '{}',
    vfsManifest: '{}',
    vfsMetadata: '{}',
    mode,
  });

  // The module map serves these specifiers in workerd; alias each to a stub
  // file so plain ESM import works here. Fail loud if a specifier vanishes —
  // an unrewritten import means the eval below is no longer the real module.
  const dir = mkdtempSync(join(tmpdir(), 'oc-runner-global-scope-'));
  const alias = (specifier, stubName, stubSource) => {
    const find = `from "${specifier}"`;
    assert.ok(source.includes(find), `generated source imports ${specifier}`);
    source = source.replaceAll(find, `from "./${stubName}"`);
    writeFileSync(join(dir, stubName), stubSource);
  };
  alias(
    'cloudflare:workers',
    'cloudflare-workers.mjs',
    'export class WorkerEntrypoint {}\nexport class DurableObject {}\n',
  );
  alias(SQLITE_WASM_MODULE_NAME, 'sqlite-wasm.mjs', 'export default {};\n');
  for (const [key, wasm] of Object.entries(OPENCODE_TREE_SITTER_WASMS)) {
    alias(wasm, `tree-sitter-${key}.mjs`, 'export default {};\n');
  }
  if (mode === 'attached') {
    // The attach facet links the OpenTUI wasm reactor and yoga, and constructs
    // the backend at module init — so these must be the REAL compiled Modules,
    // not stubs, or the module never reaches the code under test.
    const wasmModule = (assetPath, stubName) => {
      const bytes = readFileSync(new URL(`../../packages/worker/public/${assetPath}`, import.meta.url));
      writeFileSync(join(dir, `${stubName}.wasm`), bytes);
      return `import { readFileSync } from "node:fs";\n`
        + `export default new WebAssembly.Module(readFileSync(new URL("./${stubName}.wasm", import.meta.url)));\n`;
    };
    alias(OPENTUI_WASM_MODULE_NAME, 'opentui-wasm.mjs', wasmModule(OPENTUI_WASM_ENTRY, 'opentui'));
    alias(
      YOGA_WASM_MODULE_NAME,
      'yoga-wasm.mjs',
      wasmModule(OPENCODE_ARTIFACT_ENTRY.replace(/[^/]+$/, OPENCODE_YOGA_WASM), 'yoga'),
    );
  }
  const entry = join(dir, 'runner.mjs');
  writeFileSync(entry, source);

  // The resident runner swaps globalThis.process and console at module eval;
  // report through references saved before the import.
  const realProcess = process;
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  const realStderrWrite = process.stderr.write.bind(process.stderr);

  // workerd's global-scope restrictions, as traps. Anything the module top
  // level calls from this list is exactly the production crash.
  const violations = [];
  const trap = (name) => () => {
    const error = new Error(`Disallowed operation called within global scope: ${name}`);
    violations.push(error);
    throw error;
  };
  globalThis.fetch = trap('fetch()');
  globalThis.setTimeout = trap('setTimeout()');
  globalThis.setInterval = trap('setInterval()');
  Math.random = trap('Math.random()');
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: trap('crypto.randomUUID()') });
  Object.defineProperty(globalThis.crypto, 'getRandomValues', { value: trap('crypto.getRandomValues()') });

  let evalError = null;
  let entrypoint;
  try {
    entrypoint = (await import(entry)).default;
  } catch (error) {
    evalError = error;
  }

  rmSync(dir, { recursive: true, force: true });
  if (violations.length > 0 || evalError) {
    const detail = (violations[0] ?? evalError);
    realStderrWrite(`MODULE-EVAL FAILED: ${detail?.message}\n${detail?.stack}\n`);
    realProcess.exitCode = 1;
  } else if (typeof entrypoint !== 'function') {
    realStderrWrite('MODULE-EVAL FAILED: module did not evaluate to an entrypoint class\n');
    realProcess.exitCode = 1;
  } else {
    realStdoutWrite('MODULE-EVAL CLEAN\n');
  }
} else {
  // Every mode: 'attached' additionally links the OpenTUI reactor, the yoga
  // layout wasm and the in-isolate Worker polyfill; 'oneshot' takes workerd's
  // own process. A violation in any of them is a broken `opencode`.
  for (const mode of ['server', 'attached', 'oneshot']) {
    const child = Bun.spawnSync({
      cmd: [process.execPath, import.meta.path],
      env: {
        ...process.env,
        NIMBUS_GLOBAL_SCOPE_EVAL_CHILD: '1',
        NIMBUS_GLOBAL_SCOPE_EVAL_MODE: mode,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = child.stdout.toString();
    const stderr = child.stderr.toString();
    assert.equal(
      child.exitCode === 0 && stdout.includes('MODULE-EVAL CLEAN'),
      true,
      `the generated opencode ${mode} runner module top level performed a `
        + `workerd-disallowed operation:\n${stdout}\n${stderr}`,
    );
    console.log(`  ✓ ${mode}`);
  }
  console.log('opencode-runner-global-scope: PASS');
}
