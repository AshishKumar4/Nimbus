// @serial
// @tier slow — drives a local workerd
// TypeScript as Node 22.22.3 runs it (core runtime/typescript-strip.ts,
// amaro, Node's own stripper): each program's stdout, its stderr byte for
// byte (but the stack frames, which are the runtime's own beside the
// program's) and its exit code are host Node's. The format rules
// (module-format.ts typeScriptFormat: .mts, .cts, a .ts file's package type
// or, with none, its stripped syntax), type-only imports, frames at the
// file's own columns (an ES module's by its file: URL), the fatal arrow on the
// stripped line as V8 sees it, and what Node refuses: syntax strip-only mode
// does not take (an ES graph fails before any module runs; a require throws
// where it is called), syntax that does not parse, and TypeScript under
// node_modules. Before, TypeScript was compiled by esbuild: an enum ran,
// a .mts module was CommonJS, a frame's column was the compiled code's.
//
// --experimental-transform-types transforms what strip-only mode refuses and
// sets --enable-source-maps: the program's frames (compared here, Node's
// own left out) and the fatal arrow read the TypeScript source's places, its
// warning comes once TypeScript is parsed, and the source-map API answers
// as Node's. --enable-source-maps alone maps any module with a
// sourceMappingURL, inline or a file. --no-experimental-strip-types makes
// TypeScript JavaScript: required, the CommonJS loader's whatever its package,
// an ES module by its syntax; the entry the ES loader's (under --import, in a
// type:module package, or of module syntax), which knows no TypeScript
// extension. An import under another attribute type is another job.
//
// Named limit (fine-print capabilities, the fatal report's): where Node's
// report opens with the line of its own library an error was thrown or
// rethrown at (`node:internal/modules/run_main:123`, `…/typescript:156`),
// the runtime's has none; that block alone is left out of Node's stderr.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { matchNodeInWorkerd, placed } from './lib/node-differential.mjs';
import { withoutInternalArrow } from './lib/node-report.mjs';

const W = '/home/user/typescript';
const FILES = {
  'main.mts': "import { twice } from './lib.ts';\nimport type { Shape } from './types.ts';\nconst s: Shape = { n: 2 };\nconsole.log(twice(s.n), import.meta.url.endsWith('/main.mts'));\n",
  'lib.ts': 'export function twice(n: number): number { return n * 2; }\n',
  'types.ts': 'export type Shape = { n: number };\n',
  'cjs.cts': "const y: number = 3;\nmodule.exports = { y, kind: typeof require };\n",
  'use-cjs.cjs': "console.log(JSON.stringify(require('./cjs.cts')));\n",
  'detect-esm.ts': "const v: string = 'esm';\nexport {};\nconsole.log(v, typeof require);\n",
  'detect-cjs.ts': "const v: string = 'cjs';\nconsole.log(v, typeof require, typeof module);\n",
  'frames.mts': "const n: number = 1;\nexport function made(): Error { return new Error('x'); }\nconsole.log(made().stack.split('\\n')[1].trim().replace(/^at /, ''));\n",
  'frames.cts': "const n: number = 1;\nfunction made(): Error { return new Error('x'); }\nconsole.log(made().stack.split('\\n')[1].trim().replace(/^at /, ''));\n",
  'arrow.cts': "type A = string;\nconst v: A = 's'; null.x;\n",
  'graph.mts': "console.log('graph ran');\nimport './enum.ts';\n",
  'enum.ts': "console.log('enum ran');\nenum E { A }\n",
  'report-refusal.cjs': "process.once('uncaughtException', (error) => { console.log(JSON.stringify([error.constructor.name, error.code])); process.exitCode = 1; });\n",
  'require-enum.cjs': "console.log('before');\nrequire('./enum.cts');\n",
  'enum.cts': "console.log('enum.cts ran');\nenum E { A }\n",
  'invalid.ts': 'const bad: = 1;\n',
  'dep.mts': "import { x } from 'dep';\nconsole.log(x);\n",
  'node_modules/dep/package.json': '{"name":"dep","main":"index.ts"}',
  'node_modules/dep/index.ts': "console.log('dep ran');\nexport const x: number = 1;\n",
  'pkg/package.json': '{"type":"commonjs"}',
  'pkg/typed.ts': "const t: number = 4;\nconsole.log(t, typeof require);\n",
  "tt-enum.ts": "enum Color { Red, Green }\ninterface P { c: Color }\nfunction boom(p: P): never {\n  throw new Error('color ' + Color[p.c]);\n}\nboom({ c: Color.Green });\n",
  "tt-ns.ts": "namespace NS {\n  export const f = (x: number): never => { throw new TypeError('ns ' + x); };\n}\nconst n: number = 1;\nNS.f(n);\n",
  "tt-caught.ts": "enum E { A = 1 }\ntype T = { a: number };\nconst t: T = { a: E.A };\nfunction inner(): string { return new Error('here').stack!.split('\\n').slice(1, 3).map((l) => l.trim()).join('|'); }\nconsole.log(inner(), t.a);\ntry { null!.x; } catch (e) { console.log((e as Error).stack!.split('\\n')[1].trim()); }\n",
  "tt-esm.mts": "enum Mode { On = 'on' }\nconst m: Mode = Mode.On;\nfunction fail(): never { throw new RangeError('esm ' + m); }\nfail();\n",
  "tt-required.cjs": "console.log('js-out');\nrequire('./tt-dep.cts');\nconsole.log('after');\n",
  "tt-dep.cts": "enum K { A }\nconsole.log('cts', K.A);\n",
  "tt-api.cjs": "const m = require('module');\nconsole.log(process.sourceMapsEnabled, JSON.stringify(m.getSourceMapsSupport()));\nrequire('./tt-dep.cts');\nconst sm = m.findSourceMap(require.resolve('./tt-dep.cts'));\nconsole.log(sm instanceof m.SourceMap, sm.payload.sources.map((s) => s.slice(s.lastIndexOf('/'))), JSON.stringify(sm.findEntry(1, 2)), JSON.stringify(sm.findOrigin(1, 1)));\ntry { process.setSourceMapsEnabled('yes'); } catch (e) { console.log(e.code, e.message); }\ntry { new m.SourceMap(null); } catch (e) { console.log(e.code, e.message); }\nprocess.setSourceMapsEnabled(false);\nconsole.log(process.sourceMapsEnabled, m.findSourceMap(require.resolve('./tt-dep.cts')) === sm, m.findSourceMap('node:fs'));\n",
  "sm.js": "throw new Error('mapped');\n//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjogMywgInNvdXJjZXMiOiBbInNtLnNyYy5qcyJdLCAic291cmNlc0NvbnRlbnQiOiBbIi8vIG9yaWdpbmFsXG5cbiAgdGhyb3cgbmV3IEVycm9yKCdtYXBwZWQnKTtcbiJdLCAibmFtZXMiOiBbXSwgIm1hcHBpbmdzIjogIkFBRUUifQ==\n",
  "sm2.js": "const x = 1; null.x;\n//# sourceMappingURL=sm2.js.map\n",
  "sm2.js.map": "{\"version\": 3, \"sources\": [\"sm2.src.js\"], \"sourcesContent\": [\"\\n\\tconst x = 1; null.x;\\n\"], \"names\": [], \"mappings\": \"AACC,aAAa\"}",
  "off/plain.ts": "const a = 1;\nconsole.log('plain', a);\n",
  "off/typed.ts": "const p: number = 1;\n",
  "off/esm.mts": "export const z = 1;\nconsole.log('esm', z);\n",
  "off/plain.cts": "const c = 1;\nconsole.log('cts', c);\n",
  "off/loader.cjs": "require('./plain.ts');\nconsole.log(require('./esm.mts').z, require('./plain.cts'));\nimport('./esm.mts').then(() => console.log('imported'), (e) => console.log(e.code, e.message));\n",
  "off/import.mjs": "import './plain.ts';\n",
  "off/require-typed.cjs": "require('./typed.ts');\n",
  "off/mod/package.json": "{\"type\":\"module\"}",
  "off/mod/plain.ts": "console.log('mod plain');\n",
  "rv/sm3.js": "throw new Error('aliased');\n//# sourceURL=file:///home/user/alias.js\n//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjogMywgInNvdXJjZXMiOiBbIm9yaWcuc3JjLmpzIl0sICJzb3VyY2VzQ29udGVudCI6IFsiLy8gb3JpZ2luYWxcblxuXG4gIHRocm93IG5ldyBFcnJvcignYWxpYXNlZCcpO1xuIl0sICJuYW1lcyI6IFtdLCAibWFwcGluZ3MiOiAiQUFHRSJ9\n",
  "rv/sm4.cjs": "module.exports = 1;\n//# sourceURL=file:///home/user/alias4.js\n//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjogMywgInNvdXJjZXMiOiBbIm9yaWcuc3JjLmpzIl0sICJzb3VyY2VzQ29udGVudCI6IFsiLy8gb3JpZ2luYWxcblxuXG4gIHRocm93IG5ldyBFcnJvcignYWxpYXNlZCcpO1xuIl0sICJuYW1lcyI6IFtdLCAibWFwcGluZ3MiOiAiQUFHRSJ9\n",
  "rv/find.cjs": "const m = require('module');\nconsole.log('uncompiled', typeof m.findSourceMap(require.resolve('./sm4.cjs')));\nrequire('./sm4.cjs');\nconsole.log('compiled', typeof m.findSourceMap(require.resolve('./sm4.cjs')), typeof m.findSourceMap('file:///home/user/alias4.js'));\n",
  "rv/order.cjs": "const m = require('module');\nconsole.log('before', typeof m.findSourceMap(require.resolve('./sm4.cjs')));\nprocess.setSourceMapsEnabled(true);\nrequire('./sm4.cjs');\nconsole.log('after', typeof m.findSourceMap(require.resolve('./sm4.cjs')));\n",
  "rv/lines.mjs": "import { findSourceMap } from 'node:module';\nconst sm = findSourceMap(import.meta.url);\nconsole.log(JSON.stringify(sm?.lineLengths));\n//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImwuc3JjLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FBQ0E7QUFDQSJ9\n",
  "rv/en.ts": "enum E { A }\nconsole.log('enum ran', E.A);\n",
  "rv/plain.mts": "module.exports = 1;\nconsole.log('cjs mts ran');\n",
  "rv/mod/package.json": "{\"type\":\"module\"}",
  "rv/mod/p.cts": "console.log('cts in mod');\n",
  "rv/esm.mts": "export const z = 1;\nconsole.log('esm mts');\n",
  "rv/reqesm.cjs": "require('./esm.mts');\nimport('./esm.mts').then(() => console.log('import after require(esm) ok'), (e) => console.log('import:', e.code));\n",
  "rv/plain.foo": "console.log('foo ran');\n",
  "rv/foo.cjs": "require('./plain.foo');\nimport('./plain.foo').then(() => console.log('imported foo'), (e) => console.log('import foo:', e.code));\n",
  "rv/attr.cjs": "import('./plain.foo', { with: { type: 'json' } }).then(() => 0, (e) => console.log('attr:', e.code));\n",
  "rv/deep.ts": "const deep: unknown = [[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]];\nexport default 7;\n",
  "rv/deepimport.cjs": "import('./deep.ts').then((m) => console.log('default', m.default));\n",
  "rv/mod/q.cts": "console.log(typeof require, typeof __filename, this === module.exports);\nmodule.exports = 1;\n",
  "rv/mod/r.cts": "export const r = 2;\nconsole.log('esm cts in mod');\n",
  "rv/reqmod.cjs": "console.log(require('./mod/q.cts'), require('./mod/r.cts').r);\n",
  "rv/reqjson.cjs": "require('./esm.mts');\nimport('./esm.mts', { with: { type: 'json' } }).then(() => console.log('json ok'), (e) => console.log('json import:', e.code));\n",
  "rv/pre.mjs": "console.log('preloaded');\n",
  "rv/lines.cjs": "const { findSourceMap } = require('node:module');\nconsole.log(JSON.stringify(findSourceMap(__filename)?.lineLengths));\n//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImwuc3JjLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FBQ0E7QUFDQSJ9\n",
};
// Whose program frames are compared.
const FRAMED = [
  'node --experimental-transform-types tt-enum.ts', 'node --experimental-transform-types tt-ns.ts',
  'node --experimental-transform-types tt-caught.ts', 'node --experimental-transform-types tt-esm.mts',
  'node --experimental-transform-types tt-required.cjs', 'node --experimental-transform-types tt-api.cjs',
  'node --experimental-transform-types --no-enable-source-maps tt-enum.ts', 'NODE_OPTIONS=--experimental-transform-types node tt-ns.ts',
  'node --enable-source-maps sm.js', 'node --enable-source-maps sm2.js', 'node --enable-source-maps rv/sm3.js',
];
const COMMANDS = [
  'node main.mts', 'node use-cjs.cjs', 'node detect-esm.ts', 'node detect-cjs.ts', 'node frames.mts', 'node frames.cts',
  'node arrow.cts', 'node graph.mts', 'node require-enum.cjs', 'node invalid.ts', 'node dep.mts', 'node pkg/typed.ts',
  'node --require ./report-refusal.cjs enum.ts',
  'node --require ./report-refusal.cjs node_modules/dep/index.ts',
  ...FRAMED,
  'node --no-experimental-strip-types off/plain.ts',
  'node --no-experimental-strip-types tt-enum.ts',
  'node --no-experimental-strip-types off/esm.mts',
  'node --no-experimental-strip-types off/loader.cjs',
  'node --no-experimental-strip-types off/import.mjs',
  'node --no-experimental-strip-types off/require-typed.cjs',
  'node --no-experimental-strip-types off/mod/plain.ts',
  'NODE_OPTIONS=--no-experimental-strip-types node off/plain.ts',
  'node --enable-source-maps rv/find.cjs', 'node rv/order.cjs', 'node --enable-source-maps rv/lines.mjs', 'node --enable-source-maps rv/lines.cjs',
  'node --no-experimental-strip-types --experimental-transform-types --no-experimental-transform-types rv/en.ts',
  'node --experimental-transform-types --no-experimental-strip-types rv/en.ts',
  'node --no-experimental-strip-types rv/plain.mts', 'node --no-experimental-strip-types rv/mod/p.cts', 'node --no-experimental-strip-types rv/reqesm.cjs',
  'node rv/foo.cjs', 'node rv/attr.cjs', 'node rv/deepimport.cjs',
  'node --no-experimental-strip-types rv/reqmod.cjs', 'node --no-experimental-strip-types rv/reqjson.cjs',
  'node --import ./rv/pre.mjs --no-experimental-strip-types rv/plain.mts',
];

// A command's frames are left out, or, when it is FRAMED, only the program's are kept.
const shown = (text, { stream, side, from, root, command }) => {
  if (stream === 'out' && command.includes('--require ./report-refusal.cjs')) {
    const expected = command.endsWith(' enum.ts')
      ? ['SyntaxError', 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX']
      : ['Error', 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING'];
    assert.deepEqual(JSON.parse(text), expected, `${side}: the direct entry throws before its body runs`);
  }
  const kept = placed(text, from, root).replace(/^\(node:\d+\)/gm, '(node:PID)')
    .split('\n').filter((line) => !/^\s+at /.test(line) || (FRAMED.includes(command) && line.includes(`${root}/`))).join('\n');
  return stream === 'err' && side === 'node' ? withoutInternalArrow(kept) : kept;
};
await matchNodeInWorkerd('typescript-matches-node-workerd', W, FILES, COMMANDS, { shown });
console.log(`typescript-matches-node-workerd: ${COMMANDS.length} programs as Node runs them`);
