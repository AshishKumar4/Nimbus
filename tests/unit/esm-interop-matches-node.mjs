// @serial
// ES module / CommonJS interop in a Nimbus node guest matches real Node's.
//
// Nimbus lowers every ES module to a CommonJS cell, so both directions of
// interop are Nimbus's to get right, and the rules are Node's
// (https://nodejs.org/api/esm.html#commonjs-namespaces and
// https://nodejs.org/api/modules.html#loading-ecmascript-modules-using-require):
//   - an ES module importing CommonJS gets module.exports as its default
//     export, always — `__esModule` does not make `import d` read
//     `exports.default` — and the exports' names as named exports;
//   - an ES module importing an ES module gets its default and named exports;
//   - require(esm) returns the module namespace object;
//   - a dynamic import() of CommonJS resolves to the same namespace shape.
//
// Differential: the corpus runs under the host's real `node` and as a
// Nimbus guest on local workerd (lib/workerd-probe.mjs, the worker built in
// the tree: rebuild generated artifacts first). The two outputs must be equal.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const describe = `
export function describe(value) {
  if (value === undefined) return 'undefined';
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return typeof value + ':' + String(value);
  const keys = Object.keys(value).sort();
  return (typeof value === 'function' ? 'function:' + value.name : 'object') + '{' + keys.join(',') + '}';
}
`;

const FILES = {
  'package.json': '{"name":"interop","private":true}\n',
  'describe.mjs': describe,
  // CommonJS without __esModule: a function with a property.
  'plain.cjs': 'module.exports = function plain() { return "p"; };\nmodule.exports.named = "plain-named";\n',
  // CommonJS as TypeScript/Babel emit it: __esModule plus exports.default.
  'marked.cjs': 'Object.defineProperty(exports, "__esModule", { value: true });\nexports.default = "marked-default";\nexports.named = "marked-named";\n',
  // A CommonJS object of names only.
  'names.cjs': 'exports.a = 1;\nexports.b = 2;\n',
  'esm.mjs': 'export default "esm-default";\nexport const named = "esm-named";\n',
  'esm-no-default.mjs': 'export const only = "only";\n',
  'reexport.mjs': 'export * from "./names.cjs";\nexport { default as plainDefault, named as plainNamed } from "./plain.cjs";\nexport { default as esmDefault } from "./esm.mjs";\n',
  'main.mjs': [
    'import { describe } from "./describe.mjs";',
    'import plain, { named as plainNamed } from "./plain.cjs";',
    'import * as plainNs from "./plain.cjs";',
    'import marked, { named as markedNamed } from "./marked.cjs";',
    'import * as markedNs from "./marked.cjs";',
    'import names, { a } from "./names.cjs";',
    'import esm, { named as esmNamed } from "./esm.mjs";',
    'import * as esmNs from "./esm.mjs";',
    'import * as re from "./reexport.mjs";',
    'import { createRequire } from "node:module";',
    'const require = createRequire(import.meta.url);',
    'const out = {',
    '  plainDefault: describe(plain), plainIsExports: plain === require("./plain.cjs"), plainNamed,',
    '  plainNs: describe(plainNs), plainNsDefault: plainNs.default === plain,',
    '  markedDefault: describe(marked), markedIsExports: marked === require("./marked.cjs"), markedNamed,',
    '  markedNs: describe(markedNs), markedNsDefault: describe(markedNs.default),',
    '  namesDefault: describe(names), a,',
    '  esmDefault: esm, esmNamed, esmNs: describe(esmNs),',
    '  reexport: describe(re), reA: re.a, rePlainDefault: re.plainDefault === plain, rePlainNamed: re.plainNamed, reEsmDefault: re.esmDefault,',
    '};',
    'const requiredEsm = require("./esm.mjs");',
    'out.requireEsm = describe(requiredEsm);',
    'out.requireEsmDefault = requiredEsm.default;',
    'out.requireEsmMarked = requiredEsm.__esModule;',
    'const requiredNoDefault = require("./esm-no-default.mjs");',
    'out.requireNoDefault = describe(requiredNoDefault);',
    'out.requireNoDefaultMarked = requiredNoDefault.__esModule;',
    'const dynPlain = await import("./plain.cjs");',
    'out.dynPlain = describe(dynPlain); out.dynPlainDefault = dynPlain.default === plain; out.dynPlainNamed = dynPlain.named;',
    'const dynMarked = await import("./marked.cjs");',
    'out.dynMarked = describe(dynMarked); out.dynMarkedDefault = describe(dynMarked.default);',
    'const dynEsm = await import("./esm.mjs");',
    'out.dynEsm = describe(dynEsm); out.dynEsmDefault = dynEsm.default;',
    'console.log("INTEROP " + JSON.stringify(out));',
  ].join('\n'),
  // A CommonJS consumer of an ES module and of TS-style interop.
  'consumer.cjs': [
    'const esm = require("./esm.mjs");',
    'const interopDefault = (m) => (m && m.__esModule ? m.default : m);',
    'console.log("CJS " + JSON.stringify({ viaInterop: interopDefault(esm), named: esm.named, markedViaInterop: interopDefault(require("./marked.cjs")) }));',
  ].join('\n'),
};

function interopLines(stdout) {
  return stdout.split('\n').filter((line) => /^(INTEROP|CJS) /.test(line));
}

// ── Oracle: real node ─────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'nimbus-esm-interop-'));
let expected;
try {
  for (const [name, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  const lines = [];
  for (const entry of ['main.mjs', 'consumer.cjs']) {
    const run = spawnSync('node', [entry], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, `node ${entry}:\n${run.stderr}`);
    lines.push(...interopLines(run.stdout));
  }
  expected = lines;
  assert.equal(expected.length, 2, `node printed both results: ${expected}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ── Nimbus: the same corpus as a guest ────────────────────────────────────
const W = '/home/user/interop';
const probe = await startLocalProbe();
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    const payload = Buffer.from(JSON.stringify(FILES)).toString('base64');
    const setup = await terminal.run(
      `mkdir -p ${W} && node -e "const f = JSON.parse(Buffer.from('${payload}', 'base64').toString()); for (const [n, t] of Object.entries(f)) require('fs').writeFileSync('${W}/' + n, t); console.log('SETUP')"`,
    );
    assert.match(setup.stdout, /SETUP/, setup.stdout);
    const actual = [];
    for (const entry of ['main.mjs', 'consumer.cjs']) {
      const run = await terminal.run(`cd ${W} && node ${entry}`, 120_000);
      assert.equal(run.status, 0, `nimbus node ${entry}:\n${run.stdout}`);
      actual.push(...interopLines(run.stdout));
    }
    const parse = (lines) => lines.map((line) => [line.slice(0, line.indexOf(' ')), JSON.parse(line.slice(line.indexOf(' ') + 1))]);
    assert.deepEqual(parse(actual), parse(expected));
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('esm-interop-matches-node: default, named, namespace, re-export, require(esm) and dynamic import agree with node');
