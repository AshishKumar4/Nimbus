#!/usr/bin/env bun
// runtime-primitives/npm-swap-alias-placement — a registry swap installs
// under the DECLARED name, as the npm alias it is.
//
// `npm install esbuild` swaps the native package for esbuild-wasm. The swap
// used to rename the spec to the target, so the package landed in
// node_modules/esbuild-wasm and `require('esbuild')` — the name every
// consumer's code uses — did not resolve. A swap is semantically
// `esbuild@npm:esbuild-wasm@<range>`; expressed that way, the target lands
// in node_modules/esbuild exactly where `npm install esbuild@npm:esbuild-wasm`
// would put it, and require, import, the bin link and the lockfile all see
// the declared name.
//
// Asserted, all user-visible:
//   - the install announces the swap once and exits 0;
//   - node_modules/esbuild exists and node_modules/esbuild-wasm does not;
//   - `require('esbuild').version` prints a version;
//   - dynamic `import('esbuild')` from an ESM entry resolves the same
//     package (Nimbus lowers `import()` in ESM sources onto its require
//     chain — tests/behavioral/module-format/dynamic-import.mjs);
//   - `npx esbuild --version` still runs and node_modules/.bin/esbuild exists;
//   - package.json records `esbuild`, not the swap target.

import { mintSession, deleteSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('runtime-primitives/npm-swap-alias-placement');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(15_000);

  await t.run('mkdir -p swap-probe && cd swap-probe', 10_000);
  await t.run(heredocCommand('package.json', JSON.stringify({ name: 'swap-probe', version: '1.0.0' }, null, 2)), 10_000);

  const install = await t.run('npm install esbuild; echo "INSTALL_EXIT=$?"', 240_000);
  const installOut = stripAnsi(install.output);
  a.check('npm install esbuild exits 0', /INSTALL_EXIT=0/.test(installOut), JSON.stringify(installOut.slice(-600)));
  a.check('the swap is announced', /\[swap\] esbuild → esbuild-wasm/.test(installOut), JSON.stringify(installOut.slice(-600)));
  a.check('the swap is announced exactly once',
    (installOut.match(/\[swap\] esbuild → esbuild-wasm/g) || []).length === 1, JSON.stringify(installOut.slice(-900)));

  const layout = await t.run(
    'test -f node_modules/esbuild/package.json && echo LAYOUT_DECLARED=yes || echo LAYOUT_DECLARED=no; '
    + 'test -e node_modules/esbuild-wasm && echo LAYOUT_TARGET=present || echo LAYOUT_TARGET=absent; '
    + 'test -e node_modules/.bin/esbuild && echo BIN_LINK=yes || echo BIN_LINK=no',
    15_000,
  );
  const layoutOut = stripAnsi(layout.output);
  a.check('node_modules/esbuild is the install directory', /LAYOUT_DECLARED=yes/.test(layoutOut), JSON.stringify(layoutOut.slice(-400)));
  a.check('nothing lands under node_modules/esbuild-wasm', /LAYOUT_TARGET=absent/.test(layoutOut), JSON.stringify(layoutOut.slice(-400)));
  a.check('node_modules/.bin/esbuild is linked', /BIN_LINK=yes/.test(layoutOut), JSON.stringify(layoutOut.slice(-400)));

  const req = await t.run(
    'node -e "const e=require(\'esbuild\'); console.log(\'REQUIRE_VERSION=\'+e.version); console.log(\'REQUIRE_PKG=\'+require(\'esbuild/package.json\').name)"',
    30_000,
  );
  const reqOut = stripAnsi(req.output);
  a.check("require('esbuild').version resolves", /REQUIRE_VERSION=\d+\.\d+\.\d+/.test(reqOut), JSON.stringify(reqOut.slice(-400)));
  a.check('the package under the declared name is the swap target', /REQUIRE_PKG=esbuild-wasm/.test(reqOut), JSON.stringify(reqOut.slice(-400)));

  await t.run(heredocCommand('use-import.mjs', [
    "const m = await import('esbuild');",
    "console.log('IMPORT_VERSION=' + m.version);",
  ].join('\n') + '\n'), 10_000);
  const imp = await t.run('node use-import.mjs', 30_000);
  const impOut = stripAnsi(imp.output);
  a.check("dynamic import('esbuild') resolves from an ESM entry", /IMPORT_VERSION=\d+\.\d+\.\d+/.test(impOut), JSON.stringify(impOut.slice(-400)));

  const npx = await t.run('npx esbuild --version; echo "NPX_EXIT=$?"', 60_000);
  const npxOut = stripAnsi(npx.output);
  a.check('npx esbuild --version runs', /NPX_EXIT=0/.test(npxOut) && /\d+\.\d+\.\d+/.test(npxOut), JSON.stringify(npxOut.slice(-400)));

  const pkg = await t.run('cat package.json', 10_000);
  const pkgOut = stripAnsi(pkg.output);
  a.check('package.json records esbuild under the declared name', /"esbuild":\s*"\^?\d/.test(pkgOut), JSON.stringify(pkgOut.slice(-400)));
  a.check('package.json is not rewritten to the swap target', !/"esbuild-wasm"/.test(pkgOut), JSON.stringify(pkgOut.slice(-400)));
} finally {
  await t.close();
  await deleteSession(sid);
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
