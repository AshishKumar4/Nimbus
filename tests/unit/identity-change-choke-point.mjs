#!/usr/bin/env bun
// @tier slow — builds the root tsconfig's program: on armada 1.32 GiB peak, 21.8 s CPU, 9.0 s wall
// The identity policy (identity-change-policy.mjs) is asked in the one place
// a process is made: SessionProcessSupervisor.spawn, before it calls
// ProcessTable.spawn. This holds that by what each reference resolves to (the
// type checker), not its spelling, so an alias (`const t = this.table`, a
// bound `spawn`, `const T = ProcessTable`) is still found: ProcessTable.spawn
// is referred to only there, and the ProcessTable class only as the
// supervisor's own table. A process's cred is readonly outside the table
// (ProcessEntry), so tsc refuses any other write to it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ts = createRequire(import.meta.url)('typescript');
const repo = fileURLToPath(new URL('../../', import.meta.url));
const config = ts.getParsedCommandLineOfConfigFile(join(repo, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
const program = ts.createProgram(config.fileNames, config.options);
const checker = program.getTypeChecker();
const TABLE = join(repo, 'packages/core/src/runtime/process-table.ts');
const SUPERVISOR = join(repo, 'packages/core/src/runtime/session-process-supervisor.ts');

/** The declaration `node` refers to, through import aliases. */
function declarationOf(node) {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}
const spawnDeclaration = (declaration) => declaration !== undefined && ts.isMethodDeclaration(declaration)
  && declaration.getSourceFile().fileName === TABLE && declaration.parent.name?.text === 'ProcessTable' && declaration.name.getText() === 'spawn';
const tableClass = (declaration) => declaration !== undefined && ts.isClassDeclaration(declaration)
  && declaration.getSourceFile().fileName === TABLE && declaration.name?.text === 'ProcessTable';
/** Where `node` is, as `file Class.member` (or the function's name). */
function where(node) {
  let name = '';
  for (let at = node.parent; at && name === ''; at = at.parent) {
    if ((ts.isMethodDeclaration(at) || ts.isPropertyDeclaration(at)) && ts.isClassDeclaration(at.parent)) name = `${at.parent.name?.text}.${at.name.getText()}`;
    else if (ts.isFunctionDeclaration(at)) name = at.name?.text ?? '(function)';
  }
  return `${relative(repo, node.getSourceFile().fileName)} ${name}`;
}

const spawnReferences = [];
const tableValues = [];
for (const file of program.getSourceFiles()) {
  if (file.isDeclarationFile || !file.fileName.startsWith(repo)) continue;
  const visit = (node) => {
    if (ts.isIdentifier(node) && !(node.parent && ts.isMethodDeclaration(node.parent) && node.parent.name === node)) {
      const declaration = declarationOf(node);
      if (spawnDeclaration(declaration)) spawnReferences.push(where(node));
      // The class as a value (made, aliased, passed), not as a type or an import's name.
      if (tableClass(declaration) && node !== declaration.name && !ts.isTypeReferenceNode(node.parent) && !ts.isTypeQueryNode(node.parent)
        && !ts.isImportSpecifier(node.parent) && !ts.isImportClause(node.parent) && !ts.isExportSpecifier(node.parent)) tableValues.push(where(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}
const supervisor = relative(repo, SUPERVISOR);
assert.deepEqual(spawnReferences, [`${supervisor} SessionProcessSupervisor.spawn`], 'ProcessTable.spawn is referred to only in the supervisor\'s spawn');
assert.deepEqual(tableValues, [`${supervisor} SessionProcessSupervisor.table`], 'the one process table is the supervisor\'s');
const spawn = readFileSync(SUPERVISOR, 'utf8').match(/\n {2}spawn\([^]*?\n {2}\}\n/)?.[0] ?? '';
const asks = spawn.indexOf('this.identityPolicy(');
assert.ok(asks !== -1 && asks < spawn.indexOf('this.table.spawn('), 'which asks the policy before it makes the process');
console.log('identity-change-choke-point: a process is made in one place, which asks the identity policy');
