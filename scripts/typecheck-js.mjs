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
// Usage: bun scripts/typecheck-js.mjs   (exit 1 on any error)
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(root, 'tsconfig.scripts.json');
const read = ts.readConfigFile(configPath, ts.sys.readFile);
if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
const config = ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, configPath);
if (config.fileNames.length === 0) throw new Error(`${configPath} includes no files`);

const program = ts.createProgram(config.fileNames, config.options);
const diagnostics = [
  ...config.errors,
  ...program.getOptionsDiagnostics(),
  ...program.getGlobalDiagnostics(),
];
for (const file of config.fileNames) {
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`${file} is not in the program`);
  diagnostics.push(...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source));
}

const host = { getCanonicalFileName: (f) => f, getCurrentDirectory: () => root, getNewLine: () => '\n' };
if (diagnostics.length > 0) {
  const format = process.stderr.isTTY ? ts.formatDiagnosticsWithColorAndContext : ts.formatDiagnostics;
  process.stderr.write(format(diagnostics, host));
  console.error(`typecheck-js: ${diagnostics.length} error(s) in ${config.fileNames.length} files`);
  process.exit(1);
}
console.log(`typecheck-js: ${config.fileNames.length} files, no errors`);
