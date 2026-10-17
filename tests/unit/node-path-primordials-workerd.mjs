// @serial
// @tier slow — drives a local workerd
// The guest's node:path answers as Node's after a program replaced the
// built-ins Node's lib/path.js calls through its primordials, as host Node's
// does: each replaced with one that throws, path.posix's functions called,
// the built-in put back and the answers printed. And node:path is Node's in
// shape: its keys in Node's order, its functions' names, posix itself,
// _makeLong toNamespacedPath. Host Node is the oracle.
import { matchNodeInWorkerd } from './lib/node-differential.mjs';

const BUILTINS = [
  ['String.prototype', 'charCodeAt'], ['String.prototype', 'slice'], ['String.prototype', 'lastIndexOf'],
  ['String.prototype', 'indexOf'], ['String.prototype', 'replace'], ['String.prototype', 'split'],
  ['Array.prototype', 'join'], ['Array.prototype', 'push'], ['Array.prototype', 'slice'],
  ['Function.prototype', 'bind'], ['Function.prototype', 'call'], ['Function.prototype', 'apply'],
];
const main = `const path = require('node:path');
const BUILTINS = ${JSON.stringify(BUILTINS)};
const owners = { 'String.prototype': String.prototype, 'Array.prototype': Array.prototype, 'Function.prototype': Function.prototype };
const exercise = () => [
  path.dirname('/a/b/c/'), path.basename('/a/b.txt', '.txt'), path.extname('x/.y.z'), path.normalize('/a//b/../c/./d/'),
  path.join('a', '', '../b', 'c/'), path.resolve('x', '../y'), path.relative('/a/b/c', '/a/d'), path.isAbsolute('/q'),
  JSON.stringify(path.parse('/home/u/f.tar.gz')), path.format({ dir: '/d', name: 'n', ext: 'e' }), path.posix.dirname('//x'),
];
for (const [owner, key] of BUILTINS) {
  const target = owners[owner];
  const saved = target[key];
  target[key] = function () { throw new Error(owner + '.' + key + ' replaced'); };
  let seen;
  try { seen = exercise(); } catch (error) { seen = 'threw ' + error.message; }
  target[key] = saved;
  console.log(owner + '.' + key + ': ' + JSON.stringify(seen));
}
console.log(Object.keys(path).join());
console.log(['resolve', 'normalize', 'join', 'relative', 'dirname', 'basename', 'extname', 'format', 'parse'].map((k) => path[k].name).join());
console.log(path.posix === path, path._makeLong === path.toNamespacedPath, path.sep, path.delimiter, typeof path.win32.join, typeof path.matchesGlob);
`;

await matchNodeInWorkerd('node-path-primordials', '/home/user/pathp', { 'main.js': main }, ['node main.js']);
console.log('ok - node-path-primordials-workerd');
