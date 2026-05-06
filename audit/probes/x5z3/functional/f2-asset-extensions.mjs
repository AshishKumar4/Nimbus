// X.5-Z3 functional probe — asset prefetch covers .css, .html, .txt, .svg.
//
// Pre-fix: RED. Helper not exported.
// Post-fix: GREEN. All four extensions land in the bundle.

import { makeVfs, tryRealAssetHelper, check, summary, reset } from '../_helpers.mjs';

reset();

console.log('X.5-Z3 functional/f2-asset-extensions — .css/.html/.txt/.svg all prefetched');

const fixture = {
  'home/user/app/node_modules/multi-asset/package.json': JSON.stringify({
    name: 'multi-asset',
    version: '0.0.0',
    main: './index.js',
  }),
  'home/user/app/node_modules/multi-asset/index.js':
    'const fs = require("fs");\nconst path = require("path");\n' +
    'const css = fs.readFileSync(path.resolve(__dirname, "./styles.css"), "utf8");\n' +
    'const html = fs.readFileSync(path.resolve(__dirname, "./template.html"), {encoding: "utf-8"});\n' +
    'const txt = fs.readFileSync(path.resolve(__dirname, "./README.txt"), "utf8");\n' +
    'const svg = fs.readFileSync(path.resolve(__dirname, "./icon.svg"), "utf8");\n' +
    'module.exports = { css, html, txt, svg };\n',
  'home/user/app/node_modules/multi-asset/styles.css': 'body{}',
  'home/user/app/node_modules/multi-asset/template.html': '<html></html>',
  'home/user/app/node_modules/multi-asset/README.txt': 'hello',
  'home/user/app/node_modules/multi-asset/icon.svg': '<svg/>',
};

const vfs = makeVfs(fixture);
const cwd = '/home/user/app';

const inputBundle = {
  'home/user/app/node_modules/multi-asset/package.json': fixture['home/user/app/node_modules/multi-asset/package.json'],
  'home/user/app/node_modules/multi-asset/index.js': fixture['home/user/app/node_modules/multi-asset/index.js'],
};

const helper = await tryRealAssetHelper();

const expected = [
  'home/user/app/node_modules/multi-asset/styles.css',
  'home/user/app/node_modules/multi-asset/template.html',
  'home/user/app/node_modules/multi-asset/README.txt',
  'home/user/app/node_modules/multi-asset/icon.svg',
];

if (helper === null) {
  console.log('  (TDD-RED) addStaticReadFileAssets not exported');
  for (const k of expected) {
    check(`${k.split('/').pop()} prefetched`, k in inputBundle, 'pre-fix: not present (RED)');
  }
} else {
  const counters = { totalBytes: 0, fileCount: Object.keys(inputBundle).length };
  for (const k of Object.keys(inputBundle)) counters.totalBytes += inputBundle[k].length;
  helper(vfs, cwd, inputBundle, counters);
  for (const k of expected) {
    check(`${k.split('/').pop()} prefetched`, k in inputBundle);
  }
}

const ok = summary();
process.exit(ok ? 0 : 1);
