#!/usr/bin/env bun
// scripts/vendor-node-inspect.mjs — regenerate
// packages/worker/src/runtime/node-inspect-source.ts, the node shims' vendored
// Node inspect (node-inspect-host.ts says how it runs):
//
//   bun scripts/vendor-node-inspect.mjs           write the file
//   bun scripts/vendor-node-inspect.mjs --check   exit 1 unless the file is what it would write
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
const SOURCES = {
  inspect: {
    url: `https://raw.githubusercontent.com/nodejs/node/${NODE_VERSION}/lib/internal/util/inspect.js`,
    sha256: '2f2f01d7077800f8565d1be2bd1e6800f8ac02759482dc080eb6bc6005d67dd1',
  },
  primordials: {
    url: `https://raw.githubusercontent.com/nodejs/node/${NODE_VERSION}/lib/internal/per_context/primordials.js`,
    sha256: '9e3fe2fe051667172d6ed9d997eee99b3454a7e4ec779dd63c1f19d44b25b1ca',
  },
  eastAsianWidth: {
    url: `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd/EastAsianWidth.txt`,
    sha256: 'ea7ce50f3444a050333448dffef1cadd9325af55cbb764b4a2280faf52170a33',
  },
};
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages/worker/src/runtime/node-inspect-source.ts');

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

const [inspect, primordials, eastAsianWidth] = await Promise.all([
  fetchPinned(SOURCES.inspect), fetchPinned(SOURCES.primordials), fetchPinned(SOURCES.eastAsianWidth),
]);
const builtinObjects = measureBuiltinObjects();
const output = `/**
 * Node ${NODE_VERSION}'s util.inspect as Node runs it: lib/internal/util/inspect.js,
 * over the primordials lib/internal/per_context/primordials.js builds. Both
 * are upstream's text byte for byte, each checked by its digest
 * (tests/unit/node-inspect-matches-node.mjs):
 *   ${SOURCES.inspect.url}
 *   sha256 ${SOURCES.inspect.sha256} (NODE_INSPECT_SHA256)
 *   ${SOURCES.primordials.url}
 *   sha256 ${SOURCES.primordials.sha256} (NODE_PRIMORDIALS_SHA256)
 * The shims evaluate them once, the first time a program formats a value
 * (node-shims.ts, "util.inspect"), over what node-inspect-host.ts gives them
 * for Node's internal modules and bindings. ${NODE_VERSION} is the release Nimbus's
 * node reports and the tests' oracle (core/constants.ts NODE_RELEASE).
 *
 * NODE_BUILTIN_OBJECTS, the names inspect.js counts as built-in, is measured
 * on node ${NODE_VERSION}: inspect.js reads them off the global object when Node
 * loads it, before Node adds its own globals.
 *
 * The East Asian Wide and Fullwidth code points, for the column width
 * Node's ICU build counts (src/node_i18n.cc GetColumnWidth), are the W and F
 * ranges of the Unicode Character Database of Node's ICU (78.2, Unicode ${UNICODE_VERSION}):
 *   ${SOURCES.eastAsianWidth.url}
 *   sha256 ${SOURCES.eastAsianWidth.sha256}
 *
 * Generated by scripts/vendor-node-inspect.mjs; do not edit. Node.js: MIT,
 * Copyright Node.js contributors. Unicode data: Unicode License v3,
 * Copyright © 1991-2025 Unicode, Inc. (NOTICE.md, with the license text).
 */
export const NODE_INSPECT_SHA256 = '${SOURCES.inspect.sha256}';
export const NODE_INSPECT_SOURCE: string = ${JSON.stringify(inspect)};
export const NODE_PRIMORDIALS_SHA256 = '${SOURCES.primordials.sha256}';
export const NODE_PRIMORDIALS_SOURCE: string = ${JSON.stringify(primordials)};
/** The names inspect.js counts as built-in on node ${NODE_VERSION}, measured. */
export const NODE_BUILTIN_OBJECTS: readonly string[] = ${JSON.stringify(builtinObjects)};
/** The W and F ranges of EastAsianWidth.txt ${UNICODE_VERSION}, merged: \`first[-last]\` in hex, comma-separated, ascending. */
export const EAST_ASIAN_WIDE_RANGES = '${wideRanges(eastAsianWidth)}';
`;
if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf8');
  if (current !== output) {
    console.error(`vendor-node-inspect: ${OUT} is not what the pinned inputs produce; run bun scripts/vendor-node-inspect.mjs`);
    process.exit(1);
  }
  console.log('vendor-node-inspect: up to date');
} else {
  writeFileSync(OUT, output);
  console.log(`vendor-node-inspect: wrote ${OUT} (builtin objects: ${builtinObjects.join(', ')})`);
}
