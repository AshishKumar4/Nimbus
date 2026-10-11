#!/usr/bin/env bun
// scripts/vendor-node-lib.mjs — regenerate
// packages/worker/src/runtime/node-lib-source.ts, the node shims' vendored
// Node library (node-lib-host.ts says how it runs):
//
//   bun scripts/vendor-node-lib.mjs           write the file
//   bun scripts/vendor-node-lib.mjs --check   exit 1 unless the file is what it would write
//
// Every input is pinned: each upstream file by URL and sha256 (a download
// that does not match stops the script), and the one measured input,
// NODE_BUILTIN_OBJECTS, by the real node it was measured on (its version must
// be NODE_VERSION; the measurement is printed with the file). The output is a
// pure function of the inputs.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = 'v22.22.3';
const UNICODE_VERSION = '17.0.0';
const libUrl = (id) => `https://raw.githubusercontent.com/nodejs/node/${NODE_VERSION}/lib/${id}.js`;
// Node's modules the shims run, by their id under lib/, each pinned by digest.
const LIB = {
  'internal/util/inspect': '2f2f01d7077800f8565d1be2bd1e6800f8ac02759482dc080eb6bc6005d67dd1',
  'internal/source_map/source_map': '8a5b739a9c886ccbeb73932ad9d37d666469e7b643039ba53482116a93859e91',
  'internal/validators': '77c43165d42bff6f539305bfaeb8d324639ae3e8d0f21e9f97b2e51f198f10ee',
  'internal/util/colors': '3dc1104394555b39db424624389096a9f55b21dfb10118201a493bacae94b1b3',
  'internal/util/comparisons': '41a2c9547c4560197542ff97f3f9a9b36bd3804ba114c100435a2d7ad95a89c6',
  'internal/errors/error_source': 'ba84ebd73ab2ff0460036cf86591773c5fb05f86abce8396be0399694a77236f',
  'internal/assert/assertion_error': '41ebb0538f7707b144042ea4ac1085db1268751f8a727760f09fb06d720e6ba4',
  'internal/assert/myers_diff': '811f14c9c9f0a85b39cc2925dc351f9ce6d0ce0f4e0426802c72e5bf0d905ea6',
  'internal/assert/utils': 'ea5b811f58b5d6ee922bd8aaa9f2bec0826b0ba04d1f929eddbfe0ba1224f596',
  'internal/assert/calltracker': 'b73a7f5296ed47e22ca20f28d03c2aaa3f0a2f53c295e35c20f8a337391bf9ba',
  assert: 'fced6e2d8263a79e76887a95766bf7fcf7fcc5097aa608e7f672893e6bd2c2c4',
  'internal/querystring': '92d0cbd561d7cce93936b083d56d2a41063d177f3aa6772ae2c1871f160163d1',
  querystring: '4035dd8989e502f3c69eeba0eaeb9851c7609d749674a6bcbb043a1a0a65b507',
  punycode: 'c5c75d5f31323affefa3595e63b3c50bca8bf7a2766936699e20460398e61717',
  'internal/streams/utils': '76f2a40f2e1b799a575116036549bf5eca5f69b9038a77b1016eee823e51625f',
  'internal/util/debuglog': '4471d0ba1b85d272e583aef5ec9fe05c28377bf59b923523495bcba46a858fec',
  'internal/mime': 'a926034befba38450e6198f7d9a1b27a4fb3dcf285cc2ba026adf64f95414430',
  'internal/util/diff': '01aee993a6a0bc81c3cdfed2aebfe286fae25293b6fef110dd8bcb16266fe63e',
  'internal/util/parse_args/utils': '15b86ef2cb0355c3b86be9b87963e336d50dc51c81a274307b59fed75bac2056',
  'internal/util/parse_args/parse_args': 'a20438c20034305bdf1ef0053a938d9b5ae12865caca964dac79e897d38052a6',
  'internal/util/trace_sigint': 'a40ab7d0652fac3691cb83d1084a94e1559f9a7773c17c8a6bdb51381530dc8c',
  'internal/process/per_thread': '9fb576a173cf42cfde6a73798c538ff8ad470b03fa8c4d132083774aee0e2266',
  util: '0499a613f2263f431151eb41380814a851b8cfecbf45044cfdd245e0f02e6dc6',
  dns: 'c6f13326d594400b1879f3d56852d98e785f2bab92048592bce5b748b58549b2',
  'dns/promises': 'd95ebe014ed0ef8fd9004935545903944589345bb13e0e52d849bd50e15fc4a8',
  'internal/dns/utils': '551792e7d334ab57d7be038458753365bf089f0c550f27c4bc1a16575f2f64ff',
  'internal/dns/callback_resolver': 'c409809e7df56cf2c820b7272714b60e3c31ac9b2f9e4b127d238352003573b7',
  'internal/dns/promises': 'f724175f7c423dcff27eb5c89e2ddee4edd0cb9818d90a68adb2b5291dd7c7d0',
  'internal/net': 'edbf1a195b68a7840be4fb11f8967cc4c4ca52ac2e1b1d368fd887491ba7918e',
};
const SOURCES = {
  primordials: {
    url: libUrl('internal/per_context/primordials'),
    sha256: '9e3fe2fe051667172d6ed9d997eee99b3454a7e4ec779dd63c1f19d44b25b1ca',
  },
  eastAsianWidth: {
    url: `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd/EastAsianWidth.txt`,
    sha256: 'ea7ce50f3444a050333448dffef1cadd9325af55cbb764b4a2280faf52170a33',
  },
};
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages/worker/src/runtime/node-lib-source.ts');

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
async function fetchPinned({ url, sha256: want }) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const text = await response.text();
  const got = sha256(text);
  if (got !== want) throw new Error(`${url}: sha256 ${got}, pinned ${want}`);
  return text;
}

/** The W and F ranges of EastAsianWidth.txt, merged and ascending, as `first[-last]` in hex. */
function wideRanges(text) {
  const ranges = [];
  for (const line of text.split('\n')) {
    const match = /^([0-9A-F]+)(?:\.\.([0-9A-F]+))?\s*;\s*(W|F)\b/.exec(line);
    if (match) ranges.push([parseInt(match[1], 16), parseInt(match[2] ?? match[1], 16)]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged.map(([a, b]) => a.toString(16) + (b !== a ? '-' + b.toString(16) : '')).join(',');
}

/**
 * The names Node's inspect.js counts as built-in (its builtInObjects: the
 * capitalised globals when it loaded), measured on real node: each global
 * name, given to a constructor whose prototype has a getter, that showHidden
 * does not show the getter for. A made-up name is the control.
 */
function measureBuiltinObjects() {
  const program = `
const util = require('util');
const names = Object.getOwnPropertyNames(globalThis).filter((n) => /^[A-Z][a-zA-Z0-9]+$/.test(n));
const builtin = [];
for (const name of [...names, 'Zzzcontrol']) {
  const ctor = { [name]: function () {} }[name];
  ctor.prototype = { constructor: ctor, get g() { return 1; } };
  const obj = new ctor();
  obj.own = 1;
  if (!util.inspect(obj, { showHidden: true }).includes('g: [Getter]')) builtin.push(name);
}
if (builtin.includes('Zzzcontrol')) throw new Error('a made-up name counted built-in: the measurement is wrong');
console.log(JSON.stringify({ version: process.version, builtin }));
`;
  const node = spawnSync('node', ['-e', program], { encoding: 'utf8' });
  if (node.status !== 0) throw new Error(`node: ${node.stderr}`);
  const { version, builtin } = JSON.parse(node.stdout);
  if (version !== NODE_VERSION) throw new Error(`the builtin names are measured on node ${NODE_VERSION}; this is ${version}`);
  return builtin;
}

/**
 * libuv's errors as Node reports them (util.getSystemErrorMap: errno, name,
 * message), measured on real node: what its uv binding's error map holds on
 * Linux, Nimbus's platform.
 */
function measureUvErrors() {
  const node = spawnSync('node', ['-e', 'console.log(JSON.stringify({ version: process.version, platform: process.platform, errors: [...require("util").getSystemErrorMap()].map(([errno, [name, message]]) => [errno, name, message]) }))'], { encoding: 'utf8' });
  if (node.status !== 0) throw new Error(`node: ${node.stderr}`);
  const { version, platform, errors } = JSON.parse(node.stdout);
  if (version !== NODE_VERSION || platform !== 'linux') throw new Error(`libuv's errors are measured on linux node ${NODE_VERSION}; this is ${platform} ${version}`);
  return errors;
}

const [primordials, eastAsianWidth, ...lib] = await Promise.all([
  fetchPinned(SOURCES.primordials), fetchPinned(SOURCES.eastAsianWidth),
  ...Object.entries(LIB).map(([id, sha256]) => fetchPinned({ url: libUrl(id), sha256 })),
]);
const sources = Object.fromEntries(Object.keys(LIB).map((id, i) => [id, lib[i]]));
const builtinObjects = measureBuiltinObjects();
const uvErrors = measureUvErrors();
const output = `/**
 * Node ${NODE_VERSION}'s own modules as Node runs them, over the primordials
 * lib/internal/per_context/primordials.js builds: upstream's text byte for
 * byte, each checked by its digest (NODE_LIB_SHA256;
 * tests/unit/node-inspect-matches-node.mjs):
${Object.keys(LIB).map((id) => ` *   ${libUrl(id)}`).join('\n')}
 *   ${SOURCES.primordials.url}
 *   sha256 ${SOURCES.primordials.sha256} (NODE_PRIMORDIALS_SHA256)
 * The shims evaluate each the first time a program needs it, over what
 * node-lib-host.ts gives them for Node's internal modules and bindings.
 * ${NODE_VERSION} is the release Nimbus's node reports and the tests' oracle
 * (core/constants.ts NODE_RELEASE).
 *
 * NODE_BUILTIN_OBJECTS, the names inspect.js counts as built-in, is measured
 * on node ${NODE_VERSION}: inspect.js reads them off the global object when Node
 * loads it, before Node adds its own globals. NODE_UV_ERRORS, libuv's error
 * map (util.getSystemErrorMap), is measured on the same node on linux.
 *
 * Node ${NODE_VERSION}'s SourceMap (lib/internal/source_map/source_map.js) keeps
 * its own Chromium BSD notice; the shims' --enable-source-maps reads maps with it.
 *
 * The East Asian Wide and Fullwidth code points, for the column width
 * Node's ICU build counts (src/node_i18n.cc GetColumnWidth), are the W and F
 * ranges of the Unicode Character Database of Node's ICU (78.2, Unicode ${UNICODE_VERSION}):
 *   ${SOURCES.eastAsianWidth.url}
 *   sha256 ${SOURCES.eastAsianWidth.sha256}
 *
 * Generated by scripts/vendor-node-lib.mjs; do not edit. Node.js: MIT,
 * Copyright Node.js contributors. Unicode data: Unicode License v3,
 * Copyright © 1991-2025 Unicode, Inc. (NOTICE.md, with the license text).
 */
/** Each module's sha256, by its id under lib/. */
export const NODE_LIB_SHA256: Readonly<Record<string, string>> = ${JSON.stringify(LIB, null, 2)};
/** Each module's text, by its id under lib/. */
export const NODE_LIB_SOURCES: Readonly<Record<string, string>> = {
${Object.entries(sources).map(([id, text]) => `  ${JSON.stringify(id)}: ${JSON.stringify(text)},`).join('\n')}
};
export const NODE_PRIMORDIALS_SHA256 = '${SOURCES.primordials.sha256}';
export const NODE_PRIMORDIALS_SOURCE: string = ${JSON.stringify(primordials)};
/** The names inspect.js counts as built-in on node ${NODE_VERSION}, measured. */
export const NODE_BUILTIN_OBJECTS: readonly string[] = ${JSON.stringify(builtinObjects)};
/** libuv's errors on linux node ${NODE_VERSION}, measured: [errno, name, message], in its map's order. */
export const NODE_UV_ERRORS: readonly (readonly [number, string, string])[] = ${JSON.stringify(uvErrors)};
/** The W and F ranges of EastAsianWidth.txt ${UNICODE_VERSION}, merged: \`first[-last]\` in hex, comma-separated, ascending. */
export const EAST_ASIAN_WIDE_RANGES = '${wideRanges(eastAsianWidth)}';
`;
if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf8');
  if (current !== output) {
    console.error(`vendor-node-lib: ${OUT} is not what the pinned inputs produce; run bun scripts/vendor-node-lib.mjs`);
    process.exit(1);
  }
  console.log('vendor-node-lib: up to date');
} else {
  writeFileSync(OUT, output);
  console.log(`vendor-node-lib: wrote ${OUT} (builtin objects: ${builtinObjects.join(', ')})`);
}
