// X.5-C regression probe — install-pipeline coverage via integration harness.
//
// Mirrors W3.5's install-pipeline-coverage.mjs but runs Node-side (no
// wrangler dev / no miniflare WS). Synthesises a fixture VFS containing
// axios + ts-node + puppeteer-core's main files and verifies that the
// runtime require chain in node-shims works for all three.
//
// We use only what the W3 acceptance suite proved: axios.get/post,
// ts-node.register, puppeteer-core.launch.
//
// Pre-fix and post-fix: PASS (X.5-C is additive, doesn't regress W3).

import { makeFacet, check, summary, reset } from '../_helpers.mjs';
import { generateShimsCode } from '../../../../src/runtime/node-shims.ts';

reset();

console.log('X.5-C regression/r3-install-pipeline-coverage — W3-class CJS packages still load');

// Synth fixture: tiny stand-ins of three packages. We don't need their
// full implementation — just enough that __require chases the package.json,
// resolves the main, executes it, and the entry exports the named symbols.
const bundle = {
  'home/user/app/package.json': JSON.stringify({ name: 'app', version: '0.0.0' }),
  // axios
  'home/user/app/node_modules/axios/package.json': JSON.stringify({
    name: 'axios', version: '1.7.0', main: 'index.js',
  }),
  'home/user/app/node_modules/axios/index.js':
    "module.exports = { get: function () {}, post: function () {}, interceptors: {} };\n",
  // ts-node
  'home/user/app/node_modules/ts-node/package.json': JSON.stringify({
    name: 'ts-node', version: '10.9.2', main: 'dist/index.js',
  }),
  'home/user/app/node_modules/ts-node/dist/index.js':
    "module.exports = { register: function () {}, create: function () {} };\n",
  // puppeteer-core
  'home/user/app/node_modules/puppeteer-core/package.json': JSON.stringify({
    name: 'puppeteer-core', version: '24.0.0', main: 'lib/cjs/puppeteer/puppeteer.js',
  }),
  'home/user/app/node_modules/puppeteer-core/lib/cjs/puppeteer/puppeteer.js':
    "module.exports = { launch: function () {}, connect: function () {} };\n",
  // Test harness — run all three requires and stash the typeof results.
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

check(
  'no exception during require chain',
  err === null,
  err,
);
check(
  'axios.get is a function',
  result?.AXIOS_GET === 'function',
  JSON.stringify(result),
);
check(
  'axios.post is a function',
  result?.AXIOS_POST === 'function',
  JSON.stringify(result),
);
check(
  'ts-node.register is a function',
  result?.TSNODE_REGISTER === 'function',
  JSON.stringify(result),
);
check(
  'puppeteer-core.launch is a function',
  result?.PUP_LAUNCH === 'function',
  JSON.stringify(result),
);

const ok = summary();
process.exit(ok ? 0 : 1);
