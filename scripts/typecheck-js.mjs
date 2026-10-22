#!/usr/bin/env bun
// Type-checks the repo's own JavaScript: the root scripts, every package's
// scripts and the unit-test helpers (tsconfig.scripts.json: checkJs, with
// bun's and node's types). Nothing else type-checks them, so an undefined
// name or a wrong call ships until the line runs.
//
// Only those files are reported. The TypeScript sources they import are
// part of the program (that is how a call into them is checked), but they
// are type-checked by the root tsconfig against the Worker's types; checked
// again here against bun's, they would report the differences between the
// two environments, not errors.
//
// The checker is tsrs, through its API (tsrs/unstable/sync), as the root
// typecheck is tsrs on the command line.
//
// Usage: bun scripts/typecheck-js.mjs   (exit 1 on any error)
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API, formatDiagnostics, formatDiagnosticsWithColorAndContext } from 'tsrs/unstable/sync';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(root, 'tsconfig.scripts.json');
const api = new API({ cwd: root });
try {
  const config = api.parseConfigFile(configPath);
  if (config.fileNames.length === 0) throw new Error(`${configPath} includes no files`);
  const program = api.createProgram(config.fileNames, config.options);
  const diagnostics = [
    ...config.errors,
    ...program.getProgramDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(config.fileNames),
    ...program.getSemanticDiagnostics(config.fileNames),
  ];
  if (diagnostics.length > 0) {
    const format = process.stderr.isTTY ? formatDiagnosticsWithColorAndContext : formatDiagnostics;
    process.stderr.write(format(diagnostics, api));
    console.error(`typecheck-js: ${diagnostics.length} error(s) in ${config.fileNames.length} files`);
    process.exitCode = 1;
  } else {
    console.log(`typecheck-js: ${config.fileNames.length} files, no errors`);
  }
} finally {
  api.close();
}
