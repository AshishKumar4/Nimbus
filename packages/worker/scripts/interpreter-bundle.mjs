/**
 * interpreter-bundle.mjs — the runtime-code interpreter (@nimbus-sh/core
 * src/interpreter) as a node launch's map carries it: four CommonJS modules.
 *
 *   - The primordials (primordials.ts): the built-ins the interpreter calls,
 *     captured when the launch starts, before any program code runs. The
 *     launch's runtime loads it at its start; the interpreter requires it.
 *   - The parser (parser.ts): acorn, and what a fatal report reads with it,
 *     which a report loads without the interpreter. It loads late, after a
 *     program may have replaced built-ins, so its code must call none while
 *     it loads or parses: acorn is bundled rewritten to reach the realm only
 *     through captures (acorn-primordials.mjs, parser-realm.ts).
 *   - The interpreter, which requires the parser for acorn, and loads as
 *     late. esbuild's CommonJS output would reach the realm too (its interop
 *     helpers capture Object.defineProperty and walk export lists with
 *     for-of), so it and the parser are bundled as ES modules, which need no
 *     helpers, and their imports and export statement are then rewritten,
 *     by their syntax tree, to requires and a `module.exports` assignment.
 *     Each bundle states strict mode, which ES modules had implicitly; the
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
import { build, transform } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { primordialAcorn } from './acorn-primordials.mjs';
import { resolvePackageDir } from './resolve-package-dir.mjs';

/** How the interpreter requires its primordials: the module beside it. */
export const PRIMORDIALS_FILE = 'interpreter-primordials.js';
/** How the interpreter requires acorn: the parser module beside it. */
export const PARSER_FILE = 'parser.js';

/** Evaluate the registry template whose helpers already came from the shared build-time compiler. */
export async function bundleRegistry({ start }) {
  const entry = join(resolvePackageDir('@nimbus-sh/core', { start }), 'src/_shared/commonjs-cell.ts');
  const output = await build({
    stdin: { contents: `export { COMMONJS_CELL_RUNTIME_SOURCE } from ${JSON.stringify(entry)};`, resolveDir: start },
    bundle: true, format: 'esm', platform: 'node', target: 'esnext', write: false,
  });
  const text = output.outputFiles[0].text;
  const module = await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`);
  return (await transform(module.COMMONJS_CELL_RUNTIME_SOURCE, { minifyWhitespace: true, target: 'esnext', charset: 'utf8' })).code;
}

/**
 * An ES module bundle of the interpreter or the parser as a CommonJS module:
 * its namespace import of the primordials, and the interpreter's named import
 * of the parser, become requires, its export statement `module.exports`.
 * `imports`: the names it imports from the parser; `exports`: those it exports.
 */
function asCommonJs(esm, label) {
  const program = parse(esm, { ecmaVersion: 'latest', sourceType: 'module' });
  const edits = [];
  const imports = [];
  const exports = [];
  for (const node of program.body) {
    if (node.type === 'ImportDeclaration') {
      const [only] = node.specifiers;
      const request = JSON.stringify(node.source.value);
      if (node.source.value === `./${PRIMORDIALS_FILE}` && node.specifiers.length === 1 && only.type === 'ImportNamespaceSpecifier') {
        edits.push({ start: node.start, end: node.end, text: `const ${only.local.name} = require(${request});` });
      } else if (label === 'esm-late' && node.source.value === `./${PRIMORDIALS_FILE}`) {
        const fields = [];
        for (const s of node.specifiers) {
          if (s.type !== 'ImportSpecifier' || s.imported.type !== 'Identifier') throw new Error(`[interpreter-bundle] the esm-late imports the primordials by a ${s.type}`);
          fields.push(`${s.imported.name}: ${s.local.name}`);
        }
        edits.push({ start: node.start, end: node.end, text: `const { ${fields.join(', ')} } = require(${request});` });
      } else if (label === 'interpreter' && node.source.value === `./${PARSER_FILE}`) {
        // Read once, as the parser's exports are a plain object it never changes.
        const fields = [];
        for (const s of node.specifiers) {
          if (s.type !== 'ImportSpecifier' || s.imported.type !== 'Identifier') throw new Error(`[interpreter-bundle] the interpreter imports the parser by a ${s.type}`);
          fields.push(`${s.imported.name}: ${s.local.name}`);
          imports.push(s.imported.name);
        }
        edits.push({ start: node.start, end: node.end, text: `const { ${fields.join(', ')} } = require(${request});` });
      } else {
        throw new Error(`[interpreter-bundle] the ${label} imports ${node.source.value} unexpectedly`);
      }
    } else if (node.type === 'ExportNamedDeclaration' && !node.declaration && !node.source) {
      // `export { x as "y" }` names the export with a string; the local is an identifier.
      const exportName = (s) => (s.exported.type === 'Identifier' ? s.exported.name : String(s.exported.value));
      const fields = node.specifiers.map((s) => `${JSON.stringify(exportName(s))}: ${/** @type {import('acorn').Identifier} */ (s.local).name}`);
      exports.push(...node.specifiers.map(exportName));
      edits.push({ start: node.start, end: node.end, text: `module.exports = { ${fields.join(', ')} };` });
    } else if (node.type.startsWith('Export')) {
      throw new Error(`[interpreter-bundle] the ${label} bundle has an unexpected ${node.type}`);
    }
  }
  let text = esm;
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return { text: `"use strict";\n${text}`, imports, exports };
}

/**
 * @param {{ start: string }} options  `start`: a directory @nimbus-sh/core resolves from.
 * @returns {Promise<{ primordials: string, parserModule: string, interpreter: string, ops: string, parser: string, esmLate: string }>}
 *   `parserModule`: the parser module beside the interpreter; `parser`: acorn's module as the rewrite made it, before bundling;
 *   `esmLate`: the late graph's link (core runtime/esm-late-link.ts).
 */
export async function bundleInterpreter({ start }) {
  const src = join(resolvePackageDir('@nimbus-sh/core', { start }), 'src/interpreter');
  /** @type {import('esbuild').BuildOptions} */
  const common = { bundle: true, platform: 'neutral', target: 'esnext', mainFields: ['module', 'main'], minify: true, legalComments: 'none', write: false, metafile: true };
  const primordialsExternal = (b) => b.onResolve({ filter: /^\.\/primordials\.js$/ }, () => ({ path: `./${PRIMORDIALS_FILE}`, external: true }));
  // esbuild states strict mode in the CommonJS it makes of an ES module.
  const primordials = await build({ ...common, entryPoints: [join(src, 'primordials.ts')], format: 'cjs' });
  let parser = null;
  const parserModule = await build({
    ...common,
    entryPoints: [join(src, 'parser.ts')],
    format: 'esm',
    plugins: [{
      name: 'primordials',
      setup(b) {
        primordialsExternal(b);
        // acorn, rewritten to reach the realm only through parser-realm.ts.
        b.onLoad({ filter: /[\\/]acorn[\\/]dist[\\/]acorn\.mjs$/ }, async (args) => {
          if (parser !== null) throw new Error(`[interpreter-bundle] acorn loaded twice (${args.path})`);
          parser = primordialAcorn(await readFile(args.path, 'utf8'), join(src, 'parser-realm.ts')).code;
          return { contents: parser, loader: 'js' };
        });
      },
    }],
  });
  const acornInputs = Object.keys(parserModule.metafile.inputs).filter((path) => /(^|[\\/])acorn[\\/]/.test(path));
  if (parser === null || acornInputs.length !== 1) {
    throw new Error(`[interpreter-bundle] acorn must be bundled once, from dist/acorn.mjs, rewritten; bundled ${acornInputs.join(', ') || 'none'}`);
  }
  const interpreter = await build({
    ...common,
    entryPoints: [join(src, 'index.ts')],
    format: 'esm',
    plugins: [{
      name: 'primordials',
      setup(b) {
        primordialsExternal(b);
        // acorn is the parser module's.
        b.onResolve({ filter: /^acorn$/ }, () => ({ path: `./${PARSER_FILE}`, external: true }));
      },
    }],
  });
  const bundledAcorn = Object.keys(interpreter.metafile.inputs).filter((path) => /(^|[\\/])acorn[\\/]/.test(path));
  if (bundledAcorn.length !== 0) throw new Error(`[interpreter-bundle] the interpreter bundles acorn (${bundledAcorn.join(', ')}); it requires the parser's`);
  // HOST_OPS_SOURCE is built when its module loads: compile and load it to read it.
  const ops = await build({ entryPoints: [join(src, 'host-ops.ts')], bundle: true, format: 'esm', platform: 'neutral', write: false });
  const { HOST_OPS_SOURCE } = await import(`data:text/javascript;base64,${Buffer.from(ops.outputFiles[0].text).toString('base64')}`);
  if (typeof HOST_OPS_SOURCE !== 'string' || HOST_OPS_SOURCE.length === 0) {
    throw new Error('[interpreter-bundle] core src/interpreter/host-ops.ts has no HOST_OPS_SOURCE');
  }
  // The late graph's link and Node's CommonJS lexer (core runtime/esm-late-link.ts): a module of its own.
  const esmLate = await build({
    ...common,
    entryPoints: [join(src, '../runtime/esm-late-link.ts')],
    format: 'esm',
    plugins: [{
      name: 'late-primordials',
      setup(b) {
        b.onResolve({ filter: /primordials\.(?:js|ts)$/ }, (args) => {
          const path = args.path.startsWith('.') ? resolve(args.resolveDir, args.path) : args.path;
          if (/(^|[\\/])_shared[\\/]primordials\.(?:js|ts)$/.test(path)) return { path: `./${PRIMORDIALS_FILE}`, external: true };
        });
      },
    }],
  });
  const lateCaptures = Object.keys(esmLate.metafile.inputs).filter((path) => /(^|[\\/])_shared[\\/]primordials\.ts$/.test(path));
  if (lateCaptures.length !== 0) throw new Error(`[interpreter-bundle] esm-late bundles the primordials (${lateCaptures.join(', ')}); it requires the launch's`);
  const parserCommonJs = asCommonJs(parserModule.outputFiles[0].text, 'parser');
  const interpreterCommonJs = asCommonJs(interpreter.outputFiles[0].text, 'interpreter');
  const unexported = interpreterCommonJs.imports.filter((name) => !parserCommonJs.exports.includes(name));
  if (unexported.length !== 0) throw new Error(`[interpreter-bundle] the interpreter imports ${unexported.join(', ')} of acorn, which core src/interpreter/parser.ts does not export`);
  return {
    primordials: primordials.outputFiles[0].text,
    parserModule: parserCommonJs.text,
    interpreter: interpreterCommonJs.text,
    ops: HOST_OPS_SOURCE,
    parser,
    esmLate: asCommonJs(esmLate.outputFiles[0].text, 'esm-late').text,
  };
}
