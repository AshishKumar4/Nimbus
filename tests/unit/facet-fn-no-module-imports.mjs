#!/usr/bin/env bun
// facet-fn-no-module-imports — a serialized facet function may not reference a
// module import.
//
// Functions handed to `pool.submit` are serialized with `fn.toString()` and
// evaluated inside the facet isolate. Module bindings do not cross that
// boundary, so a free identifier that resolves to an import in the supervisor
// bundle is a ReferenceError at run time — and the failure surfaces wherever
// the facet happened to touch it. `WASI_ABI_NAMESPACE[abi]` inside
// wasm-runner's facet call turned every compiled binary into
// "wasi trap: instantiate failed", blaming the guest for a defect in the host,
// and typecheck cannot see it because the reference is perfectly valid in the
// file it is written in.
//
// The convention this enforces: values a facet needs travel as ARGUMENTS, and
// helpers are reached through `globalThis` (what `__rubyRun` and `__clangRun`
// already do).

import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'worker', 'src', 'runtime');

/** Named value imports — the ones that become free identifiers when serialized. */
function importedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^import\s+(?:type\s+)?\{([^}]+)\}\s+from/gm)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/**
 * Brace-matched body of the function whose declaration starts at `from`.
 *
 * The parameter list is skipped by PAREN matching first. Naively taking the
 * next `{` lands inside an inline parameter type — which is exactly the shape
 * every facet call has (`function wasmFacetCall(args: { ... })`) — and returns
 * the annotation instead of the body, so the detector reads nothing and passes.
 */
function bodyAt(src, from) {
  let i = src.indexOf('(', from);
  if (i < 0) return null;
  for (let parens = 0; i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')' && --parens === 0) { i++; break; }
  }
  let depth = 0;
  for (let j = src.indexOf('{', i); j >= 0 && j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j);
  }
  return null;
}

/**
 * The body a call site's identifier resolves to. Both shapes in the tree
 * matter: a plain `function name(...)`, and `const name = async function
 * inner(...)` / `const name = (...) => {}` — the wasm-runner and ruby-runner
 * facet calls use the second, which is exactly the one that shipped broken, so
 * missing it would make this test pass over the defect it exists for.
 */
function functionBody(src, name) {
  const declared = new RegExp(`function\\s+${name}\\s*[(<]`).exec(src);
  if (declared) return bodyAt(src, declared.index);
  const assigned = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\b|\\()`).exec(src);
  if (assigned) return bodyAt(src, assigned.index);
  return null;
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

let checked = 0;
const findings = [];

for (const file of readdirSync(RUNTIME_DIR).filter((f) => f.endsWith('.ts'))) {
  const src = readFileSync(join(RUNTIME_DIR, file), 'utf8');
  const imports = importedNames(src);
  if (imports.size === 0) continue;

  // Every function actually handed to a loader pool, by name at the call site.
  const submitted = new Set([...src.matchAll(/\.submit\w*\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  for (const name of submitted) {
    const body = functionBody(src, name);
    if (!body) continue;   // inline expression form; nothing to resolve here
    checked++;
    const code = stripComments(body);
    for (const imported of imports) {
      // A value use: called, indexed, or a property read. Type positions and
      // string/property occurrences do not produce a runtime reference.
      if (new RegExp(`(^|[^\\w.'"\`])${imported}\\s*[[(.]`, 'm').test(code)) {
        findings.push(`${file} :: ${name}() references the module import '${imported}'`);
      }
    }
  }
}

assert.ok(checked > 0, 'the detector found no submitted facet functions — it has stopped checking anything');
assert.deepEqual(findings, [],
  `serialized facet functions must not reference module imports:\n  ${findings.join('\n  ')}`);

console.log(`facet-fn-no-module-imports: ${checked} submitted facet functions, none reaches a module import`);
