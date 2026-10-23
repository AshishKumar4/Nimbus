#!/usr/bin/env bun
// A live process reports what it learned while it runs (a server never exits).
// That report must wait for the residency repairs in flight and send only the
// misses they did not prove absent: a path the authority does not have was
// the program's not-found branch, and learning it made every later launch
// stage a file that does not exist. The parts stay apart: modules the
// program executed and files it read are separate lists.
import assert from 'node:assert/strict';
import {
  COMMONJS_CELL_IMPORTS, COMMONJS_CELL_RUNTIME_SOURCE, RUNTIME_INTERPRETER_PRIMORDIALS_MODULE,
} from '../../packages/core/src/_shared/commonjs-cell.ts';
import { importModuleSet } from './lib/module-map-bundle.mjs';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';
import { createAuthority } from './lib/resident-body.mjs';
import { sessionShims } from './lib/session-shims.mjs';

const { flush } = await importModuleSet({
  'main.js': `${COMMONJS_CELL_IMPORTS}
const __NIMBUS_CODE_CELLS = [];
const __NIMBUS_RUNTIME_CODE = [];
${COMMONJS_CELL_RUNTIME_SOURCE}
export const flush = __nimbusFlushRuntimeCode;`,
  // The runtime loads the interpreter's primordials at its start.
  [RUNTIME_INTERPRETER_PRIMORDIALS_MODULE]: { cjs: nodeFacetSources('').interpreterPrimordials },
}, 'main.js');

// The process's filesystem, started over a session: a read it is refused is
// its miss until a fault-in lands or the session says the name is gone.
const authority = createAuthority();
authority.kfs.writeFile('home/user/present.txt', 'present');
authority.kfs.writeFile('home/user/absent.txt', 'absent');
const { fs, rf } = sessionShims(authority, { cwd: '/home/user', tail: ';return { fs: __fsMod };' });
globalThis.__nimbusModuleMisses = new Set(['home/user/node_modules/late/index.js']);

// Both reads are refused, and both fault-ins are out when the session deletes one of them.
assert.throws(() => fs.readFileSync('/home/user/present.txt'), { code: 'EAGAIN' });
assert.throws(() => fs.readFileSync('/home/user/absent.txt'), { code: 'EAGAIN' });
authority.kfs.unlink('home/user/absent.txt');
await rf.catchUp();

const reports = [];
await flush({ async reportRuntimeCode(entries, executedModules, dataReads) { reports.push({ entries, executedModules, dataReads }); } });
assert.deepEqual(reports, [{
  entries: [],
  executedModules: ['home/user/node_modules/late/index.js'],
  dataReads: ['home/user/present.txt'],
}], 'settled first; executed modules and data reads reported apart');
delete globalThis.__nimbusModuleMisses;
console.log('runtime-code-live-report: ok');
