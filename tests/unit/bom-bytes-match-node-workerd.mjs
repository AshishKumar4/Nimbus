// @serial
// @tier slow — drives a local workerd session through its program.
// A file that opens with a UTF-8 byte order mark reads back as its bytes, the
// mark included, from readFileSync as from fs.promises.readFile, however the
// launch staged it: a working-tree data file, a required CommonJS module, a
// required JSON file, an imported ES module and an installed package's
// package.json. require() of the JSON and the package's resolution skip the
// mark, as Node's parsers do. The snapshot used to decode each file with
// TextDecoder's default, which drops the mark: EF BB BF 68 69 read back as
// two bytes synchronously and five from the live file. One tree, on disk for
// real node and in a local workerd session (lib/node-differential.mjs):
// stdout, stderr and the exit code must be node's.

import { matchNodeInWorkerd } from './lib/node-differential.mjs';

const ROOT = '/home/user/bom';
const BOM = '\uFEFF';
const READ = ['data.txt', 'lib.cjs', 'conf.json', 'esm.mjs', 'node_modules/bompkg/package.json'];
const files = {
  'main.cjs': `const fs = require('fs');
const path = require('path');
const hex = (name) => fs.readFileSync(path.join(__dirname, name)).toString('hex');
// Every synchronous read first: an asynchronous read of a file refreshes what the process holds of it.
const sync = Object.fromEntries(${JSON.stringify(READ)}.map((name) => [name, hex(name)]));
(async () => {
  const esm = await import('./esm.mjs');
  const live = await fs.promises.readFile(path.join(__dirname, 'data.txt'));
  console.log(JSON.stringify({
    lib: require('./lib.cjs'),
    conf: require('./conf.json').a,
    pkg: require('bompkg'),
    esm: esm.default,
    sync,
    live: live.toString('hex'),
  }));
})();
`,
  'data.txt': `${BOM}hi`,
  'lib.cjs': `${BOM}module.exports = 'lib';\n`,
  'conf.json': `${BOM}{"a":1}\n`,
  'esm.mjs': `${BOM}export default 'esm';\n`,
  'node_modules/bompkg/package.json': BOM + JSON.stringify({ name: 'bompkg', version: '1.0.0', main: 'main.js' }),
  'node_modules/bompkg/main.js': "module.exports = 'bompkg';\n",
};

await matchNodeInWorkerd('bom-bytes-match-node-workerd', ROOT, files, ['node main.cjs']);
