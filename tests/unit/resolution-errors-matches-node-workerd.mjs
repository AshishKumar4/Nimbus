#!/usr/bin/env bun
// A package resolution error with an ERR_* code is Node's internal error,
// by require() and by import(): its class (Error or TypeError), its code,
// and `Name [CODE]` heading its toString() and its stack. A module
// require() does not find stays a plain Error whose code is
// MODULE_NOT_FOUND, as Node's CJS loader makes it.
//
// Red before: the resolvers attached the code to a plain Error or
// TypeError, so String(error) and its stack read `Error: …` without it.
//
// Host Node is the oracle (lib/node-differential.mjs). Runs the worker
// built in the tree: rebuild the generated artifacts before testing a
// change to the resolvers.
import { matchNodeInWorkerd } from './lib/node-differential.mjs';

const CASES = ['pkg/missing', '#nope', 'badtarget', 'badconfig', '#seg/../x', 'missingmain'];

const files = {
  'package.json': JSON.stringify({ name: 'app', imports: { '#seg/*': './lib/*' } }),
  'lib/x.js': 'module.exports = 4;\n',
  'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', exports: { '.': './index.js' } }),
  'node_modules/pkg/index.js': 'module.exports = 1;\n',
  // A target that does not start with "./".
  'node_modules/badtarget/package.json': JSON.stringify({ name: 'badtarget', exports: { '.': 'index.js' } }),
  'node_modules/badtarget/index.js': 'module.exports = 2;\n',
  // Subpath keys and condition keys at once.
  'node_modules/badconfig/package.json': JSON.stringify({ name: 'badconfig', exports: { '.': './a.js', import: './b.mjs' } }),
  'node_modules/badconfig/a.js': 'module.exports = 3;\n',
  // A main that names no file.
  'node_modules/missingmain/package.json': JSON.stringify({ name: 'missingmain', main: 'gone.js' }),
  'cases.cjs': `const head = (text) => String(text).split('\\n')[0].split(': ')[0];
const show = (label, e) => console.log(label + '|' + e.constructor.name + '|' + (e instanceof TypeError) + '|' + e.code + '|' + head(String(e)) + '|' + head(e.stack));
const ids = ${JSON.stringify(CASES)};
for (const id of ids) {
  try { require(id); console.log('require ' + id + '|loaded'); } catch (e) { show('require ' + id, e); }
}
(async () => {
  for (const id of ids) {
    try { await import(id); console.log('import ' + id + '|loaded'); } catch (e) { show('import ' + id, e); }
  }
})();
`,
};

await matchNodeInWorkerd('resolution-errors', '/home/user/resolution-errors', files, ['node cases.cjs']);
console.log(`ok - resolution-errors-matches-node-workerd (${CASES.length} cases, by require() and import(), as Node gives them)`);
