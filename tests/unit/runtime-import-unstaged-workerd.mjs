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

    const config = await terminal.run(`cd ${W} && node config.mjs`);
    assert.match(config.stdout, /^CONFIG plugin:helper:late-dep$/m, `a runtime-written module's installed imports load on the first run:\n${config.stdout}`);
    assert.equal(config.status, 0, config.stdout);

    const runner = await terminal.run(`cd ${W} && node runner.mjs`);
    assert.match(runner.stdout, /^RUNNER v2-schema$/m, `a computed import() of an installed package subpath loads on the first run:\n${runner.stdout}`);
    assert.equal(runner.status, 0, runner.stdout);
  } finally {
    await terminal.close();
  }
} finally {
  await probe.stop();
}
console.log('runtime-import-unstaged-workerd: installed modules an import() reaches load on the first run');
