#!/usr/bin/env bun
// A generated config can import an already compiled lazy module. Being in
// the code map does not mean the module's synchronous data is resident: its
// lazy-read plan must still be applied before that config evaluates it.
import assert from 'node:assert/strict';
import { rewriteDynamicImports } from '../../packages/core/src/runtime/dynamic-import-rewrite.ts';
import { createAuthority, facetSupervisor, launchResident, runScenarios, until } from './lib/resident-body.mjs';

await runScenarios(import.meta.filename, {
  async generatedConfigLoadsStagedLazyModuleData() {
    const root = 'home/user/app';
    const lazy = `${root}/node_modules/lazy/index.cjs`;
    const data = `${root}/node_modules/lazy/seed.wasm`;
    const files = {
      [lazy]: 'exports.size = require("fs").readFileSync(__dirname + "/seed.wasm").length;',
      [data]: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    };
    const authority = createAuthority();
    authority.kfs.mkdir(`${root}/node_modules/lazy`, { recursive: true, mode: 0o755 });
    for (const [path, bytes] of Object.entries(files)) authority.kfs.writeFile(path, bytes);
    // This generator-level harness has no manager-owned command image in
    // which to keep generated code; the test owns that report instead.
    const generatedCode = [];
    const { supervisor, log } = facetSupervisor(authority, {
      reportRuntimeCode: async (entries) => { generatedCode.push(...entries); },
    });
    const program = `
require("fs").writeFileSync("./late-config.cjs", "module.exports = require('./node_modules/lazy/index.cjs');");
import("./late-config.cjs").then((config) => {
  console.log("loaded " + config.default.size);
  require("http").createServer((req, res) => res.end("loaded " + config.default.size)).listen(5173);
}, (error) => console.error(error));
`;
    const { proc } = await launchResident({
      authority,
      cursor: authority.cursor(),
      env: { SUPERVISOR: supervisor },
      bundle: { [lazy]: files[lazy] },
      // The data is intentionally lazy, as the manager plans a module that
      // the CLI only imports when loading its generated configuration.
      dataPlan: [],
      startArgs: { lazyReads: { [lazy]: [data] } },
      program: rewriteDynamicImports(program, `file:///${root}/main.js`),
    });
    await until(() => log.ports.has(5173) || log.exit !== null, 'the listener after the generated config', 5000).catch((error) => {
      throw new Error(`${error.message}; output=${JSON.stringify({ stdout: log.stdout, stderr: log.stderr, exit: log.exit })}`);
    });
    assert.equal(log.exit, null, JSON.stringify({ stdout: log.stdout, stderr: log.stderr, exit: log.exit }));
    const response = await proc.fetch(new Request('http://facet/', { headers: { 'X-Nimbus-Port': '5173' } }));
    assert.equal(await response.text(), 'loaded 8');
    assert.equal(log.stdout, 'loaded 8\n');
    assert.equal(log.stderr, '');
    assert.equal(log.exit, null);
  },
});
console.log('resident-late-import-lazy-data: ok');
