// W3 functional probe — vm.runInContext throws honest error (not silent or wrong-result)
//
// Workerd's node:vm stub throws ERR_METHOD_NOT_IMPLEMENTED. Our shim
// converts that to a Nimbus-specific honest error so users know it's
// the workerd block, not their code. The contract: calling
// vm.runInContext at request-handler time MUST throw, and the error
// should mention "vm" and either "workerd" or "disallowed" or
// "ERR_VM_DYNAMIC_EVAL_DISALLOWED".
//
// Pre-build: FAIL — require('vm') throws "Cannot find module" before
// the runInContext call ever happens.
// Post-build: PASS — vm loads, runInContext throws honest error.

import { execProbe } from '../_helpers.mjs';

export default function vm_runInContext_honest_error() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('vm-runInContext-honest-error', `
      const vm = require('vm');
      try {
        const ctx = vm.createContext({ x: 41 });
        const r = vm.runInContext('x + 1', ctx);
        console.log('VM_UNEXPECTED_RESULT=' + r);
      } catch (e) {
        console.log('VM_ERROR_CODE=' + (e && e.code));
        console.log('VM_ERROR_MSG_OK=' + !!(e && e.message && /vm|workerd|disallowed|not implemented/i.test(e.message)));
      }
    `);
    if (!r.ok) return assertProbe('vm-runInContext-honest-error', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    // Either ERR_VM_DYNAMIC_EVAL_DISALLOWED (our wrapper) or
    // ERR_METHOD_NOT_IMPLEMENTED (workerd raw — also acceptable).
    const codeOk = /VM_ERROR_CODE=(ERR_VM_DYNAMIC_EVAL_DISALLOWED|ERR_METHOD_NOT_IMPLEMENTED)/.test(so);
    const msgOk = so.includes('VM_ERROR_MSG_OK=true');
    const noUnexpected = !so.includes('VM_UNEXPECTED_RESULT=');
    return assertProbe('vm-runInContext-honest-error', codeOk && msgOk && noUnexpected,
      'expected honest error code + msg, got:\n' + so, r.output);
  });
}
