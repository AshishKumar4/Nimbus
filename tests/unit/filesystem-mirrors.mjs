#!/usr/bin/env bun
/**
 * The filesystem bridge's two mirrors (vfsSupervisor, bridgeOverSupervisor)
 * are written by core's build from one table (filesystem-methods.ts
 * FILESYSTEM_METHODS), one typed arrow per method:
 *   - the committed file is what the generator writes from the source table;
 *   - the compiler checks each method on both sides: the generated file
 *     compiles, and the file a table pairing a method with another's RPC
 *     name would generate does not.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { FILESYSTEM_METHODS } from '../../packages/core/src/runtime/filesystem-methods.ts';
import { FILESYSTEM_MIRRORS_GENERATED, filesystemMirrorsSource } from '../../packages/core/scripts/generate-filesystem-mirrors.mjs';

const committed = readFileSync(FILESYSTEM_MIRRORS_GENERATED, 'utf8');
assert.equal(filesystemMirrorsSource(FILESYSTEM_METHODS), committed, "the committed mirrors are the table's (run core's build)");

/** The compiler's errors in the mirrors file, were it `text`. */
function mirrorErrors(text) {
  const options = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'] };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (name) => (name === FILESYSTEM_MIRRORS_GENERATED ? text : readFile(name));
  host.getSourceFile = (name, version, onError, create) => (name === FILESYSTEM_MIRRORS_GENERATED
    ? ts.createSourceFile(name, text, version)
    : getSourceFile(name, version, onError, create));
  const program = ts.createProgram([FILESYSTEM_MIRRORS_GENERATED], options, host);
  const file = program.getSourceFile(FILESYSTEM_MIRRORS_GENERATED);
  return ts.getPreEmitDiagnostics(program, file).map((d) => {
    const { line } = file.getLineAndCharacterOfPosition(d.start ?? 0);
    return { line: text.split('\n')[line].trim(), message: ts.flattenDiagnosticMessageText(d.messageText, '\n') };
  });
}

assert.deepEqual(mirrorErrors(committed), [], 'the generated mirrors type-check');

// Each mirror's arrow is checked on its own: a table pairing stat with
// readdir's RPC name is refused in both mirrors, by the methods' answers.
const swapped = { ...FILESYSTEM_METHODS, stat: FILESYSTEM_METHODS.readdir, readdir: FILESYSTEM_METHODS.stat };
const errors = mirrorErrors(filesystemMirrorsSource(swapped));
for (const [mirror, arrow] of [['vfsSupervisor', /=> fs\.(stat|readdir)\(/], ['bridgeOverSupervisor', /=> answerValue\(supervisor\.(stat|readdir)\(/]]) {
  assert.ok(errors.some(({ line }) => arrow.test(line)), `${mirror}: the mispaired method is refused\n${JSON.stringify(errors, null, 1)}`);
}

console.log(`filesystem-mirrors: ${Object.keys(FILESYSTEM_METHODS).length} methods, generated text current, a mispaired table refused (${errors.length} errors)`);
