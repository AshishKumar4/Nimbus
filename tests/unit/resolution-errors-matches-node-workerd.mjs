#!/usr/bin/env bun
// @tier slow — drives a local workerd; CI 9.4 s wall, 11.7 s CPU, 1.4 GiB peak (2026-10-16)
// A package resolution error with an ERR_* code is Node's internal error,
// by require() and by import(): its class (Error or TypeError), its code,
// and `Name [CODE]` heading its toString() and its stack. Those Node 22
// throws from C++ (a package.json it cannot parse, a main legacyMainResolve
// does not find) are plain Errors with their code, as are a module require()
// does not find, MODULE_NOT_FOUND.
//
// Red before: the resolvers attached the code to a plain Error or
// TypeError, so String(error) and its stack read `Error: …` without it.
//
// Host Node is the oracle (lib/node-differential.mjs). Runs the worker
// built in the tree: rebuild the generated artifacts before testing a
// change to the resolvers.
import { matchNodeInWorkerd } from './lib/node-differential.mjs';

const CASES = ['pkg/missing', '#nope', 'badtarget', 'badconfig', '#seg/../x', 'missingmain', 'badjson'];

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
  // A package.json that is not JSON.
  'node_modules/badjson/package.json': '{ not json\n',
  'node_modules/badjson/index.js': 'module.exports = 5;\n',
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
