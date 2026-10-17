// @serial
// @tier slow — drives a local workerd
import { matchNodeInWorkerd, shellWord } from './lib/node-differential.mjs';

const PROGRAM = String.raw`
const url = require('node:url');
const fs = require('node:fs');
const base = process.cwd();
const baseURL = url.pathToFileURL(base).href;
const api = globalThis.Bun || url;
const result = (fn, input) => {
  try {
    const value = fn(input);
    return { value: typeof value === 'string' ? value : value.href };
  } catch (error) { return { error: error.code || error.name }; }
};
const rows = [];
for (const phase of ['initial', 'moved']) {
  if (phase === 'moved') { fs.mkdirSync('moved'); process.chdir('moved'); }
  for (const input of ['a b.txt', 'hash#name', 'percent%name', './sub/../relative #%.txt', phase === 'initial' ? './parent %/' : '../parent %/', '', process.cwd() + '/a b#c%', '/tmp/a b#c%']) {
    rows.push([phase, 'encode', input, result(api.pathToFileURL, input), result(url.pathToFileURL, input)]);
  }
  for (const input of ['file:///tmp/a%20b', 'file:///tmp/%23name%25', 'file:///tmp/%C3%A9t%C3%A9', 'file://localhost/etc/x', 'file:///tmp/a%2Fb', 'file://host/x', 'https://example.com/x', new URL(baseURL + '/a%20b%23%25')]) {
    rows.push([phase, 'decode', typeof input === 'string' ? input : input.href, result(api.fileURLToPath, input), result(url.fileURLToPath, input)]);
  }
}
console.log('URLS ' + JSON.stringify(rows));
`;

await matchNodeInWorkerd('bun-file-url-workerd', '/home/user/url-case', { 'urls.cjs': PROGRAM }, ['urls.cjs'], {
  commandFor: (entry, side) => `${side === 'node' ? 'node' : 'bun'} ${shellWord(entry)}`,
});
