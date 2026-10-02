/**
 * interpreter-bundle.mjs — the runtime-code interpreter (@nimbus-sh/core
 * src/interpreter) as a node launch's map carries it: three CommonJS modules.
 *
 *   - The primordials (primordials.ts): the built-ins the interpreter calls,
 *     captured when the launch starts, before any program code runs. The
 *     launch's runtime loads it at its start; the interpreter requires it.
 *   - The interpreter, bundled with acorn into one module. It loads late,
 *     after a program may have replaced built-ins, so its code must call
 *     none while it loads: esbuild's CommonJS output would (its interop
 *     helpers capture Object.defineProperty and walk export lists with
 *     for-of), so it is bundled as an ES module, which needs no helpers, and
 *     its one import and its export statement are then rewritten, by their
 *     syntax tree, to a require and a `module.exports` assignment. The
 *     bundle states strict mode, which ES modules had implicitly; the
 *     interpreter's closures depend on it (an assignment to a read-only
 *     property throws, `this` is not coerced).
 *   - The host module it runs on (HOST_OPS_SOURCE), which is sloppy at its
 *     top level so that interpreted sloppy functions are native sloppy
 *     functions; it cannot be part of a strict bundle.
 *
 * esbuild compiles core's TypeScript itself, so all three are built from core
 * src: bundle-node-shims.mjs stages them, and the tests build them the same
 * way to test the source they sit beside.
 */

import { parse } from 'acorn';
import { build } from 'esbuild';
import { join } from 'node:path';

import { resolvePackageDir } from './resolve-package-dir.mjs';

/** How the interpreter requires its primordials: the module beside it. */
export const PRIMORDIALS_FILE = 'interpreter-primordials.js';

/**
 * The interpreter's ES module bundle as a CommonJS module: its import of the
 * primordials becomes a require, its export statement `module.exports`.
 */
function asCommonJs(esm) {
  const program = parse(esm, { ecmaVersion: 'latest', sourceType: 'module' });
  const edits = [];
  for (const node of program.body) {
    if (node.type === 'ImportDeclaration') {
      if (node.source.value !== `./${PRIMORDIALS_FILE}` || node.specifiers.length !== 1 || node.specifiers[0].type !== 'ImportNamespaceSpecifier') {
        throw new Error(`[interpreter-bundle] the interpreter imports ${node.source.value} unexpectedly`);
      }
      edits.push({ start: node.start, end: node.end, text: `const ${node.specifiers[0].local.name} = require(${JSON.stringify(`./${PRIMORDIALS_FILE}`)});` });
    } else if (node.type === 'ExportNamedDeclaration' && !node.declaration && !node.source) {
      const fields = node.specifiers.map((s) => `${JSON.stringify(s.exported.name)}: ${s.local.name}`);
      edits.push({ start: node.start, end: node.end, text: `module.exports = { ${fields.join(', ')} };` });
    } else if (node.type.startsWith('Export')) {
      throw new Error(`[interpreter-bundle] the interpreter bundle has an unexpected ${node.type}`);
    }
  }
  let text = esm;
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return `"use strict";\n${text}`;
}

/**
 * @param {{ start: string }} options  `start`: a directory @nimbus-sh/core resolves from.
 * @returns {Promise<{ primordials: string, interpreter: string, ops: string }>}
 */
export async function bundleInterpreter({ start }) {
  const src = join(resolvePackageDir('@nimbus-sh/core', { start }), 'src/interpreter');
  const common = { bundle: true, platform: 'neutral', target: 'esnext', mainFields: ['module', 'main'], minify: true, legalComments: 'none', write: false };
  // esbuild states strict mode in the CommonJS it makes of an ES module.
  const primordials = await build({ ...common, entryPoints: [join(src, 'primordials.ts')], format: 'cjs' });
  const interpreter = await build({
    ...common,
    entryPoints: [join(src, 'index.ts')],
    format: 'esm',
    plugins: [{
      name: 'primordials',
      setup(b) {
        b.onResolve({ filter: /^\.\/primordials\.js$/ }, () => ({ path: `./${PRIMORDIALS_FILE}`, external: true }));
      },
    }],
  });
  // HOST_OPS_SOURCE is built when its module loads: compile and load it to read it.
  const ops = await build({ entryPoints: [join(src, 'host-ops.ts')], bundle: true, format: 'esm', platform: 'neutral', write: false });
  const { HOST_OPS_SOURCE } = await import(`data:text/javascript;base64,${Buffer.from(ops.outputFiles[0].text).toString('base64')}`);
  if (typeof HOST_OPS_SOURCE !== 'string' || HOST_OPS_SOURCE.length === 0) {
    throw new Error('[interpreter-bundle] core src/interpreter/host-ops.ts has no HOST_OPS_SOURCE');
  }
  return { primordials: primordials.outputFiles[0].text, interpreter: asCommonJs(interpreter.outputFiles[0].text), ops: HOST_OPS_SOURCE };
}
