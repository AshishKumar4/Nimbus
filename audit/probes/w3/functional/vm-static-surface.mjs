// W3 functional probe — vm static surface
// The surface that jsdom checks at static load time MUST be present:
//   typeof vm.constants === 'object'
//   typeof vm.runInContext === 'function'
//   typeof vm.Script === 'function'
//   typeof vm.createContext === 'function'
//
// Pre-build: FAIL — `require('vm')` throws "Cannot find module 'vm'".
// Post-build: PASS — surface forwarded from workerd's node:vm.
import { execProbe } from '../_helpers.mjs';

export default function vm_static_surface() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('vm-static-surface', `
      const vm = require('vm');
      console.log('VM_CONST=' + (typeof vm.constants));
      console.log('VM_RUN=' + (typeof vm.runInContext));
      console.log('VM_SCRIPT=' + (typeof vm.Script));
      console.log('VM_CTX=' + (typeof vm.createContext));
    `);
    if (!r.ok) return assertProbe('vm-static-surface', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const ok = so.includes('VM_CONST=object')
      && so.includes('VM_RUN=function')
      && so.includes('VM_SCRIPT=function')
      && so.includes('VM_CTX=function');
    return assertProbe('vm-static-surface', ok,
      'expected all 4 typeof checks, got:\n' + so, r.output);
  });
}
