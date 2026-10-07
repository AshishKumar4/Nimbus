// @serial
// @tier slow — drives a local workerd
// A program's import() can reach installed files its launch did not stage,
// and on its first run they load. A launch stages its static closure and a
// data plan; anything else on disk is known to the process's namespace but
// not held by its store, and a synchronous load cannot fetch it. import() is
// asynchronous, so it fetches first.
//
// Two shapes, both from first launches of dev servers on staging:
//   - Vite bundles a config at runtime to node_modules/.vite-temp under a
//     fresh name, then imports it; the config's imports are installed
//     packages the launch never reached (react-router's dev plugin, and
//     through it more).
//   - Vite's SSR module runner imports an externalised dependency by a
//     specifier computed at runtime (astro's server code: zod/v4).
// Before, each failed with "Cannot load module '…': it was not in this
// launch's module map; the next launch of the same command stages it", which
// a temp file named afresh each run never reaches.
//
// What the fetch finds is what the loader's own resolvers and parser find
// (review of 744835905): a file: URL's package scope (its module type) and a
// package reached through a link, read as resolution reads them; requests
// spelled in a template, with escapes, or after a comment; and a floating
// import(...).then(...) keeps the process until it has loaded.
import assert from 'node:assert/strict';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const W = '/home/user/late-import';
const FILES = {
  'package.json': '{"name":"late-import","type":"module"}',
  // An installed package the entry never names: ESM, a relative import, a
  // bare import of another package, and an exports map with a subpath.
  'node_modules/late-plugin/package.json': JSON.stringify({ name: 'late-plugin', type: 'module', exports: { '.': './dist/index.js', './v2': './dist/v2/index.js' } }),
  'node_modules/late-plugin/dist/index.js': 'import { helper } from "./helper.js";\nimport dep from "late-dep";\nexport const plugin = () => "plugin:" + helper + ":" + dep;\n',
  'node_modules/late-plugin/dist/helper.js': 'export const helper = "helper";\n',
  'node_modules/late-plugin/dist/v2/index.js': 'export * from "./schema.js";\n',
  'node_modules/late-plugin/dist/v2/schema.js': 'export const schema = "v2-schema";\n',
  // CommonJS, required from the ESM above through a bare specifier.
  'node_modules/late-dep/package.json': JSON.stringify({ name: 'late-dep', main: 'lib/main.js' }),
  'node_modules/late-dep/lib/main.js': 'module.exports = require("./value.js");\n',
  'node_modules/late-dep/lib/value.js': 'module.exports = "late-dep";\n',
  // Vite's config loading, reduced: the bundled config is written at runtime
  // under a fresh name and imported.
  'config.mjs': [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'import { pathToFileURL } from "node:url";',
    'const dir = path.resolve("node_modules/.vite-temp");',
    'fs.mkdirSync(dir, { recursive: true });',
    'const file = path.join(dir, "late.config.ts.timestamp-" + Date.now() + "-" + Math.random().toString(16).slice(2) + ".mjs");',
    // The package's name is never spelled in this file, as Vite's own code never spells a user's plugin.
    'const name = ["late", "plugin"].join("-");',
    'fs.writeFileSync(file, `import { plugin } from "${name}";\\nexport default { plugins: [plugin()] };\\n`);',
    'const config = (await import(pathToFileURL(file).href)).default;',
    'console.log("CONFIG " + config.plugins.join(","));',
  ].join('\n'),
  // An ES module by its file: URL, in a package whose type only its package.json says.
  'node_modules/late-scope/package.json': JSON.stringify({ name: 'late-scope', type: 'module' }),
  'node_modules/late-scope/lib/mod.js': 'export const scope = "esm-by-scope";\n',
  'scope.mjs': [
    'import path from "node:path";',
    'import { pathToFileURL } from "node:url";',
    'const file = path.resolve("node_modules", ["late", "scope"].join("-"), "lib/mod.js");',
    'const mod = await import(pathToFileURL(file).href);',
    'console.log("SCOPE " + mod.scope);',
  ].join('\n'),
  // A package installed as a link (a workspace's), its manifest only behind the link.
  'packages/linked/package.json': JSON.stringify({ name: 'late-linked', type: 'module', exports: './main.js' }),
  'packages/linked/main.js': 'export const linked = "linked";\n',
  'linked.mjs': 'const mod = await import(["late", "linked"].join("-"));\nconsole.log("LINKED " + mod.linked);\n',
  // Requests no pattern reads: after a comment, with escapes, in a template.
  'node_modules/late-mixed/package.json': JSON.stringify({ name: 'late-mixed', type: 'module', exports: './index.js' }),
  'node_modules/late-mixed/index.js': [
    'import a from /* where it comes from */ "late-cmt";',
    'import b from "\\u006cate-esc";',
    'import { createRequire } from "node:module";',
    'const require = createRequire(import.meta.url);',
    'const c = require(`late-tpl`);',
    'export default [a, b, c].join("+");',
  ].join('\n'),
  'node_modules/late-cmt/package.json': JSON.stringify({ name: 'late-cmt', main: 'index.js' }),
  'node_modules/late-cmt/index.js': 'module.exports = "cmt";\n',
  'node_modules/late-esc/package.json': JSON.stringify({ name: 'late-esc', main: 'index.js' }),
  'node_modules/late-esc/index.js': 'module.exports = "esc";\n',
  'node_modules/late-tpl/package.json': JSON.stringify({ name: 'late-tpl', main: 'index.js' }),
  'node_modules/late-tpl/index.js': 'module.exports = "tpl";\n',
  'mixed.mjs': 'const mod = await import(["late", "mixed"].join("-"));\nconsole.log("MIXED " + mod.default);\n',
  // A dual package: its import branch and its require branch differ, and a
  // static import in a module the loader evaluates late resolves as the
  // loader evaluates it (review of 1840bc205).
  'node_modules/late-dual/package.json': JSON.stringify({ name: 'late-dual', exports: { '.': { import: './esm.mjs', require: './cjs.cjs' } } }),
  'node_modules/late-dual/esm.mjs': 'export default "dual-esm";\n',
  'node_modules/late-dual/cjs.cjs': 'module.exports = "dual-cjs";\n',
  'node_modules/late-dualuser/package.json': JSON.stringify({ name: 'late-dualuser', type: 'module', exports: './index.js' }),
  'node_modules/late-dualuser/index.js': 'import dual from "late-dual";\nexport default dual;\n',
  'dual.mjs': 'const mod = await import(["late", "dualuser"].join("-"));\nconsole.log("DUAL " + mod.default);\n',
  // The program's own miss, made before the prefetch reads the same file:
  // the prefetch's read never answers it (review of 1840bc205).
  'node_modules/late-kept/package.json': JSON.stringify({ name: 'late-kept', type: 'module', exports: './index.js' }),
  'node_modules/late-kept/index.js': 'export const kept = "kept";\n',
  'kept.mjs': [
    'import fs from "node:fs";',
    'const name = ["late", "kept"].join("-");',
    'let read = "read";',
    'try { fs.readFileSync("node_modules/" + name + "/package.json", "utf8"); } catch (e) { read = e.code; }',
    'const mod = await import(name);',
    'console.log("KEPT " + read + " " + mod.kept);',
  ].join('\n'),
  // A package a late require reaches through a link (review of 1840bc205).
  'packages/linkedcjs/package.json': JSON.stringify({ name: 'late-linkedcjs', main: 'main.js' }),
  'packages/linkedcjs/main.js': 'module.exports = "linked-cjs";\n',
  'node_modules/late-cjsuser/package.json': JSON.stringify({ name: 'late-cjsuser', main: 'index.js' }),
  'node_modules/late-cjsuser/index.js': 'module.exports = require("late-linkedcjs");\n',
  'linkedcjs.mjs': 'const mod = await import(["late", "cjsuser"].join("-"));\nconsole.log("LINKEDCJS " + mod.default);\n',
  // A floating import: nothing awaits it, and the process stays until it has loaded.
  'node_modules/late-float/package.json': JSON.stringify({ name: 'late-float', type: 'module', exports: './index.js' }),
  'node_modules/late-float/index.js': 'import { part } from "./part.js";\nexport const value = "float:" + part;\n',
  'node_modules/late-float/part.js': 'export const part = "part";\n',
  'floating.mjs': 'import(["late", "float"].join("-")).then((mod) => console.log("FLOAT " + mod.value));\n',
  // An SSR runner's externalised import: a package subpath by a computed specifier.
  'runner.mjs': [
    'const specifier = ["late", "plugin"].join("-") + "/v2";',
    'const mod = await import(specifier);',
    'console.log("RUNNER " + mod.schema);',
  ].join('\n'),
};

const probe = await startLocalProbe({ runtimes: [] });
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    const payload = Buffer.from(JSON.stringify(FILES)).toString('base64');
    const setup = await terminal.run(
      `node -e "const f=JSON.parse(Buffer.from('${payload}','base64').toString());const p=require('path');for(const [n,t] of Object.entries(f)){require('fs').mkdirSync(p.dirname('${W}/'+n),{recursive:true});require('fs').writeFileSync('${W}/'+n,t)}console.log('SETUP')"`,
    );
    assert.equal(setup.status, 0, setup.stdout);
    assert.match(setup.stdout, /^SETUP$/m);
    const link = await terminal.run(`ln -s ../packages/linked ${W}/node_modules/late-linked && ln -s ../packages/linkedcjs ${W}/node_modules/late-linkedcjs && echo LINKED`);
    assert.match(link.stdout, /^LINKED$/m, link.stdout);

    const config = await terminal.run(`cd ${W} && node config.mjs`);
    assert.match(config.stdout, /^CONFIG plugin:helper:late-dep$/m, `a runtime-written module's installed imports load on the first run:\n${config.stdout}`);
    assert.equal(config.status, 0, config.stdout);

    const runner = await terminal.run(`cd ${W} && node runner.mjs`);
    assert.match(runner.stdout, /^RUNNER v2-schema$/m, `a computed import() of an installed package subpath loads on the first run:\n${runner.stdout}`);
    assert.equal(runner.status, 0, runner.stdout);

    const cases = [
      ['scope.mjs', /^SCOPE esm-by-scope$/m, "a file: URL's package scope is read before the load decides its module type"],
      ['linked.mjs', /^LINKED linked$/m, 'a package reached through a link resolves with its manifest behind the link'],
      ['mixed.mjs', /^MIXED cmt\+esc\+tpl$/m, 'requests after a comment, with escapes and in a template are fetched'],
      ['floating.mjs', /^FLOAT float:part$/m, 'a floating import() keeps the process until it has loaded'],
      ['dual.mjs', /^DUAL dual-(?:cjs|esm)$/m, "a late module's static import of a dual package loads the branch its evaluation resolves"],
      ['linkedcjs.mjs', /^LINKEDCJS linked-cjs$/m, 'a late require of a package installed as a link loads'],
    ];
    for (const [entry, expected, what] of cases) {
      const run = await terminal.run(`cd ${W} && node ${entry}`);
      assert.match(run.stdout, expected, `${what}, on the first run:\n${run.stdout}`);
      assert.equal(run.status, 0, `${entry}: ${run.stdout}`);
    }

    // The program missed late-kept's package.json itself, and carried on; the
    // prefetch's own later read of it does not answer that miss, so the exit
    // report still names it, as it names any read the program was refused.
    const kept = await terminal.run(`cd ${W} && node kept.mjs`);
    assert.match(kept.stdout, /^KEPT EAGAIN kept$/m, kept.stdout);
    assert.match(kept.stdout, /read synchronously but their content was never staged[\s\S]*late-kept\/package\.json/, `the program's own miss stays in its exit report:\n${kept.stdout}`);
    assert.notEqual(kept.status, 0, kept.stdout);
  } finally {
    await terminal.close();
  }
} finally {
  await probe.stop();
}
console.log('runtime-import-unstaged-workerd: installed modules an import() reaches load on the first run');
