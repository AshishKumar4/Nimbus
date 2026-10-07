#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containsModuleSyntax } from '../../packages/core/src/runtime/javascript-ast.ts';

assert.equal(containsModuleSyntax('const x = 1; module.exports = x;'), false);
assert.equal(containsModuleSyntax('export function f() { return 1; }'), true);
assert.equal(
  containsModuleSyntax(`
export function strip(input) {
  return input.replace(/"(?:\\\\.|[^"\\\\])*"|\\/\\/[^\\n]*/g, "");
}
`),
  true,
);
assert.equal(containsModuleSyntax('const text = "export function nope() {}";'), false);
assert.equal(containsModuleSyntax('async function load() { return import("x"); }'), false);
// Node's syntax detection (doc/api/packages.md "Syntax detection"): a
// typeless .js file is an ES module when it holds syntax that throws as
// CommonJS. Each source is asked of real node: its first statement reports at
// exit whether the file ran with CommonJS's `module`.
{
  const sources = [
    // import.meta, at any depth.
    'const url = import.meta.url;',
    'function f() { return import.meta.dirname; }',
    // A top-level await, in a block or a for-await too; not one in a function or an arrow's body.
    'const x = await load();',
    'if (ready) { await load(); }',
    'for await (const x of xs) use(x);',
    'async function f() { await load(); }',
    'const f = async () => await load();\nmodule.exports = f;',
    // `await` is a CommonJS name outside async functions: a call of one is no module.
    'function await(x) { return x; }\nawait(1);',
    // A top-level lexical declaration of a name the CommonJS wrapper binds; not one in a block, nor a var.
    "const __dirname = '/a';",
    'class exports {}',
    'let require = () => 1;',
    "{ const __dirname = '/a'; }",
    "var __dirname = '/a';",
    'const dirname = __dirname;',
    // A member named import, export, await, const or class is not module syntax, after `?.` as after `.`.
    'const x = a.import; a.export = 1; a.await = 2;',
    'const x = a?.import; const y = a?.export;',
    'const x = a.const; a.class = 1;',
    // What does not tokenize as a module is not one.
    'var x = 010;',
  ];
  const dir = mkdtempSync(join(tmpdir(), 'module-syntax-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{"name":"detect"}');
    for (const source of sources) {
      writeFileSync(join(dir, 'probe.js'), "process.on('exit', () => console.log(typeof module === 'undefined' ? 'module' : 'commonjs'));\n" + source + '\n');
      const node = spawnSync('node', ['--no-warnings', 'probe.js'], { cwd: dir, encoding: 'utf8' });
      const ran = /^(module|commonjs)$/m.exec(node.stdout)?.[1];
      assert.ok(ran, `node ran ${JSON.stringify(source)}: ${node.stderr.slice(-400)}`);
      assert.equal(containsModuleSyntax(source), ran === 'module', `${JSON.stringify(source)} is ${ran} to node`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Pi 0.84.3 changed its executable from dist/cli.js to a split ESM bundle
// whose largest chunk is 3.7 MiB. The old detector built a complete Acorn AST
// just to answer yes/no; that one call retained about 80 MiB and reset the
// 128 MiB session isolate before Pi could start. Exercise the public helper in
// a constrained process: a streaming syntax detector fits, an AST does not.
const moduleUrl = new URL('../../packages/core/dist/runtime/javascript-ast.js', import.meta.url).href;
const stress = spawnSync('node', [
  '--max-old-space-size=48',
  '--input-type=module',
  '--eval',
  [
    `import { containsModuleSyntax } from ${JSON.stringify(moduleUrl)};`,
    'const source = "export default [" + "0,".repeat(1400000) + "];";',
    'if (!containsModuleSyntax(source)) process.exit(2);',
  ].join('\n'),
], { encoding: 'utf8', timeout: 30_000 });
assert.equal(
  stress.status,
  0,
  `large-module detection exceeded a 48 MiB heap: ${stress.error?.message ?? stress.stderr?.slice(-1200) ?? 'no child diagnostics'}`,
);

console.log('javascript-ast: ok');
