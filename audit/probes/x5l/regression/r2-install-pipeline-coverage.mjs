// X.5-L regression probe — install-pipeline coverage.
//
// Re-runs the X.5-C regression r3 fixture (axios, ts-node, puppeteer-core)
// against the *current* node-shims + (post-fix) require-resolver. The
// X.5-L fix is in resolvePkgSubpath; W3-class CJS packages don't exercise
// that path, so they must still load identically.
//
// Pre-fix and post-fix: PASS.

import { makeFacet, check, summary, reset } from '../_helpers.mjs';
import { generateShimsCode } from '../../../../src/node-shims.ts';

reset();

console.log('X.5-L regression/r2-install-pipeline-coverage — W3-class CJS packages still load');

const bundle = {
  'home/user/app/package.json': JSON.stringify({ name: 'app', version: '0.0.0' }),
  'home/user/app/node_modules/axios/package.json': JSON.stringify({
    name: 'axios', version: '1.7.0', main: 'index.js',
  }),
  'home/user/app/node_modules/axios/index.js':
    "module.exports = { get: function () {}, post: function () {}, interceptors: {} };\n",
  'home/user/app/node_modules/ts-node/package.json': JSON.stringify({
    name: 'ts-node', version: '10.9.2', main: 'dist/index.js',
  }),
  'home/user/app/node_modules/ts-node/dist/index.js':
    "module.exports = { register: function () {}, create: function () {} };\n",
  'home/user/app/node_modules/puppeteer-core/package.json': JSON.stringify({
    name: 'puppeteer-core', version: '24.0.0', main: 'lib/cjs/puppeteer/puppeteer.js',
  }),
  'home/user/app/node_modules/puppeteer-core/lib/cjs/puppeteer/puppeteer.js':
    "module.exports = { launch: function () {}, connect: function () {} };\n",
  'home/user/app/script.js':
    "const axios = require('axios');\n" +
    "const tsNode = require('ts-node');\n" +
    "const pup = require('puppeteer-core');\n" +
    "module.exports = {\n" +
    "  AXIOS_GET: typeof axios.get,\n" +
    "  AXIOS_POST: typeof axios.post,\n" +
    "  TSNODE_REGISTER: typeof tsNode.register,\n" +
    "  PUP_LAUNCH: typeof pup.launch,\n" +
    "};\n",
};

const dirs = {
  'home/user/app': true,
  'home/user/app/node_modules': true,
  'home/user/app/node_modules/axios': true,
  'home/user/app/node_modules/ts-node': true,
  'home/user/app/node_modules/ts-node/dist': true,
  'home/user/app/node_modules/puppeteer-core': true,
  'home/user/app/node_modules/puppeteer-core/lib': true,
  'home/user/app/node_modules/puppeteer-core/lib/cjs': true,
  'home/user/app/node_modules/puppeteer-core/lib/cjs/puppeteer': true,
};

let result;
let err = null;
try {
  const facet = makeFacet({ bundle, dirs, generateShimsCode });
  result = facet.__require('./script');
} catch (e) {
  err = e && e.message ? e.message : String(e);
}

check('no exception during require chain', err === null, err);
check('axios.get is a function', result?.AXIOS_GET === 'function', JSON.stringify(result));
check('axios.post is a function', result?.AXIOS_POST === 'function', JSON.stringify(result));
check('ts-node.register is a function', result?.TSNODE_REGISTER === 'function', JSON.stringify(result));
check('puppeteer-core.launch is a function', result?.PUP_LAUNCH === 'function', JSON.stringify(result));

const ok = summary();
process.exit(ok ? 0 : 1);
