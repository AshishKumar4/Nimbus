#!/usr/bin/env node
// Paired in-process CPU comparison, under V8, of Node's syntax detection as
// the runtime answers it (core runtime/javascript-ast.ts containsModuleSyntax),
// one run. remote-module-syntax-cpu supplies the baseline's
// packages/core/src/runtime/javascript-ast.ts and judges the runs together.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { cpuMs, pairedKind, shuffled } from './lib/paired-cpu.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  assert.ok(at >= 0 && args[at + 1], `${name} is required`);
  return args[at + 1];
};
const baseline = resolve(option('--baseline'));
const output = option('--out');
const core = new URL('../../packages/core/', import.meta.url).pathname;
const head = join(core, 'src');
const PAIRS = 30;
const scratch = mkdtempSync(join(core, '.module-syntax-cpu-'));
let checksum = 0;
const results = [];

/** An arm: javascript-ast.ts from `dir`, bundled on its own (acorn with it), so no arm shares a module, or its JIT state, with another. */
async function arm(name, dir) {
  const bundled = await build({
    entryPoints: [join(dir, 'runtime/javascript-ast.ts')], bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'esnext',
    nodePaths: [join(core, 'node_modules')], mainFields: ['module', 'main'],
  });
  const file = join(scratch, `${name}.mjs`);
  writeFileSync(file, bundled.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

// A multi-MiB CommonJS bundle (TypeScript's compiler, with `import:` keys in
// it); a CommonJS module whose objects name the import and export
// conditions; an ES module's head of imports; eval-sized code.
const typescript = readFileSync(join(core, 'node_modules/typescript/lib/typescript.js'), 'utf8');
const conditions = `'use strict';\n${Array.from({ length: 4096 }, (_, i) => `exports.m${i} = { import: './esm/${i}.mjs', require: './cjs/${i}.js', default: { export: ${i} } };\nclass C${i} { export() { return ${i}; } static import() {} }\n`).join('')}`;
const esModule = `${Array.from({ length: 512 }, (_, i) => `import { a${i} } from './m${i}.js';\n`).join('')}export const all = [${Array.from({ length: 512 }, (_, i) => `a${i}`).join(', ')}];\n`;
const snippets = Array.from({ length: 256 }, (_, i) => i % 2 ? `console.log(require('node:path').sep, ${i})` : `const a = ${i}; { let b = a + 1; console.log(b) }`);

const work = {
  'commonjs-bundle'({ containsModuleSyntax }) { checksum += containsModuleSyntax(typescript) ? 0 : 1; },
  'commonjs-conditions'({ containsModuleSyntax }) { for (let i = 0; i < 8; i++) checksum += containsModuleSyntax(conditions) ? 0 : 1; },
  'es-module'({ containsModuleSyntax }) { for (let i = 0; i < 256; i++) checksum += containsModuleSyntax(esModule) ? 1 : 0; },
  'eval-code'({ containsModuleSyntax }) { for (let i = 0; i < 16; i++) for (const code of snippets) checksum += containsModuleSyntax(code, 'eval') ? 0 : 1; },
};

try {
  const sources = { A: baseline, null: baseline, real: head };
  const arms = {};
  for (const name of shuffled(Object.keys(sources))) arms[name] = await arm(name, sources[name]);
  // Each arm answers as the others do: the comparison is of the same work.
  for (const kind of Object.keys(work)) {
    const before = checksum;
    work[kind](arms.A);
    const baselineSum = checksum - before;
    work[kind](arms.real);
    assert.equal(checksum - before - baselineSum, baselineSum, `${kind}: the branch answers as the baseline`);
  }
  const cpu = (exports, kind) => cpuMs(() => work[kind](exports));
  for (const kind of Object.keys(work)) {
    const result = await pairedKind(kind, arms, cpu, { pairs: PAIRS, warm: 4, iterations: 1 });
    results.push(result);
    writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
    const { samples, ...summary } = result;
    console.log(JSON.stringify(summary));
  }
  assert.ok(checksum > 0);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
