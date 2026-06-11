#!/usr/bin/env bun
// agentic-cli/new/opencode-tree-sitter-bash-parse — opencode's tree-sitter
// wasm path works inside the Nimbus ESM facet. The runner pre-registers the
// staged core + bash + powershell grammar wasm as pre-compiled
// WebAssembly.Modules (Worker Loader module map; request-time
// WebAssembly.compile is blocked in facets), and the Nimbus-patched
// web-tree-sitter inside the bundle instantiates them via
// `globalThis.__nimbusTreeSitterModules`.
//
// `opencode __nimbus-tree-sitter-diag '<command>'` is the runner's model-free
// diagnostic: it drives the bundle's OWN web-tree-sitter exports (the exact
// module instance the bash tool's parser lazy-init uses) through Parser.init
// (core wasm), Language.load (bash + powershell grammars), and a real bash
// parse, then prints a JSON AST summary.
//
// Proven here: core + grammar wasm load from the module map registry (no
// request-time compile), and a bash parse produces a sane AST in-facet.
// Model-auth-gated (NOT proven here): a full bash-tool round trip where a
// real model issues the tool call that reaches ShellTool.execute.

import {
  deleteSession,
  makeAsserter,
  mintSession,
  stripAnsi,
  Terminal,
} from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('agentic-cli/new/opencode-tree-sitter-bash-parse');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(30_000);

  const install = await t.run('npm install -g opencode-ai', 240_000);
  const installOut = stripAnsi(install.output);
  a.check('opencode-ai installs the staged Nimbus bundle',
    /linked 1 bin into|added 1 packages/.test(installOut),
    JSON.stringify(installOut.slice(-400)));

  const diag = await t.run(
    "opencode __nimbus-tree-sitter-diag 'echo hello | wc -l'; echo EXIT=$?",
    180_000,
  );
  const diagOut = stripAnsi(diag.output);

  a.check('tree-sitter diag produces no blocked-compile / registry / facet error',
    !/Disallowed operation|CompileError|not pre-registered|missing the Nimbus|Aborted\(/.test(diagOut),
    JSON.stringify(diagOut.slice(-900)));

  const jsonLine = diagOut
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('{') && line.includes('"rootType"'));
  let result = null;
  try { result = jsonLine ? JSON.parse(jsonLine) : null; } catch { /* asserted below */ }

  a.check('diag emits a parseable JSON AST summary and exits 0',
    result !== null && /EXIT=0/.test(diagOut),
    JSON.stringify(diagOut.slice(-900)));

  if (result) {
    a.check('bash grammar parses `echo hello | wc -l` into a sane AST',
      result.ok === true
        && result.rootType === 'program'
        && result.childCount >= 1
        && /\(pipeline \(command/.test(result.sexpr),
      JSON.stringify(result));
    a.check('powershell grammar (the bash tool loads both) also loads from the registry',
      result.powershellLoaded === true,
      JSON.stringify(result));
  }
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
