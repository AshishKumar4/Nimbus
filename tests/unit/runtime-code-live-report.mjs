#!/usr/bin/env bun
// A live process reports what it learned while it runs (a server never exits).
// That report must wait for the residency repairs in flight and send only the
// misses they did not prove absent: a path the authority does not have was
// the program's not-found branch, and learning it made every later launch
// stage a file that does not exist. The parts stay apart: modules the
// program executed and files it read are separate lists.
import assert from 'node:assert/strict';
import { COMMONJS_CELL_IMPORTS, COMMONJS_CELL_RUNTIME_SOURCE } from '../../packages/core/src/_shared/commonjs-cell.ts';
import { importModuleSet } from './lib/module-map-bundle.mjs';

const { flush } = await importModuleSet({
  'main.js': `${COMMONJS_CELL_IMPORTS}
const __NIMBUS_CODE_CELLS = [];
const __NIMBUS_RUNTIME_CODE = [];
${COMMONJS_CELL_RUNTIME_SOURCE}
export const flush = __nimbusFlushRuntimeCode;`,
}, 'main.js');

// The shims' residency ledger and its settle, as node-shims.ts publishes them:
// the repair of `absent` is in flight and proves it absent when it lands.
globalThis.__nimbusVfsResidencyMisses = new Set(['home/user/present.txt', 'home/user/absent.txt']);
globalThis.__nimbusModuleMisses = new Set(['home/user/node_modules/late/index.js']);
globalThis.__nimbusVfsResidencySettle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  globalThis.__nimbusVfsResidencyMisses.delete('home/user/absent.txt');
};
const reports = [];
await flush({ async reportRuntimeCode(entries, executedModules, dataReads) { reports.push({ entries, executedModules, dataReads }); } });
assert.deepEqual(reports, [{
  entries: [],
  executedModules: ['home/user/node_modules/late/index.js'],
  dataReads: ['home/user/present.txt'],
}], 'settled first; executed modules and data reads reported apart');
delete globalThis.__nimbusVfsResidencyMisses;
delete globalThis.__nimbusModuleMisses;
delete globalThis.__nimbusVfsResidencySettle;
console.log('runtime-code-live-report: ok');
