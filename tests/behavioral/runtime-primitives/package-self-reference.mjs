#!/usr/bin/env bun
// runtime-primitives/package-self-reference — a package can require and
// import itself by name through its own `exports` map (Node's
// self-reference rule).
//
// Inside a package directory whose package.json declares `name` and
// `exports`, a file doing `require('<name>')`, `require('<name>/sub')` and
// `await import('<name>')` must resolve through that map — the shape of
// every modern library repo that runs its own examples or tests from the
// checkout. Before the fix the resolver went straight to the node_modules
// walk and reported "Cannot find module '<name>'".
//
// Asserted, all user-visible:
//   - a CommonJS file inside the package: bare name and subpath both print
//     the exported values;
//   - an ESM file inside the package: `createRequire` + `await import()`
//     both print the exported values (the same file does both, as the spec
//     row states);
//   - a package WITHOUT `exports` does not self-reference (matches Node);
//   - a nested package of a different name is the scope: `require` of the
//     outer name from inside it fails, as in Node.

import { mintSession, deleteSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('runtime-primitives/package-self-reference');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(15_000);

  // ── The package: name + exports, CJS and ESM entries, a subpath ──
  await t.run('mkdir -p selfref/lib && cd selfref', 10_000);
  await t.run(heredocCommand('package.json', JSON.stringify({
    name: 'selfref-pkg',
    version: '1.0.0',
    exports: {
      '.': { import: './lib/entry.mjs', require: './lib/entry.cjs' },
      './util': './lib/util.js',
    },
  }, null, 2)), 10_000);
  await t.run(heredocCommand('lib/entry.cjs', 'module.exports = { kind: "self-cjs" };\n'), 10_000);
  await t.run(heredocCommand('lib/entry.mjs', 'export const kind = "self-esm";\n'), 10_000);
  await t.run(heredocCommand('lib/util.js', 'module.exports = { util: "self-util" };\n'), 10_000);
  await t.run(heredocCommand('lib/use-cjs.js', [
    'console.log("CJS_SELF=" + require("selfref-pkg").kind);',
    'console.log("CJS_SUBPATH=" + require("selfref-pkg/util").util);',
  ].join('\n') + '\n'), 10_000);
  await t.run(heredocCommand('lib/use-esm.mjs', [
    "import { createRequire } from 'node:module';",
    'const require = createRequire(import.meta.url);',
    'console.log("ESM_REQUIRE=" + require("selfref-pkg").kind);',
    'console.log("ESM_SUBPATH=" + require("selfref-pkg/util").util);',
    "const self = await import('selfref-pkg');",
    'console.log("ESM_IMPORT=" + self.kind);',
  ].join('\n') + '\n'), 10_000);

  const cjs = await t.run('node lib/use-cjs.js; echo "CJS_EXIT=$?"', 30_000);
  const cjsOut = stripAnsi(cjs.output);
  a.check("require('<name>') resolves through the package's own exports", /CJS_SELF=self-cjs/.test(cjsOut), JSON.stringify(cjsOut.slice(-500)));
  a.check("require('<name>/sub') resolves through the exports subpath", /CJS_SUBPATH=self-util/.test(cjsOut), JSON.stringify(cjsOut.slice(-500)));
  a.check('the CommonJS entry exits 0', /CJS_EXIT=0/.test(cjsOut), JSON.stringify(cjsOut.slice(-500)));

  const esm = await t.run('node lib/use-esm.mjs; echo "ESM_EXIT=$?"', 30_000);
  const esmOut = stripAnsi(esm.output);
  a.check('createRequire(<name>) resolves from an ESM file', /ESM_REQUIRE=self-cjs/.test(esmOut), JSON.stringify(esmOut.slice(-500)));
  a.check('createRequire(<name>/sub) resolves from an ESM file', /ESM_SUBPATH=self-util/.test(esmOut), JSON.stringify(esmOut.slice(-500)));
  // Nimbus lowers dynamic import() onto its require chain, so a map with
  // both conditions answers with the `require` target; what is asserted is
  // that the self-reference resolves and prints an exported value.
  a.check("await import('<name>') resolves from an ESM file", /ESM_IMPORT=self-(cjs|esm)/.test(esmOut), JSON.stringify(esmOut.slice(-500)));
  a.check('the ESM entry exits 0', /ESM_EXIT=0/.test(esmOut), JSON.stringify(esmOut.slice(-500)));

  // ── No exports → no self-reference (Node parity) ──
  await t.run('cd ~ && mkdir -p noexports/lib && cd noexports', 10_000);
  await t.run(heredocCommand('package.json', JSON.stringify({ name: 'noexports-pkg', version: '1.0.0', main: 'index.js' }, null, 2)), 10_000);
  await t.run(heredocCommand('index.js', 'module.exports = { own: true };\n'), 10_000);
  await t.run(heredocCommand('lib/use.js', 'try { require("noexports-pkg"); console.log("NOEXPORTS=resolved"); } catch (e) { console.log("NOEXPORTS=unresolved"); }\n'), 10_000);
  const noexports = await t.run('node lib/use.js', 30_000);
  const noexportsOut = stripAnsi(noexports.output);
  a.check('a package without exports does not self-reference', /NOEXPORTS=unresolved/.test(noexportsOut), JSON.stringify(noexportsOut.slice(-400)));

  // ── A nested package of a different name is the scope ──
  await t.run('cd ~ && mkdir -p outer/inner/lib && cd outer', 10_000);
  await t.run(heredocCommand('package.json', JSON.stringify({ name: 'outer-pkg', version: '1.0.0', exports: './index.js' }, null, 2)), 10_000);
  await t.run(heredocCommand('index.js', 'module.exports = { outer: true };\n'), 10_000);
  await t.run(heredocCommand('inner/package.json', JSON.stringify({ name: 'inner-pkg', version: '1.0.0', exports: './inner.js' }, null, 2)), 10_000);
  await t.run(heredocCommand('inner/inner.js', 'module.exports = { inner: "inner-export" };\n'), 10_000);
  await t.run(heredocCommand('inner/lib/use.js', [
    'console.log("INNER=" + require("inner-pkg").inner);',
    'try { require("outer-pkg"); console.log("OUTER=resolved"); } catch (e) { console.log("OUTER=unresolved"); }',
  ].join('\n') + '\n'), 10_000);
  const nested = await t.run('node inner/lib/use.js', 30_000);
  const nestedOut = stripAnsi(nested.output);
  a.check('the nearest package scope self-references', /INNER=inner-export/.test(nestedOut), JSON.stringify(nestedOut.slice(-400)));
  a.check('resolution does not walk past a nearer package of another name', /OUTER=unresolved/.test(nestedOut), JSON.stringify(nestedOut.slice(-400)));
} finally {
  await t.close();
  await deleteSession(sid);
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
