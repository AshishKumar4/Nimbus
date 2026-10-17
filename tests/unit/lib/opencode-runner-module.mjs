// The generated opencode runner, evaluated as its facet evaluates it: the
// module set assembleOpencodeFacetConfig hands the loader, written out and
// imported, with the test's own program as the opencode bundle the runner
// imports (`OPENCODE_BUNDLE_MODULE_NAME`, whose `nimbusMain()` it runs). The
// sql.js, OpenTUI and yoga images are the real compiled Modules, as the map
// carries them; the tree-sitter grammars, which nothing here instantiates,
// are stand-ins.
//
// ONE RUNNER PER PROCESS. A resident runner makes the shim process the
// global one, and the shims wrap the realm's timers, console and WebAssembly.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLOUDFLARE_WORKERS_URL } from './cloudflare-workers.mjs';

import {
  generateOpencodeRunnerCode, OPENCODE_BUNDLE_MODULE_NAME, SQLITE_WASM_MODULE_NAME, YOGA_WASM_MODULE_NAME,
} from '../../../packages/worker/src/runtime/opencode-facet-runner.ts';
import { OPENTUI_WASM_MODULE_NAME } from '../../../packages/worker/src/runtime/opentui-facet-backend.ts';
import {
  OPENCODE_ARTIFACT_ENTRY, OPENCODE_TREE_SITTER_WASMS, OPENCODE_YOGA_WASM,
} from '../../../packages/worker/src/opencode-artifact.generated.ts';
import { OPENTUI_WASM_ENTRY } from '../../../packages/worker/src/opentui-wasm-artifact.generated.ts';
import { SQLITE_WASM_ASSET_PATH } from '../../../packages/worker/src/runtime/sqlite-wasm-bytes.ts';
import { generateShimsCode } from '../../../packages/worker/src/runtime/node-shims.ts';
import { nodeFacetSources } from './node-facet-sources.mjs';
import { generatedModuleSet, writeModuleSet } from './module-map-bundle.mjs';
import { CRED } from './resident-body.mjs';

/** A module evaluating to the compiled image at `asset` under packages/worker/public. */
function compiledImage(asset) {
  const url = new URL(`../../../packages/worker/public/${asset.replace(/^\/+/, '')}`, import.meta.url);
  return `import { readFileSync } from "node:fs";\nexport default new WebAssembly.Module(readFileSync(new URL(${JSON.stringify(url.href)})));\n`;
}

/**
 * Import the runner of `mode` whose opencode bundle is `program` (ES module
 * text exporting `nimbusMain`), over the snapshot `vfsBundle` read at
 * `vfsCursor` (both as the stage spec carries them), with `members` beside
 * it in the map. The module's directory is removed when the process exits;
 * `dir` names it.
 */
export async function importOpencodeRunner({
  mode, program, argv = [], env = {}, cwd = '/home/user', vfsBundle = '{}', vfsCursor = 'null', members = {},
}) {
  const generated = generateOpencodeRunnerCode({
    argv, env, cred: CRED, cwd, stdin: '', mode, sources: nodeFacetSources(generateShimsCode()), vfsBundle, vfsCursor,
  });
  const modules = generatedModuleSet({ esModules: {}, ...generated }, 'runner.mjs');
  // A bare specifier is a map member to the loader; to a file import it is
  // the module beside the runner.
  const member = (specifier, name, source) => {
    const from = `from "${specifier}"`;
    if (!modules['runner.mjs'].includes(from)) throw new Error(`the ${mode} runner no longer imports ${specifier}`);
    modules['runner.mjs'] = modules['runner.mjs'].replaceAll(from, `from "${name}"`);
    modules[name] = source;
  };
  member('cloudflare:workers', 'test-cloudflare-workers.mjs', readFileSync(new URL(CLOUDFLARE_WORKERS_URL), 'utf8'));
  member(SQLITE_WASM_MODULE_NAME, 'test-sqlite-wasm.mjs', compiledImage(SQLITE_WASM_ASSET_PATH));
  for (const [key, wasm] of Object.entries(OPENCODE_TREE_SITTER_WASMS)) member(wasm, `test-tree-sitter-${key}.mjs`, 'export default {};\n');
  if (mode === 'attached') {
    member(OPENTUI_WASM_MODULE_NAME, 'test-opentui-wasm.mjs', compiledImage(OPENTUI_WASM_ENTRY));
    member(YOGA_WASM_MODULE_NAME, 'test-yoga-wasm.mjs', compiledImage(OPENCODE_ARTIFACT_ENTRY.replace(/[^/]+$/, OPENCODE_YOGA_WASM)));
  }
  const bundleImport = `import("${OPENCODE_BUNDLE_MODULE_NAME}")`;
  if (!modules['runner.mjs'].includes(bundleImport)) throw new Error(`the ${mode} runner no longer imports its bundle`);
  modules['runner.mjs'] = modules['runner.mjs'].replaceAll(bundleImport, `import("./${OPENCODE_BUNDLE_MODULE_NAME}")`);
  modules[OPENCODE_BUNDLE_MODULE_NAME] = program;
  Object.assign(modules, members);
  const dir = mkdtempSync(join(tmpdir(), `opencode-runner-${mode}-`));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return { runner: await import(pathToFileURL(writeModuleSet(dir, modules, 'runner.mjs')).href), dir };
}
